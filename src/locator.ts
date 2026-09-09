import type { McpPage } from './page.js';
import { findByRole, findByText, type TextMatchOptions } from './snapshot.js';

export type { TextMatchOptions } from './snapshot.js';
import { LocatorResolutionError } from './errors.js';

export type LocatorDescriptor =
  | ({ kind: 'role'; role: string; name?: string } & TextMatchOptions)
  | ({ kind: 'text'; text: string } & TextMatchOptions);

export type ClickOptions = { doubleClick?: boolean; button?: 'left' | 'right' | 'middle'; modifiers?: string[] };
export type TypeOptions = { submit?: boolean; slowly?: boolean };

function describe(descriptor: LocatorDescriptor): string {
  if (descriptor.kind === 'role') {
    return descriptor.name ? `role=${descriptor.role} name="${descriptor.name}"` : `role=${descriptor.role}`;
  }
  return `text="${descriptor.text}"`;
}

/**
 * A resolvable reference to an element in the page's latest MCP accessibility
 * snapshot. Every action re-resolves against a fresh snapshot, since MCP refs
 * (`e1`, `e2`, ...) go stale the moment the DOM changes.
 */
export class McpLocator {
  constructor(
    readonly page: McpPage,
    private readonly descriptor: LocatorDescriptor,
  ) {}

  describe(): string {
    return describe(this.descriptor);
  }

  /** Resolves the current MCP ref for this locator, or null if it's not present in the latest snapshot. */
  async tryResolveRef(): Promise<string | null> {
    const nodes = await this.page.snapshotNodes({ refresh: true });
    const matches =
      this.descriptor.kind === 'role'
        ? findByRole(nodes, this.descriptor.role, this.descriptor)
        : findByText(nodes, this.descriptor.text, this.descriptor);
    return matches[0]?.ref ?? null;
  }

  private async resolveRef(): Promise<string> {
    const nodes = await this.page.snapshotNodes({ refresh: true });
    const matches =
      this.descriptor.kind === 'role'
        ? findByRole(nodes, this.descriptor.role, this.descriptor)
        : findByText(nodes, this.descriptor.text, this.descriptor);
    if (matches.length === 0) {
      throw new LocatorResolutionError(this.describe(), this.page.lastSnapshotText());
    }
    if (matches.length > 1) {
      throw new LocatorResolutionError(`${this.describe()} (ambiguous: ${matches.length} matches, resolve to a single element)`, this.page.lastSnapshotText());
    }
    return matches[0]!.ref!;
  }

  async click(options?: ClickOptions): Promise<void> {
    const ref = await this.resolveRef();
    await this.page.callTool('click', { element: this.describe(), target: ref, ...options });
  }

  async type(text: string, options?: TypeOptions): Promise<void> {
    const ref = await this.resolveRef();
    await this.page.callTool('type', { element: this.describe(), target: ref, text, ...options });
  }

  /** Alias for `type`, matching Playwright's `fill` naming for single-shot text entry. */
  async fill(text: string): Promise<void> {
    await this.type(text);
  }

  /**
   * Best-effort visibility check for the `toBeVisible` matcher. Prefers the
   * server's semantic verify tools when resolved; falls back to "does this
   * element still resolve in the latest snapshot" otherwise.
   */
  async isVisible(): Promise<boolean> {
    if (this.descriptor.kind === 'text' && this.page.hasOp('verifyTextVisible')) {
      return this.page.tryCallTool('verifyTextVisible', { text: this.descriptor.text });
    }
    if (this.descriptor.kind === 'role' && this.page.hasOp('verifyElementVisible')) {
      return this.page.tryCallTool('verifyElementVisible', { role: this.descriptor.role, accessibleName: this.descriptor.name });
    }
    return (await this.tryResolveRef()) !== null;
  }
}
