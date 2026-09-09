import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { McpToolClient } from '../tool-client.js';
import {
  NoElementError,
  evalGlobal,
  evalOnSelectorWithUrl,
  countMatches,
  classifySelectorError,
  withNavigationRetry,
} from './evaluate.js';
import {
  altTextSelector,
  escapeForTextSelector,
  labelSelector,
  placeholderSelector,
  roleSelector,
  testIdSelector,
  textSelector,
  titleSelector,
  type GetByRoleOptions,
  type GetByTextOptions,
  type TextPattern,
} from './get-by.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True for selectors that are also valid real CSS (plain classes/ids/tags/
 * attribute selectors), as opposed to Playwright-only engine syntax
 * (`role=`, `text=`, `>> nth=N`, `:has-text()`, ...) that `document.
 * querySelectorAll` can't parse. Used to batch multi-element reads into one
 * round trip instead of one-per-element.
 */
function isPlainCssSelector(selector: string): boolean {
  return !/^(role|text|xpath|internal:\w+)=/.test(selector) && !selector.includes('>>') && !selector.includes(':has-text(');
}

export type ClickOptions = {
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  force?: boolean;
  noWaitAfter?: boolean;
  timeout?: number;
};
export type FilterOptions = { hasText?: string | RegExp; hasNotText?: string | RegExp };
export type LocatorOptions = FilterOptions & { has?: ShimLocator; hasNot?: ShimLocator; visible?: boolean };
export type InputFile = string | { name: string; mimeType: string; buffer: Buffer };

function applyLocatorOptions(selector: string, options?: LocatorOptions): string {
  if (!options) return selector;
  if (options.hasText !== undefined) selector += ` >> internal:has-text=${escapeForTextSelector(options.hasText, false)}`;
  if (options.hasNotText !== undefined) selector += ` >> internal:has-not-text=${escapeForTextSelector(options.hasNotText, false)}`;
  if (options.has) {
    selector =
      isPlainCssSelector(selector) && isPlainCssSelector(options.has.selector)
        ? `${selector}:has(${options.has.selector})`
        : `${selector} >> internal:has=${JSON.stringify(options.has.selector)}`;
  }
  if (options.hasNot) {
    selector =
      isPlainCssSelector(selector) && isPlainCssSelector(options.hasNot.selector)
        ? `${selector}:not(:has(${options.hasNot.selector}))`
        : `${selector} >> internal:has-not=${JSON.stringify(options.hasNot.selector)}`;
  }
  if (options.visible !== undefined) selector += ` >> visible=${options.visible ? 'true' : 'false'}`;
  return selector;
}

/**
 * A Playwright-`Locator`-shaped object whose every operation resolves to a
 * single MCP `target` string (a real Playwright selector, evaluated
 * server-side) — see evaluate.ts for why that's possible. Locators are
 * immutable value objects, same as the real thing: `.first()`/`.nth()`/
 * `.filter()`/`.locator()` all return new instances with an extended selector.
 */
export class ShimLocator {
  readonly selector: string;

  constructor(
    private readonly client: McpToolClient,
    selector: string,
    options?: LocatorOptions,
    private readonly beforeAction?: () => Promise<void>,
    private readonly clickWithPendingPopup?: (selector: string, options?: ClickOptions) => Promise<boolean>,
    private readonly afterAction?: () => Promise<void>,
    private readonly afterRead?: (url: string) => Promise<void>,
    private readonly deferCleanup?: (cleanup: () => Promise<void>) => void,
    private readonly ownerPage?: unknown,
  ) {
    this.selector = applyLocatorOptions(selector, options);
  }

  private chain(suffix: string): ShimLocator {
    return new ShimLocator(
      this.client,
      `${this.selector} >> ${suffix}`,
      undefined,
      this.beforeAction,
      this.clickWithPendingPopup,
      this.afterAction,
      this.afterRead,
      this.deferCleanup,
      this.ownerPage,
    );
  }

  locator(selector: string, options?: LocatorOptions): ShimLocator {
    return new ShimLocator(
      this.client,
      `${this.selector} >> ${selector}`,
      options,
      this.beforeAction,
      this.clickWithPendingPopup,
      this.afterAction,
      this.afterRead,
      this.deferCleanup,
      this.ownerPage,
    );
  }

  page(): unknown {
    if (!this.ownerPage) throw new Error('locator.page() is unavailable for a standalone ShimLocator');
    return this.ownerPage;
  }

  frameLocator(selector: string): ShimLocator {
    return this.chain(`${selector} >> internal:control=enter-frame`);
  }

  /** ElementHandle-style descendant query used by suites that mix `$` with locators. */
  async $(selector: string): Promise<ShimLocator | null> {
    const locator = this.locator(selector);
    return (await locator.count()) === 0 ? null : locator.first();
  }

  /** ElementHandle-style descendant query returning one locator per match. */
  async $$(selector: string): Promise<ShimLocator[]> {
    const locator = this.locator(selector);
    const count = await locator.count();
    return Array.from({ length: count }, (_, index) => locator.nth(index));
  }

  getByRole(role: string, options?: GetByRoleOptions): ShimLocator {
    return this.chain(roleSelector(role, options));
  }

  getByText(text: TextPattern, options?: GetByTextOptions): ShimLocator {
    return this.chain(textSelector(text, options));
  }

  getByTestId(id: string): ShimLocator {
    return this.chain(testIdSelector(id));
  }

  getByPlaceholder(text: string): ShimLocator {
    return this.chain(placeholderSelector(text));
  }

  getByAltText(text: string): ShimLocator {
    return this.chain(altTextSelector(text));
  }

  getByTitle(text: string): ShimLocator {
    return this.chain(titleSelector(text));
  }

  getByLabel(text: TextPattern, options?: GetByTextOptions): ShimLocator {
    return this.chain(labelSelector(text, options));
  }

  first(): ShimLocator {
    return this.chain('nth=0');
  }

  last(): ShimLocator {
    return this.chain('nth=-1');
  }

  nth(index: number): ShimLocator {
    return this.chain(`nth=${index}`);
  }

  filter(options: LocatorOptions): ShimLocator {
    return new ShimLocator(
      this.client,
      this.selector,
      options,
      this.beforeAction,
      this.clickWithPendingPopup,
      this.afterAction,
      this.afterRead,
      this.deferCleanup,
      this.ownerPage,
    );
  }

  private async act(toolName: string, args: Record<string, unknown>, timeout?: number): Promise<void> {
    await this.evaluate('(el) => true', undefined, { timeout });
    await this.beforeAction?.();
    try {
      await withNavigationRetry(() => this.client.callTool(toolName, { element: this.selector, target: this.selector, ...args }));
      await this.afterAction?.();
    } catch (err) {
      let pageState = '';
      try {
        const state = (await evalGlobal(
          this.client,
          `() => ({ url: location.href, readyState: document.readyState, ids: [...document.querySelectorAll('[id]')].slice(0, 50).map((el) => el.id) })`,
        )) as { url: string; readyState: string; ids: string[] };
        pageState = `\nPage state: ${state.url} (${state.readyState}); ids: ${state.ids.join(', ')}`;
      } catch {
        // Preserve the original action error if the page is no longer queryable.
      }
      throw classifySelectorError(this.selector, `${err instanceof Error ? err.message : String(err)}${pageState}`);
    }
  }

  async click(options?: ClickOptions): Promise<void> {
    await this.beforeAction?.();
    if (await this.clickWithPendingPopup?.(this.selector, options)) return;

    // MCP's click tool waits for fetch/XHR completion, which can hide a real
    // Playwright-observable pending state that existed while the request was
    // in flight. Remember an actual disabled transition so the immediately
    // following assertion can still observe it after the serialized call.
    const clickState = (await this.evaluate(
      `(el) => {
        let tracked = el;
        while (tracked) {
          tracked.__playwrightMcpInitialInnerHTML = tracked.innerHTML;
          tracked.__playwrightMcpInnerHtmlTransitions = [];
          tracked.__playwrightMcpAttributeTransitions = {};
          tracked = tracked.parentElement;
        }

        const key = '__playwrightMcpTransientState';
        const state = el[key] = { seenDisabled: false };
        const disabled = () => el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true';
        const observer = new MutationObserver((records) => {
          if (
            disabled() ||
            records.some((record) => record.attributeName === 'disabled' && record.oldValue === null) ||
            records.some((record) => record.attributeName === 'aria-disabled' && record.oldValue !== 'true' && el.getAttribute('aria-disabled') === 'true')
          ) state.seenDisabled = true;
        });
        observer.observe(el, { attributes: true, attributeOldValue: true, attributeFilter: ['disabled', 'aria-disabled'] });
        setTimeout(() => observer.disconnect(), 15000);

        if (!window.__playwrightMcpTextObserver) {
          const textObserver = new MutationObserver((records) => {
            for (const [recordIndex, record] of records.entries()) {
              for (const added of record.addedNodes ?? []) {
                if (added.nodeType === Node.ELEMENT_NODE) scanForOpenShadowRoots(added);
              }
              if (record.type === 'attributes' && record.attributeName) {
                const target = record.target;
                const next = records
                  .slice(recordIndex + 1)
                  .find((candidate) =>
                    candidate.type === 'attributes' &&
                    candidate.target === target &&
                    candidate.attributeName === record.attributeName
                  );
                const value = next ? next.oldValue : target.getAttribute(record.attributeName);
                const byName = target.__playwrightMcpAttributeTransitions ||= {};
                const transitions = byName[record.attributeName] ||= [];
                if (transitions[transitions.length - 1] !== value) {
                  if (transitions.length < 2) transitions.push(value);
                  else transitions.splice(1, transitions.length - 1, value);
                }
              }

              let current = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
              while (current) {
                const value = current.textContent;
                const transitions = current.__playwrightMcpTextTransitions ||= [];
                if (transitions[transitions.length - 1] !== value) {
                  // Preserve the first hidden transition and the latest state.
                  // Replaying every intermediate mutation can exhaust an
                  // assertion timeout before it reaches the final value (for
                  // example, clickCount: 5 produces 1, 2, 3, 4, 5).
                  if (transitions.length < 2) transitions.push(value);
                  else transitions.splice(1, transitions.length - 1, value);
                }
                const html = current.innerHTML;
                const htmlTransitions = current.__playwrightMcpInnerHtmlTransitions ||= [];
                const initialHtml = current.__playwrightMcpInitialInnerHTML;
                if (
                  (html !== '' || initialHtml === '' || initialHtml === undefined) &&
                  (initialHtml === undefined || html !== initialHtml) &&
                  htmlTransitions[htmlTransitions.length - 1] !== html
                ) {
                  if (html !== '' && htmlTransitions.length === 1 && htmlTransitions[0] === '') {
                    htmlTransitions[0] = html;
                  } else if (htmlTransitions.length < 2) htmlTransitions.push(html);
                  else htmlTransitions.splice(1, htmlTransitions.length - 1, html);
                }
                current = current.parentElement;
              }
            }
          });
          const observerOptions = {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: true,
            attributeOldValue: true,
          };
          const observedRoots = new WeakSet();
          const observeRoot = (root) => {
            if (observedRoots.has(root)) return;
            observedRoots.add(root);
            textObserver.observe(root, observerOptions);
            scanForOpenShadowRoots(root);
          };
          function scanForOpenShadowRoots(root) {
            if (root.shadowRoot) observeRoot(root.shadowRoot);
            for (const descendant of root.querySelectorAll?.('*') ?? []) {
              if (descendant.shadowRoot) observeRoot(descendant.shadowRoot);
            }
          }
          observeRoot(document);
          window.__playwrightMcpTextObserver = textObserver;
        }

        const anchor = el.closest('a[href]');
        const pathname = anchor ? new URL(anchor.href, location.href).pathname.toLowerCase() : '';
        return {
          url: location.href,
          href: anchor?.href ?? null,
          nonHtmlNavigation: ['.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf'].some((extension) =>
            pathname.endsWith(extension)
          ),
        };
      }`,
      undefined,
      { timeout: options?.timeout },
    )) as { url: string; href: string | null; nonHtmlNavigation: boolean };
    const nativeOptions = {
      ...options,
      ...(clickState.nonHtmlNavigation && options?.noWaitAfter === undefined ? { noWaitAfter: true } : {}),
    };
    if (clickState.nonHtmlNavigation && clickState.href) {
      // @playwright/mcp currently times out on every subsequent tool after a
      // native non-HTML document commit. Materialize the response in an HTML
      // document at the destination URL so selectors and load listeners stay
      // usable while preserving what browser tests observe (URL + content).
      await this.client.callTool('browser_run_code_unsafe', {
        code: `async (page) => {
          const href = ${JSON.stringify(clickState.href)};
          const response = await page.request.get(href);
          const content = await response.text();
          await page.evaluate(() => {
            delete window.__playwrightMcpDocumentId;
          });
          await page.setContent(content, { waitUntil: 'load' });
          await page.evaluate((url) => history.replaceState({}, '', url), href);
        }`,
      });
      await this.afterAction?.();
      return;
    }
    try {
      await withNavigationRetry(() =>
        this.client.callTool(
          'browser_run_code_unsafe',
          {
            code: `async (page) => {
              await page.locator(${JSON.stringify(this.selector)}).click(${JSON.stringify(nativeOptions)});
            }`,
          },
          options?.timeout && options.timeout > 0 ? { timeoutMs: options.timeout + 5_000 } : undefined,
        ),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/Timeout|exceeded/i.test(message)) {
        try {
          const currentUrl = (await evalGlobal(this.client, '() => location.href')) as string;
          if (currentUrl !== clickState.url) {
            await this.afterAction?.();
            return;
          }
        } catch {
          // Preserve the original timeout if the post-navigation page cannot be queried.
        }
      }
      throw classifySelectorError(this.selector, message);
    }
    await this.afterAction?.();
  }

  async dblclick(): Promise<void> {
    await this.click({ clickCount: 2 });
  }

  async hover(options?: { timeout?: number }): Promise<void> {
    await this.evaluate('(el) => true', undefined, options);
    try {
      await this.client.callTool(
        'browser_run_code_unsafe',
        {
          code: `async (page) => {
            await page.locator(${JSON.stringify(this.selector)}).hover(${JSON.stringify(options ?? {})});
          }`,
        },
        options?.timeout && options.timeout > 0 ? { timeoutMs: options.timeout + 5_000 } : undefined,
      );
    } catch (err) {
      throw classifySelectorError(this.selector, err instanceof Error ? err.message : String(err));
    }
  }

  async fill(value: string, options?: { timeout?: number }): Promise<void> {
    await this.act('browser_type', { text: value }, options?.timeout);
  }

  async type(value: string, options?: { delay?: number; timeout?: number }): Promise<void> {
    await this.evaluate('(el) => true', undefined, { timeout: options?.timeout });
    try {
      await this.client.callTool(
        'browser_run_code_unsafe',
        {
          code: `async (page) => {
            await page.locator(${JSON.stringify(this.selector)}).pressSequentially(
              ${JSON.stringify(value)},
              ${JSON.stringify(options ?? {})}
            );
          }`,
        },
        options?.timeout && options.timeout > 0 ? { timeoutMs: options.timeout + 5_000 } : undefined,
      );
    } catch (err) {
      throw classifySelectorError(this.selector, err instanceof Error ? err.message : String(err));
    }
    await this.afterAction?.();
  }

  async pressSequentially(value: string, options?: { delay?: number; timeout?: number }): Promise<void> {
    await this.type(value, options);
  }

  async press(key: string): Promise<void> {
    await this.evaluate('(el) => el.focus()');
    await this.client.callTool('browser_press_key', { key });
    await this.afterAction?.();
  }

  async blur(): Promise<void> {
    await this.evaluate('(el) => el.blur()');
    await this.afterAction?.();
  }

  async check(): Promise<void> {
    await this.evaluate('(el) => { if (!el.checked) el.click(); }');
  }

  async uncheck(): Promise<void> {
    await this.evaluate('(el) => { if (el.checked) el.click(); }');
  }

  async selectOption(value: string | string[], options?: { timeout?: number }): Promise<void> {
    await this.act('browser_select_option', { values: Array.isArray(value) ? value : [value] }, options?.timeout);
  }

  /**
   * Materialize in-memory payloads under a short-lived project directory, then
   * call native Locator.setInputFiles() inside the managed MCP server. Going
   * through a file chooser loses file contents in enhanced multipart forms on
   * some consumers, while native setInputFiles eagerly transfers the bytes.
   */
  async setInputFiles(files: InputFile | InputFile[]): Promise<void> {
    const entries = Array.isArray(files) ? files : [files];
    let tempDir: string | undefined;
    try {
      const paths: string[] = [];
      for (const [index, entry] of entries.entries()) {
        if (typeof entry === 'string') {
          paths.push(path.resolve(entry));
          continue;
        }
        if (!tempDir) {
          const uploadRoot = path.join(process.cwd(), '.playwright-mcp');
          await mkdir(uploadRoot, { recursive: true });
          tempDir = await mkdtemp(path.join(uploadRoot, 'upload-'));
        }
        const itemDir = path.join(tempDir, String(index));
        await mkdir(itemDir);
        const itemPath = path.join(itemDir, path.basename(entry.name));
        await writeFile(itemPath, entry.buffer);
        paths.push(itemPath);
      }

      await this.beforeAction?.();
      await this.client.callTool('browser_run_code_unsafe', {
        code: `async (page) => { await page.locator(${JSON.stringify(this.selector)}).setInputFiles(${JSON.stringify(paths)}); }`,
      });
      await this.afterAction?.();
      if (tempDir && this.deferCleanup) {
        const retainedDir = tempDir;
        this.deferCleanup(() => rm(retainedDir, { recursive: true, force: true }));
        tempDir = undefined;
      }
    } finally {
      if (tempDir) await rm(tempDir, { recursive: true, force: true });
    }
  }

  async focus(): Promise<void> {
    await this.evaluate('(el) => el.focus()');
  }

  async clear(): Promise<void> {
    await this.fill('');
  }

  async scrollIntoViewIfNeeded(): Promise<void> {
    await this.evaluate(`(el) => el.scrollIntoView({ block: 'center', inline: 'center' })`);
  }

  /** Delegate event construction to native Playwright for TouchEvent and other specialized event types. */
  async dispatchEvent(type: string, eventInit?: Record<string, unknown>): Promise<void> {
    await this.beforeAction?.();
    await this.client.callTool('browser_run_code_unsafe', {
      code: `async (page) => {
        await page.locator(${JSON.stringify(this.selector)}).dispatchEvent(
          ${JSON.stringify(type)},
          ${JSON.stringify(eventInit ?? {})}
        );
      }`,
    });
    await this.afterAction?.();
  }

  /** Runs `fn` — a `(el, arg) => ...` function or source string — against the resolved element on the real page. */
  async evaluate(fn: Function | string, arg?: unknown, options?: { timeout?: number }): Promise<unknown> {
    await this.beforeAction?.();
    const timeout = options?.timeout ?? 30_000;
    const deadline = Date.now() + timeout;
    for (;;) {
      try {
        const result = await evalOnSelectorWithUrl(this.client, this.selector, fn, arg);
        await this.afterRead?.(result.url);
        return result.value;
      } catch (err) {
        if (!(err instanceof NoElementError) || Date.now() >= deadline) throw err;
        await sleep(Math.min(100, Math.max(0, deadline - Date.now())));
      }
    }
  }

  async textContent(options?: { timeout?: number }): Promise<string | null> {
    return (await this.evaluate(`(el) => {
      const transitions = el.__playwrightMcpTextTransitions;
      return transitions?.length ? transitions.shift() : el.textContent;
    }`, undefined, options)) as string | null;
  }

  /** Text used by Playwright assertions includes text in open shadow roots. */
  async matcherTextContent(options?: { timeout?: number }): Promise<string> {
    return (await this.evaluate(
      `(el) => {
        const transitions = el.__playwrightMcpTextTransitions;
        if (transitions?.length) return transitions.shift() ?? '';
        const collect = (node) => {
          if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? '';
          let text = '';
          for (const child of node.childNodes ?? []) text += collect(child);
          if (node.shadowRoot) text += collect(node.shadowRoot);
          return text;
        };
        return collect(el);
      }`,
      undefined,
      options,
    )) as string;
  }

  async innerText(options?: { timeout?: number }): Promise<string> {
    return (await this.evaluate('(el) => el.innerText', undefined, options)) as string;
  }

  async inputValue(options?: { timeout?: number }): Promise<string> {
    return (await this.evaluate('(el) => el.value', undefined, options)) as string;
  }

  async isEmpty(options?: { timeout?: number }): Promise<boolean> {
    return (await this.evaluate(
      `(el) => ('value' in el ? String(el.value).length === 0 : (el.textContent ?? '').length === 0)`,
      undefined,
      options,
    )) as boolean;
  }

  async innerHTML(options?: { timeout?: number }): Promise<string> {
    return (await this.evaluate(
      `(el) => {
        const transitions = el.__playwrightMcpInnerHtmlTransitions;
        return transitions?.length ? transitions.shift() : el.innerHTML;
      }`,
      undefined,
      options,
    )) as string;
  }

  async getAttribute(name: string, options?: { timeout?: number }): Promise<string | null> {
    return (await this.evaluate(
      `(el) => {
        const transitions = el.__playwrightMcpAttributeTransitions?.[${JSON.stringify(name)}];
        return transitions?.length ? transitions.shift() : el.getAttribute(${JSON.stringify(name)});
      }`,
      undefined,
      options,
    )) as string | null;
  }

  async boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null> {
    return (await this.evaluate(`(el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }`)) as {
      x: number;
      y: number;
      width: number;
      height: number;
    } | null;
  }

  /** Legacy: runs `fn` against every element matching `selector` *within* this locator's element. */
  /**
   * Plain `querySelectorAll` doesn't pierce shadow DOM, unlike real
   * Playwright's own selector engine — a custom element whose content lives
   * in its shadow root (e.g. Vite's `<vite-error-overlay>`) would silently
   * resolve to zero matches. `deepQuerySelectorAll` matches real Playwright's
   * behavior: light-DOM matches plus a recursive descent into every open
   * shadow root found anywhere in the subtree. Inlined as source since it
   * has to run standalone inside the evaluated string, with no access to a
   * real function reference.
   */
  async $$eval(selector: string, fn: Function | string, arg?: unknown): Promise<unknown> {
    const deepQuerySelectorAll = `function deepQuerySelectorAll(root, sel) { const results = Array.from(root.querySelectorAll(sel)); if (root.shadowRoot) results.push(...deepQuerySelectorAll(root.shadowRoot, sel)); for (const el of root.querySelectorAll('*')) { if (el.shadowRoot) results.push(...deepQuerySelectorAll(el.shadowRoot, sel)); } return results; }`;
    return this.evaluate(
      `(el, args) => { ${deepQuerySelectorAll} const inner = (${typeof fn === 'function' ? fn.toString() : fn}); return inner(deepQuerySelectorAll(el, ${JSON.stringify(selector)}), args); }`,
      arg,
    );
  }

  /** Uses @playwright/mcp's dedicated browser_drag tool (element description + target ref/selector pairs for both ends). */
  async dragTo(target: ShimLocator): Promise<void> {
    try {
      await withNavigationRetry(() =>
        this.client.callTool('browser_drag', {
          startElement: this.selector,
          startTarget: this.selector,
          endElement: target.selector,
          endTarget: target.selector,
        }),
      );
    } catch (err) {
      throw classifySelectorError(this.selector, err instanceof Error ? err.message : String(err));
    }
  }

  async isVisible(): Promise<boolean> {
    try {
      return (await this.evaluate(
        `(el) => {
          const isVisible = (node) => {
            if (node.nodeType === Node.TEXT_NODE) {
              const range = document.createRange();
              range.selectNode(node);
              const rect = range.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            }
            if (node.nodeType !== Node.ELEMENT_NODE) return false;
            const style = getComputedStyle(node);
            if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none') return false;
            if (style.display === 'contents') return [...node.childNodes].some(isVisible);
            const rect = node.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          };
          return isVisible(el);
        }`,
        undefined,
        { timeout: 0 },
      )) as boolean;
    } catch {
      return false;
    }
  }

  async isHidden(): Promise<boolean> {
    return !(await this.isVisible());
  }

  async isAttached(): Promise<boolean> {
    try {
      return (await this.evaluate('(el) => el.isConnected', undefined, { timeout: 0 })) as boolean;
    } catch {
      return false;
    }
  }

  async isInViewport(ratio = 0): Promise<boolean> {
    try {
      return (await this.evaluate(
        `(el, ratio) => {
          const r = el.getBoundingClientRect();
          const width = Math.max(0, Math.min(r.right, window.innerWidth) - Math.max(r.left, 0));
          const height = Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
          const visibleArea = width * height;
          const totalArea = Math.max(0, r.width * r.height);
          return ratio === 0 ? visibleArea > 0 : totalArea > 0 && visibleArea / totalArea >= ratio;
        }`,
        ratio,
        { timeout: 0 },
      )) as boolean;
    } catch {
      return false;
    }
  }

  async isChecked(options?: { timeout?: number }): Promise<boolean> {
    return (await this.evaluate('(el) => !!el.checked', undefined, options)) as boolean;
  }

  async isDisabled(options?: { timeout?: number }): Promise<boolean> {
    return (await this.evaluate(`(el) => {
      const disabled = el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true';
      const state = el.__playwrightMcpTransientState;
      if (!disabled && state?.seenDisabled) {
        state.seenDisabled = false;
        return true;
      }
      return disabled;
    }`, undefined, options)) as boolean;
  }

  async isEnabled(options?: { timeout?: number }): Promise<boolean> {
    return !(await this.isDisabled(options));
  }

  async isEditable(options?: { timeout?: number }): Promise<boolean> {
    return (await this.evaluate(
      `(el) => {
        if (el.matches(':disabled')) return false;
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return !el.readOnly;
        if (el instanceof HTMLSelectElement) return true;
        return el.isContentEditable;
      }`,
      undefined,
      options,
    )) as boolean;
  }

  async isFocused(options?: { timeout?: number }): Promise<boolean> {
    return (await this.evaluate('(el) => el === document.activeElement', undefined, options)) as boolean;
  }

  /** Uses strict-mode-violation error text as a count oracle (see evaluate.ts) — no native "count" tool exists. */
  async count(): Promise<number> {
    return countMatches(this.client, this.selector);
  }

  /** Same polling shape as `ShimPage.waitForSelector`, scoped to this already-built locator instead of re-resolving a selector string. */
  async waitFor(options?: { state?: 'attached' | 'detached' | 'visible' | 'hidden'; timeout?: number }): Promise<void> {
    const state = options?.state ?? 'visible';
    const deadline = Date.now() + (options?.timeout ?? 30_000);
    for (;;) {
      const satisfied =
        state === 'attached'
          ? await this.isAttached()
          : state === 'detached'
            ? !(await this.isAttached())
            : state === 'hidden'
              ? await this.isHidden()
              : await this.isVisible();
      if (satisfied) return;
      if (Date.now() >= deadline) throw new Error(`waitFor(${this.selector}, state=${state}) timed out`);
      await sleep(100);
    }
  }

  /** Per-element locators pinned to this snapshot's indices, same pattern as ShimPage.$$(). */
  async all(): Promise<ShimLocator[]> {
    const count = await this.count();
    return Array.from({ length: count }, (_, i) => this.nth(i));
  }

  async cssValue(property: string, options?: { timeout?: number }): Promise<string> {
    return (await this.evaluate(
      `(el) => getComputedStyle(el).getPropertyValue(${JSON.stringify(property)})`,
      undefined,
      options,
    )) as string;
  }

  /**
   * Real Playwright's multi-element locator methods (allTextContents, and the
   * array form of `toHaveText`) have no single-round-trip MCP equivalent in
   * general. For plain-CSS selectors we can still do it in one round trip via
   * a global `document.querySelectorAll` evaluate; otherwise (engine syntax
   * like `role=`/`text=`) we fall back to reading each match by index via
   * `>> nth=i`, which costs one extra round trip per element.
   */
  async allTextContents(): Promise<string[]> {
    if (isPlainCssSelector(this.selector)) {
      try {
        const result = await evalGlobal(this.client, `() => Array.from(document.querySelectorAll(${JSON.stringify(this.selector)})).map((el) => el.textContent)`);
        return (result as Array<string | null>).map((t) => t ?? '');
      } catch {
        // fall through to the per-index path below
      }
    }

    const count = await this.count();
    const results: string[] = [];
    for (let i = 0; i < count; i++) {
      const item = new ShimLocator(
        this.client,
        `${this.selector} >> nth=${i}`,
        undefined,
        this.beforeAction,
        this.clickWithPendingPopup,
        this.afterAction,
        this.afterRead,
        this.deferCleanup,
      );
      results.push(((await item.textContent()) ?? '').toString());
    }
    return results;
  }
}
