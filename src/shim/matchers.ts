import type { ShimLocator } from './locator.js';
import type { ShimPage } from './page.js';

const DEFAULT_TIMEOUT_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type MatcherResult = { pass: boolean; message: () => string };
type StringMatch = string | RegExp;
export type URLMatch = StringMatch | ((url: URL) => boolean);

function textSatisfies(actual: string, expected: StringMatch): boolean {
  return expected instanceof RegExp ? expected.test(actual) : actual === expected;
}

function containsSatisfies(actual: string, expected: StringMatch): boolean {
  return expected instanceof RegExp ? expected.test(actual) : actual.includes(expected);
}

/** Real Playwright's toHaveText/toContainText normalize whitespace (trim + collapse runs) before comparing — rendered HTML text routinely carries incidental leading/trailing/internal whitespace that isn't meaningful. toHaveValue/toHaveAttribute/toHaveClass do NOT get this treatment (those compare raw attribute/property strings, where whitespace can be significant). */
function normalizeWhitespace(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

function textSatisfiesNormalized(actual: string, expected: StringMatch): boolean {
  return expected instanceof RegExp ? expected.test(normalizeWhitespace(actual)) : normalizeWhitespace(actual) === normalizeWhitespace(expected);
}

function containsSatisfiesNormalized(actual: string, expected: StringMatch): boolean {
  return expected instanceof RegExp ? expected.test(normalizeWhitespace(actual)) : normalizeWhitespace(actual).includes(normalizeWhitespace(expected));
}

function arraysSatisfy(actual: string[], expected: StringMatch[], mode: 'exact' | 'contains'): boolean {
  if (actual.length !== expected.length) return false;
  const check = mode === 'exact' ? textSatisfiesNormalized : containsSatisfiesNormalized;
  return actual.every((a, i) => check(a, expected[i]!));
}

/**
 * Shared polling core for every matcher below. `satisfies` computes the raw,
 * non-negated truth ("does the actual value meet the expectation"); we poll
 * toward `!isNot` purely as a wait-efficiency target, but the returned `pass`
 * is always the raw fact — Playwright's own expect() applies the isNot XOR on
 * top of this (see the core library's matchers.ts for the bug this avoids).
 */
async function pollingMatcher<T>(
  getActual: () => Promise<T>,
  satisfies: (actual: T) => boolean,
  isNot: boolean,
  timeoutMs: number,
  describe: (actual: T | undefined, lastError: string | undefined) => string,
): Promise<MatcherResult> {
  const target = !isNot;
  const deadline = Date.now() + timeoutMs;
  let actual: T | undefined;
  let lastError: string | undefined;
  let raw = false;
  for (;;) {
    try {
      actual = await getActual();
      raw = satisfies(actual);
      if (raw === target) break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() >= deadline) break;
    await sleep(100);
  }
  return { pass: raw, message: () => describe(actual, lastError) };
}

/**
 * These three take `expected` and `isNot` as two SEPARATE parameters (unlike
 * the simpler matchers below, which only ever had one boolean to work with).
 * That's required because real Playwright lets these be inverted two
 * independent ways — `.not.toBeVisible()` *and* `.toBeVisible({visible:
 * false})` — and only one of those is `this.isNot`. Conflating "the target
 * state" with "the negation flag" (i.e. deriving `expected` from `isNot`, or
 * vice versa) is subtly wrong the moment the two disagree: it was a real bug
 * here until the `{visible}`/`{checked}`/`{enabled}` options surfaced it.
 * `satisfies` must do the actual `actual === expected` comparison so
 * `pollingMatcher`'s `pass !== isNot` XOR (see its docstring) computes the
 * right answer regardless of which inversion mechanism was used.
 */
export async function toBeVisible(locator: ShimLocator, expectedVisible: boolean, isNot: boolean, options?: { timeout?: number }): Promise<MatcherResult> {
  return pollingMatcher(
    () => locator.isVisible(),
    (actual) => actual === expectedVisible,
    isNot,
    options?.timeout ?? DEFAULT_TIMEOUT_MS,
    (actual) => `expected locator (${locator.selector}) visibility=${expectedVisible}, observed=${actual}`,
  );
}

export async function toBeAttached(locator: ShimLocator, expectedAttached: boolean, isNot: boolean, options?: { timeout?: number }): Promise<MatcherResult> {
  return pollingMatcher(
    () => locator.isAttached(),
    (actual) => actual === expectedAttached,
    isNot,
    options?.timeout ?? DEFAULT_TIMEOUT_MS,
    (actual) => `expected locator (${locator.selector}) attached=${expectedAttached}, observed=${actual}`,
  );
}

export async function toBeInViewport(locator: ShimLocator, isNot: boolean, options?: { ratio?: number; timeout?: number }): Promise<MatcherResult> {
  const ratio = options?.ratio ?? 0;
  return pollingMatcher(
    () => locator.isInViewport(ratio),
    (actual) => actual,
    isNot,
    options?.timeout ?? DEFAULT_TIMEOUT_MS,
    (actual) => `expected locator (${locator.selector}) to ${isNot ? 'not ' : ''}be in viewport with ratio=${ratio}, observed inViewport=${actual}`,
  );
}

export async function toBeFocused(locator: ShimLocator, isNot: boolean, options?: { timeout?: number }): Promise<MatcherResult> {
  return pollingMatcher(
    () => locator.isFocused({ timeout: 0 }),
    (actual) => actual === true,
    isNot,
    options?.timeout ?? DEFAULT_TIMEOUT_MS,
    (actual) => `expected locator (${locator.selector}) to be focused, observed focused=${actual}`,
  );
}

export async function toBeEmpty(locator: ShimLocator, isNot: boolean, options?: { timeout?: number }): Promise<MatcherResult> {
  return pollingMatcher(
    () => locator.isEmpty({ timeout: 0 }),
    (actual) => actual,
    isNot,
    options?.timeout ?? DEFAULT_TIMEOUT_MS,
    (actual) => `expected locator (${locator.selector}) to ${isNot ? 'not ' : ''}be empty, observed empty=${actual}`,
  );
}

export async function toBeChecked(locator: ShimLocator, expectedChecked: boolean, isNot: boolean, options?: { timeout?: number }): Promise<MatcherResult> {
  return pollingMatcher(
    () => locator.isChecked({ timeout: 0 }),
    (actual) => actual === expectedChecked,
    isNot,
    options?.timeout ?? DEFAULT_TIMEOUT_MS,
    (actual) => `expected locator (${locator.selector}) checked=${expectedChecked}, observed=${actual}`,
  );
}

export async function toBeEnabled(locator: ShimLocator, expectedEnabled: boolean, isNot: boolean, options?: { timeout?: number }): Promise<MatcherResult> {
  return pollingMatcher(
    () => locator.isEnabled({ timeout: 0 }),
    (actual) => actual === expectedEnabled,
    isNot,
    options?.timeout ?? DEFAULT_TIMEOUT_MS,
    (actual) => `expected locator (${locator.selector}) enabled=${expectedEnabled}, observed=${actual}`,
  );
}

export async function toBeEditable(locator: ShimLocator, expectedEditable: boolean, isNot: boolean, options?: { timeout?: number }): Promise<MatcherResult> {
  return pollingMatcher(
    () => locator.isEditable({ timeout: 0 }),
    (actual) => actual === expectedEditable,
    isNot,
    options?.timeout ?? DEFAULT_TIMEOUT_MS,
    (actual) => `expected locator (${locator.selector}) editable=${expectedEditable}, observed=${actual}`,
  );
}

export type TextMatcherOptions = { timeout?: number; useInnerText?: boolean };

function readText(locator: ShimLocator, useInnerText: boolean | undefined): Promise<string> {
  return (useInnerText
    ? locator.innerText({ timeout: 0 })
    : locator.matcherTextContent({ timeout: 0 })) as Promise<string>;
}

export async function toHaveText(locator: ShimLocator, expected: StringMatch | StringMatch[], isNot: boolean, options?: TextMatcherOptions): Promise<MatcherResult> {
  if (Array.isArray(expected)) {
    return pollingMatcher(
      () => locator.allTextContents(),
      (actual) => arraysSatisfy(actual, expected, 'exact'),
      isNot,
      options?.timeout ?? DEFAULT_TIMEOUT_MS,
      (actual, lastError) => `expected locator (${locator.selector}) texts to ${isNot ? 'not ' : ''}be [${expected.join(', ')}], observed [${(actual ?? []).join(', ')}]${lastError ? `: ${lastError}` : ''}`,
    );
  }
  return pollingMatcher(
    () => readText(locator, options?.useInnerText),
    (actual) => textSatisfiesNormalized(actual, expected),
    isNot,
    options?.timeout ?? DEFAULT_TIMEOUT_MS,
    (actual, lastError) => `expected locator (${locator.selector}) text to ${isNot ? 'not ' : ''}be ${String(expected)}, observed "${actual}"${lastError ? `: ${lastError}` : ''}`,
  );
}

export async function toContainText(locator: ShimLocator, expected: StringMatch | StringMatch[], isNot: boolean, options?: TextMatcherOptions): Promise<MatcherResult> {
  if (Array.isArray(expected)) {
    return pollingMatcher(
      () => locator.allTextContents(),
      (actual) => arraysSatisfy(actual, expected, 'contains'),
      isNot,
      options?.timeout ?? DEFAULT_TIMEOUT_MS,
      (actual, lastError) => `expected locator (${locator.selector}) texts to ${isNot ? 'not ' : ''}contain [${expected.join(', ')}], observed [${(actual ?? []).join(', ')}]${lastError ? `: ${lastError}` : ''}`,
    );
  }
  return pollingMatcher(
    () => readText(locator, options?.useInnerText),
    (actual) => containsSatisfiesNormalized(actual, expected),
    isNot,
    options?.timeout ?? DEFAULT_TIMEOUT_MS,
    (actual, lastError) => `expected locator (${locator.selector}) text to ${isNot ? 'not ' : ''}contain ${String(expected)}, observed "${actual}"${lastError ? `: ${lastError}` : ''}`,
  );
}

export async function toHaveCSS(locator: ShimLocator, property: string, expected: StringMatch, isNot: boolean, options?: { timeout?: number }): Promise<MatcherResult> {
  return pollingMatcher(
    () => locator.cssValue(property, { timeout: 0 }),
    (actual) => textSatisfies(actual, expected),
    isNot,
    options?.timeout ?? DEFAULT_TIMEOUT_MS,
    (actual, lastError) => `expected locator (${locator.selector}) css "${property}" to ${isNot ? 'not ' : ''}be ${String(expected)}, observed "${actual}"${lastError ? `: ${lastError}` : ''}`,
  );
}

export async function toHaveValue(locator: ShimLocator, expected: StringMatch, isNot: boolean, options?: { timeout?: number }): Promise<MatcherResult> {
  return pollingMatcher(
    () => locator.inputValue({ timeout: 0 }),
    (actual) => textSatisfies(actual, expected),
    isNot,
    options?.timeout ?? DEFAULT_TIMEOUT_MS,
    (actual, lastError) => `expected locator (${locator.selector}) value to ${isNot ? 'not ' : ''}be ${String(expected)}, observed "${actual}"${lastError ? `: ${lastError}` : ''}`,
  );
}

export async function toHaveAttribute(locator: ShimLocator, name: string, expected: StringMatch | undefined, isNot: boolean, options?: { timeout?: number }): Promise<MatcherResult> {
  return pollingMatcher(
    () => locator.getAttribute(name, { timeout: 0 }),
    (actual) => actual !== null && (expected === undefined || textSatisfies(actual, expected)),
    isNot,
    options?.timeout ?? DEFAULT_TIMEOUT_MS,
    (actual, lastError) =>
      `expected locator (${locator.selector}) attribute "${name}" to ${isNot ? 'not ' : ''}${
        expected === undefined ? 'be present' : `be ${String(expected)}`
      }, observed ${actual === null ? '<missing>' : `"${actual}"`}${lastError ? `: ${lastError}` : ''}`,
  );
}

export async function toHaveClass(locator: ShimLocator, expected: StringMatch, isNot: boolean, options?: { timeout?: number }): Promise<MatcherResult> {
  return pollingMatcher(
    () => locator.getAttribute('class', { timeout: 0 }).then((v) => v ?? ''),
    (actual) => (expected instanceof RegExp ? expected.test(actual) : actual.split(/\s+/).includes(expected) || actual === expected),
    isNot,
    options?.timeout ?? DEFAULT_TIMEOUT_MS,
    (actual, lastError) => `expected locator (${locator.selector}) class to ${isNot ? 'not ' : ''}include ${String(expected)}, observed "${actual}"${lastError ? `: ${lastError}` : ''}`,
  );
}

export async function toHaveCount(locator: ShimLocator, expected: number, isNot: boolean, options?: { timeout?: number }): Promise<MatcherResult> {
  return pollingMatcher(
    () => locator.count(),
    (actual) => actual === expected,
    isNot,
    options?.timeout ?? DEFAULT_TIMEOUT_MS,
    (actual, lastError) => `expected locator (${locator.selector}) count to ${isNot ? 'not ' : ''}be ${expected}, observed ${actual}${lastError ? `: ${lastError}` : ''}`,
  );
}

export async function toHaveURL(page: ShimPage, expected: URLMatch, isNot: boolean, options?: { timeout?: number }): Promise<MatcherResult> {
  return pollingMatcher(
    () => page.currentUrl(),
    (actual) => (typeof expected === 'function' ? expected(new URL(actual)) : containsSatisfies(actual, expected)),
    isNot,
    options?.timeout ?? DEFAULT_TIMEOUT_MS,
    (actual, lastError) => `expected page URL to ${isNot ? 'not ' : ''}match ${String(expected)}, observed "${actual}"${lastError ? `: ${lastError}` : ''}`,
  );
}

export async function toHaveJSProperty(locator: ShimLocator, name: string, expected: unknown, isNot: boolean, options?: { timeout?: number }): Promise<MatcherResult> {
  return pollingMatcher(
    () => locator.evaluate(`(el) => el[${JSON.stringify(name)}]`),
    (actual) => JSON.stringify(actual) === JSON.stringify(expected),
    isNot,
    options?.timeout ?? DEFAULT_TIMEOUT_MS,
    (actual, lastError) => `expected locator (${locator.selector}) JS property "${name}" to ${isNot ? 'not ' : ''}be ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}${lastError ? `: ${lastError}` : ''}`,
  );
}

export async function toHaveTitle(page: ShimPage, expected: StringMatch, isNot: boolean, options?: { timeout?: number }): Promise<MatcherResult> {
  return pollingMatcher(
    () => page.title(),
    (actual) => textSatisfies(actual, expected),
    isNot,
    options?.timeout ?? DEFAULT_TIMEOUT_MS,
    (actual, lastError) => `expected page title to ${isNot ? 'not ' : ''}be ${String(expected)}, observed "${actual}"${lastError ? `: ${lastError}` : ''}`,
  );
}
