import type { McpToolClient } from '../tool-client.js';
import { textFromResult } from '../tool-client.js';
import { McpTransportError } from '../errors.js';

/**
 * @playwright/mcp forwards a tool's `target` string straight into the real,
 * server-side `page.locator(target)` (confirmed empirically: the tool result
 * echoes `await page.locator('#save-btn').click()`-style "Ran Playwright code").
 * That means `target` accepts the *full* real Playwright selector language —
 * CSS, `text=`, `role=`, `>> nth=N`, `:has-text()`, chaining — not just a
 * snapshot ref. The shim in this directory leans on that entirely instead of
 * accessibility-snapshot parsing, which is what makes a Page/Locator-shaped
 * adapter over MCP tractable.
 */

export class StrictModeViolationError extends McpTransportError {
  constructor(
    readonly selector: string,
    readonly matchCount: number,
  ) {
    super(`locator("${selector}") resolved to ${matchCount} elements — call is ambiguous without .first()/.nth()/.last()`);
  }
}

export class NoElementError extends McpTransportError {
  constructor(
    readonly selector: string,
    detail?: string,
  ) {
    super(`locator("${selector}") did not match any elements${detail ? `\n${detail}` : ''}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TRANSIENT_NAVIGATION_ERROR = /Execution context was destroyed|Target closed|context was destroyed/i;

/**
 * Real Playwright's own locator actions silently retry on this exact
 * transient state — an evaluate/action racing a same-page navigation whose
 * old JS context just got torn down. Without a retry here, that ordinary
 * race reads as a hard failure; by the time we retry, the new page's context
 * is normally already up.
 */
export async function withNavigationRetry<T>(fn: () => Promise<T>, retries = 3, delayMs = 200): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const message = err instanceof Error ? err.message : String(err);
      if (!TRANSIENT_NAVIGATION_ERROR.test(message) || attempt === retries) throw err;
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

export function classifySelectorError(selector: string, message: string): Error {
  const strict = message.match(/resolved to (\d+) elements/);
  if (strict?.[1]) return new StrictModeViolationError(selector, Number(strict[1]));
  if (message.includes('does not match any elements') || /Timeout|exceeded/i.test(message)) {
    return new NoElementError(selector, message);
  }
  return new McpTransportError(message);
}

function parseEvaluateResult(text: string): unknown {
  const marker = '### Result\n';
  const start = text.indexOf(marker);
  if (start === -1) throw new McpTransportError(`browser_evaluate returned no "### Result" section: ${text}`);
  const rest = text.slice(start + marker.length);
  const end = rest.indexOf('\n### ');
  const jsonText = (end === -1 ? rest : rest.slice(0, end)).trim();
  try {
    return JSON.parse(jsonText);
  } catch {
    return jsonText;
  }
}

/**
 * Real Playwright's `page.evaluate(fn, arg)` / `locator.evaluate(fn, arg)`
 * accept an actual function value (Playwright serializes it via `.toString()`
 * internally — closures over outer Node variables are NOT available in the
 * browser, only the source text is sent). We replicate that: accept a
 * function or a raw source string, and always return a value so the
 * "### Result" section is present even for void-returning mutations.
 *
 * The outer wrapper's arity must match what the MCP tool will actually
 * invoke it with: zero args for a global (page-level) call, or one arg (the
 * resolved element) for an `element`/`target`-scoped call — that invocation
 * happens on the *real* Playwright instance inside @playwright/mcp, which
 * auto-calls a function-shaped string with the resolved element (confirmed
 * empirically: `(el) => el.textContent` against a `target` correctly
 * receives the element). `arg` has no channel of its own, so it's baked in
 * as a JSON literal and threaded through to `inner` ourselves.
 */
/**
 * Real Playwright's string form of `evaluate`/`waitForFunction` accepts a raw
 * expression too (`page.waitForFunction('window.invalidated')`), not just a
 * function body — it's evaluated directly, not called. Naively treating every
 * string as `const inner = (${source})` breaks on that form: `inner` ends up
 * bound to whatever the expression evaluates to (e.g. `undefined`/`false`),
 * not a function, so calling it throws "inner is not a function". Detect the
 * function-shaped strings (the common case, still passed through verbatim)
 * and wrap everything else as a thunk instead.
 */
function isFunctionSource(trimmed: string): boolean {
  return /^(async\s+)?function[\s(]/.test(trimmed) || /^(async\s+)?\(?[^{]*\)?\s*=>/.test(trimmed);
}

export function buildEvalSource(fn: Function | string, arg: unknown, scoped: boolean): string {
  const source = typeof fn === 'function' ? fn.toString() : isFunctionSource(fn.trim()) ? fn : `() => (${fn})`;
  const argLiteral = JSON.stringify(arg);
  const call = scoped ? `inner(el, ${argLiteral})` : `inner(${argLiteral})`;
  return `(${scoped ? 'el' : ''}) => { const inner = (${source}); const r = ${call}; return r === undefined ? true : r; }`;
}

function buildEvalWithUrlSource(fn: Function | string, arg: unknown): string {
  const source = typeof fn === 'function' ? fn.toString() : isFunctionSource(fn.trim()) ? fn : `() => (${fn})`;
  const argLiteral = JSON.stringify(arg);
  return `async (el) => { const inner = (${source}); const value = await inner(el, ${argLiteral}); return { value: value === undefined ? true : value, url: location.href }; }`;
}

export async function evalGlobal(client: McpToolClient, fn: Function | string, arg?: unknown, timeoutMs?: number): Promise<unknown> {
  return withNavigationRetry(async () => {
    const result = await client.callTool('browser_evaluate', { function: buildEvalSource(fn, arg, false) }, { timeoutMs });
    return parseEvaluateResult(textFromResult(result));
  });
}

export async function evalOnSelector(client: McpToolClient, selector: string, fn: Function | string, arg?: unknown, timeoutMs?: number): Promise<unknown> {
  try {
    return await withNavigationRetry(async () => {
      const result = await client.callTool('browser_evaluate', { element: selector, target: selector, function: buildEvalSource(fn, arg, true) }, { timeoutMs });
      return parseEvaluateResult(textFromResult(result));
    });
  } catch (err) {
    throw classifySelectorError(selector, err instanceof Error ? err.message : String(err));
  }
}

/** Executes a locator evaluation and captures the page URL in the same browser round trip. */
export async function evalOnSelectorWithUrl(
  client: McpToolClient,
  selector: string,
  fn: Function | string,
  arg?: unknown,
  timeoutMs?: number,
): Promise<{ value: unknown; url: string }> {
  try {
    return await withNavigationRetry(async () => {
      const result = await client.callTool(
        'browser_evaluate',
        { element: selector, target: selector, function: buildEvalWithUrlSource(fn, arg) },
        { timeoutMs },
      );
      return parseEvaluateResult(textFromResult(result)) as { value: unknown; url: string };
    });
  } catch (err) {
    throw classifySelectorError(selector, err instanceof Error ? err.message : String(err));
  }
}

/** Resolves the number of matches for `selector` by (ab)using strict-mode's "resolved to N elements" error text. */
export async function countMatches(client: McpToolClient, selector: string): Promise<number> {
  try {
    await evalOnSelector(client, selector, '(el) => true');
    return 1;
  } catch (err) {
    if (err instanceof StrictModeViolationError) return err.matchCount;
    if (err instanceof NoElementError) return 0;
    throw err;
  }
}
