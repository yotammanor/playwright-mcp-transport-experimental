import type { McpLocator } from './locator.js';

export type ToBeVisibleOptions = { timeout?: number };

type MatcherResult = { pass: boolean; message: () => string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls `locator.isVisible()` until it reaches `expectedVisible` (an early-exit
 * optimization — once reached, waiting longer can't improve the outcome) or
 * the timeout elapses. Returns the last *observed* value verbatim: Playwright's
 * expect() applies its own pass/isNot XOR on top of this, so this must stay the
 * raw fact ("is it visible"), not "did it match what the caller wanted".
 */
async function pollVisible(locator: McpLocator, expectedVisible: boolean, timeoutMs: number, pollingIntervalMs: number): Promise<{ visible: boolean; lastError: string }> {
  const deadline = Date.now() + timeoutMs;
  let visible = false;
  let lastError = '';
  for (;;) {
    try {
      visible = await locator.isVisible();
      if (visible === expectedVisible) return { visible, lastError };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() >= deadline) return { visible, lastError };
    await sleep(pollingIntervalMs);
  }
}

export async function toBeVisible(locator: McpLocator, expectedVisible: boolean, options?: ToBeVisibleOptions): Promise<MatcherResult> {
  const timeoutMs = options?.timeout ?? locator.page.assertionTimeoutMs();
  const pollingIntervalMs = locator.page.pollingIntervalMs();
  const { visible, lastError } = await pollVisible(locator, expectedVisible, timeoutMs, pollingIntervalMs);
  return {
    pass: visible,
    message: () =>
      visible === expectedVisible
        ? `locator (${locator.describe()}) visibility matched expected=${expectedVisible}`
        : `expected locator (${locator.describe()}) visibility to be ${expectedVisible}, but observed ${visible} after ${timeoutMs}ms${lastError ? `: ${lastError}` : ''}`,
  };
}
