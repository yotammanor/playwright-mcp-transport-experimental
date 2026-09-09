import type { McpToolClient } from './tool-client.js';
import { textFromResult } from './tool-client.js';
import type { ToolRegistry } from './registry.js';
import { DEFAULT_MCP_OPTIONS, type McpBrowserToolNames } from './options.js';
import { McpLocator, type LocatorDescriptor, type TextMatchOptions } from './locator.js';
import { parseSnapshot } from './snapshot.js';
import { NoMcpToolClientError } from './errors.js';

export type McpPageOptions = {
  toolTimeoutMs?: number;
  assertionTimeoutMs?: number;
  pollingIntervalMs?: number;
};

/**
 * A minimal, Playwright-`Page`-flavored facade driven entirely through MCP
 * tool calls. Every mutating action re-derives element refs from a fresh
 * `browser_snapshot`, since MCP refs are only valid until the next DOM change.
 */
export class McpPage {
  private lastSnapshot: string | null = null;

  constructor(
    private readonly client: McpToolClient,
    private readonly registry: ToolRegistry,
    private readonly options: McpPageOptions = {},
  ) {}

  hasOp(op: keyof McpBrowserToolNames): boolean {
    return this.registry[op] !== undefined;
  }

  assertionTimeoutMs(): number {
    return this.options.assertionTimeoutMs ?? DEFAULT_MCP_OPTIONS.assertionTimeoutMs;
  }

  pollingIntervalMs(): number {
    return this.options.pollingIntervalMs ?? DEFAULT_MCP_OPTIONS.pollingIntervalMs;
  }

  /** Calls a resolved semantic op by name; throws NoMcpToolClientError if the server never exposed it. */
  async callTool(op: keyof McpBrowserToolNames, args: Record<string, unknown>): Promise<unknown> {
    const toolName = this.registry[op];
    if (!toolName) throw new NoMcpToolClientError();
    const timeoutMs = this.options.toolTimeoutMs;
    return timeoutMs === undefined
      ? this.client.callTool(toolName, args)
      : this.client.callTool(toolName, args, { timeoutMs });
  }

  /** Same as callTool, but resolves to `false` instead of throwing on a tool-level failure (e.g. verify-not-visible). */
  async tryCallTool(op: keyof McpBrowserToolNames, args: Record<string, unknown>): Promise<boolean> {
    try {
      await this.callTool(op, args);
      return true;
    } catch {
      return false;
    }
  }

  async navigate(url: string): Promise<void> {
    await this.callTool('navigate', { url });
    this.lastSnapshot = null;
  }

  /** Fetches (or returns the cached) accessibility snapshot text for the current page. */
  async snapshot(options?: { refresh?: boolean }): Promise<string> {
    if (this.lastSnapshot === null || options?.refresh) {
      const result = await this.callTool('snapshot', {});
      this.lastSnapshot = textFromResult(result);
    }
    return this.lastSnapshot;
  }

  async snapshotNodes(options?: { refresh?: boolean }) {
    return parseSnapshot(await this.snapshot(options));
  }

  lastSnapshotText(): string | null {
    return this.lastSnapshot;
  }

  locator(descriptor: LocatorDescriptor): McpLocator {
    return new McpLocator(this, descriptor);
  }

  getByRole(role: string, options?: { name?: string } & TextMatchOptions): McpLocator {
    return this.locator({ kind: 'role', role, ...options });
  }

  getByText(text: string, options?: TextMatchOptions): McpLocator {
    return this.locator({ kind: 'text', text, ...options });
  }

  /** Returns the raw MCP `browser_take_screenshot` result (screenshots are out of scope for parsing here). */
  async screenshot(options?: Record<string, unknown>): Promise<unknown> {
    return this.callTool('screenshot', options ?? {});
  }
}
