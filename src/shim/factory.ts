import type { test as PWTest, expect as PWExpect, BrowserContext, Page } from '@playwright/test';
import { createMcpToolClient, type McpToolClient } from '../tool-client.js';
import { DEFAULT_MCP_OPTIONS, resolveManagedCommand, type McpTransportOptions } from '../options.js';
import { McpServerStartupError, NoMcpToolClientError } from '../errors.js';
import { ShimPage } from './page.js';
import { ShimLocator } from './locator.js';
import * as matchers from './matchers.js';

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => never): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout();
      } catch (err) {
        reject(err);
      }
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timedOut]);
  } finally {
    clearTimeout(timer!);
  }
}

async function connect(mcpOptions: McpTransportOptions): Promise<McpToolClient> {
  if (mcpOptions.client) return mcpOptions.client;

  const mode = mcpOptions.mode ?? DEFAULT_MCP_OPTIONS.mode;
  if (mode === 'existing') {
    if (!mcpOptions.endpoint) throw new NoMcpToolClientError();
    return createMcpToolClient({
      transport: 'http',
      endpoint: mcpOptions.endpoint,
      defaultToolTimeoutMs: mcpOptions.toolTimeoutMs ?? DEFAULT_MCP_OPTIONS.toolTimeoutMs,
    });
  }

  const { command, args, cleanup } = resolveManagedCommand(mcpOptions);
  const startupTimeoutMs = mcpOptions.startupTimeoutMs ?? DEFAULT_MCP_OPTIONS.startupTimeoutMs;
  const startupController = new AbortController();
  let stderr = '';
  try {
    return await withTimeout(
      createMcpToolClient({
        transport: 'stdio',
        command,
        args,
        env: mcpOptions.env,
        cwd: mcpOptions.cwd,
        onStderr: (chunk) => {
          stderr += chunk;
        },
        signal: startupController.signal,
        defaultToolTimeoutMs: mcpOptions.toolTimeoutMs ?? DEFAULT_MCP_OPTIONS.toolTimeoutMs,
      }),
      startupTimeoutMs,
      () => {
        startupController.abort();
        throw new McpServerStartupError(command, args, `no response within ${startupTimeoutMs}ms`, stderr);
      },
    );
  } catch (err) {
    if (err instanceof McpServerStartupError) throw err;
    throw new McpServerStartupError(command, args, err instanceof Error ? err.message : String(err), stderr);
  } finally {
    cleanup?.();
  }
}

/**
 * Standalone page construction, decoupled from the test/expect wiring below.
 * Exists so a consumer that can't do a static `import { createMcpTest } from
 * '.../factory.js'` (their bundler mishandles it — observed against a
 * yarn/CJS-default repo whose transform choked on our ESM dist) can instead
 * dynamically `import()` *just this* inside their own `page` fixture
 * function, which Playwright always resolves asynchronously anyway. The
 * caller is responsible for closing the returned client-owning page's
 * underlying connection (see the `client` field) once the test's done.
 */
export async function createShimPage(mcpOptions: McpTransportOptions = {}, baseURL?: string): Promise<Page & { close(): Promise<void> }> {
  const client = await connect(mcpOptions);
  const page = new ShimPage(client, baseURL);
  return Object.assign(page, {
    close: async () => {
      page.stopEventPolling();
      try {
        await client.close?.();
      } finally {
        await page.cleanupTemporaryFiles();
      }
    },
  }) as unknown as Page & { close(): Promise<void> };
}

function isShimPage(x: unknown): x is ShimPage {
  return !!x && typeof (x as ShimPage).url === 'function' && typeof (x as ShimPage).goto === 'function';
}

/**
 * The plain matcher-implementation object passed to `expect.extend()` —
 * exposed standalone (same rationale as `createShimPage`) so it can be
 * dynamically imported and applied via `baseExpect.extend(buildShimMatchers())`
 * without needing the rest of this factory. `expect.extend()` mutates real
 * Playwright's shared matcher registry (it's not a fresh copy per call), so
 * applying it lazily — e.g. from inside an async fixture — still takes
 * global effect before any test body's assertions run.
 */
type MatcherThis = { isNot: boolean; timeout?: number };

/**
 * Real Playwright's `MatcherState.timeout` reflects the effective configured
 * default (`expect: { timeout }` in playwright.config, or a project-level
 * override) — every built-in matcher falls back to it when a call site omits
 * an explicit `{ timeout }`. Our matchers must resolve the same way: an
 * explicit per-call `options.timeout` wins, then the runner's configured
 * default via `this.timeout`, and only if BOTH are absent (e.g. a caller
 * invoking `matchers.*` directly, outside a real `expect()` context) does our
 * own library constant apply. Skipping `this.timeout` here previously meant
 * every assertion without an explicit timeout silently used our 5s default
 * instead of a target repo's much larger configured one (observed: cal.com
 * configures 120s; assertions were failing ~5s in instead of legitimately
 * waiting).
 */
function resolveTimeout(explicit: number | undefined, matcherThis: MatcherThis): { timeout?: number } {
  const timeout = explicit ?? matcherThis.timeout;
  return timeout === undefined ? {} : { timeout };
}

export function buildShimMatchers() {
  return {
    // `expected` and `this.isNot` are two INDEPENDENT inversion mechanisms (see
    // matchers.ts's docstring on toBeVisible) — `expected` must default to a
    // fixed `true`/`false`, never derived from `this.isNot`.
    async toBeVisible(this: MatcherThis, received: ShimLocator, options?: { visible?: boolean; timeout?: number }) {
      return matchers.toBeVisible(received, options?.visible ?? true, this.isNot, { ...options, ...resolveTimeout(options?.timeout, this) });
    },
    async toBeHidden(this: MatcherThis, received: ShimLocator, options?: { timeout?: number }) {
      return matchers.toBeVisible(received, false, this.isNot, { ...options, ...resolveTimeout(options?.timeout, this) });
    },
    async toBeChecked(this: MatcherThis, received: ShimLocator, options?: { checked?: boolean; timeout?: number }) {
      return matchers.toBeChecked(received, options?.checked ?? true, this.isNot, { ...options, ...resolveTimeout(options?.timeout, this) });
    },
    async toBeEnabled(this: MatcherThis, received: ShimLocator, options?: { enabled?: boolean; timeout?: number }) {
      return matchers.toBeEnabled(received, options?.enabled ?? true, this.isNot, { ...options, ...resolveTimeout(options?.timeout, this) });
    },
    async toBeDisabled(this: MatcherThis, received: ShimLocator, options?: { timeout?: number }) {
      return matchers.toBeEnabled(received, false, this.isNot, { ...options, ...resolveTimeout(options?.timeout, this) });
    },
    async toBeEditable(this: MatcherThis, received: ShimLocator, options?: { editable?: boolean; timeout?: number }) {
      return matchers.toBeEditable(received, options?.editable ?? true, this.isNot, { ...options, ...resolveTimeout(options?.timeout, this) });
    },
    async toBeAttached(this: MatcherThis, received: ShimLocator, options?: { attached?: boolean; timeout?: number }) {
      return matchers.toBeAttached(received, options?.attached ?? true, this.isNot, { ...options, ...resolveTimeout(options?.timeout, this) });
    },
    async toBeFocused(this: MatcherThis, received: ShimLocator, options?: { timeout?: number }) {
      return matchers.toBeFocused(received, this.isNot, { ...options, ...resolveTimeout(options?.timeout, this) });
    },
    async toBeEmpty(this: MatcherThis, received: ShimLocator, options?: { timeout?: number }) {
      return matchers.toBeEmpty(received, this.isNot, { ...options, ...resolveTimeout(options?.timeout, this) });
    },
    async toBeInViewport(this: MatcherThis, received: ShimLocator, options?: { ratio?: number; timeout?: number }) {
      return matchers.toBeInViewport(received, this.isNot, { ...options, ...resolveTimeout(options?.timeout, this) });
    },
    async toHaveText(this: MatcherThis, received: ShimLocator, expected: string | RegExp | Array<string | RegExp>, options?: matchers.TextMatcherOptions) {
      return matchers.toHaveText(received, expected, this.isNot, { ...options, ...resolveTimeout(options?.timeout, this) });
    },
    async toContainText(this: MatcherThis, received: ShimLocator, expected: string | RegExp | Array<string | RegExp>, options?: matchers.TextMatcherOptions) {
      return matchers.toContainText(received, expected, this.isNot, { ...options, ...resolveTimeout(options?.timeout, this) });
    },
    async toHaveCSS(this: MatcherThis, received: ShimLocator, property: string, expected: string | RegExp, options?: { timeout?: number }) {
      return matchers.toHaveCSS(received, property, expected, this.isNot, { ...options, ...resolveTimeout(options?.timeout, this) });
    },
    async toHaveValue(this: MatcherThis, received: ShimLocator, expected: string | RegExp, options?: { timeout?: number }) {
      return matchers.toHaveValue(received, expected, this.isNot, { ...options, ...resolveTimeout(options?.timeout, this) });
    },
    async toHaveAttribute(
      this: MatcherThis,
      received: ShimLocator,
      name: string,
      expectedOrOptions?: string | RegExp | { timeout?: number },
      maybeOptions?: { timeout?: number },
    ) {
      const hasExpected = typeof expectedOrOptions === 'string' || expectedOrOptions instanceof RegExp;
      const expected = hasExpected ? expectedOrOptions : undefined;
      const options = hasExpected ? maybeOptions : expectedOrOptions;
      return matchers.toHaveAttribute(received, name, expected, this.isNot, { ...options, ...resolveTimeout(options?.timeout, this) });
    },
    async toHaveClass(this: MatcherThis, received: ShimLocator, expected: string | RegExp, options?: { timeout?: number }) {
      return matchers.toHaveClass(received, expected, this.isNot, { ...options, ...resolveTimeout(options?.timeout, this) });
    },
    async toHaveCount(this: MatcherThis, received: ShimLocator, expected: number, options?: { timeout?: number }) {
      return matchers.toHaveCount(received, expected, this.isNot, { ...options, ...resolveTimeout(options?.timeout, this) });
    },
    async toHaveURL(this: MatcherThis, received: unknown, expected: matchers.URLMatch, options?: { timeout?: number }) {
      if (!isShimPage(received)) throw new Error('toHaveURL() expects the shim page fixture');
      return matchers.toHaveURL(received, expected, this.isNot, { ...options, ...resolveTimeout(options?.timeout, this) });
    },
    async toHaveTitle(this: MatcherThis, received: unknown, expected: string | RegExp, options?: { timeout?: number }) {
      if (!isShimPage(received)) throw new Error('toHaveTitle() expects the shim page fixture');
      return matchers.toHaveTitle(received, expected, this.isNot, { ...options, ...resolveTimeout(options?.timeout, this) });
    },
    async toHaveJSProperty(this: MatcherThis, received: ShimLocator, name: string, expected: unknown, options?: { timeout?: number }) {
      return matchers.toHaveJSProperty(received, name, expected, this.isNot, { ...options, ...resolveTimeout(options?.timeout, this) });
    },
  };
}

/**
 * `@playwright/test`'s test runner requires every spec file in a run to
 * import `test`/`expect` from the exact same module instance the `playwright`
 * CLI itself resolved — fixture registration is keyed off that singleton. A
 * real-world target repo has its OWN `@playwright/test` install; if this
 * shim imported `@playwright/test` directly (resolving from *our* package's
 * node_modules), it would silently be a different, incompatible instance.
 *
 * So instead of importing `@playwright/test` here, this is a factory: the
 * consuming repo's own wrapper file does
 * `import { test, expect } from '@playwright/test'` itself (correctly
 * resolving its own install) and passes them in.
 */
export function createMcpTest(base: typeof PWTest, baseExpect: typeof PWExpect) {
  type ShimFixtures = {
    mcpOptions: McpTransportOptions;
    page: Page;
    context: BrowserContext;
  };

  const test = base.extend<ShimFixtures>({
    mcpOptions: [{}, { option: true }],

    page: async (
      {
        mcpOptions,
        baseURL,
        browserName,
        channel,
        headless,
        contextOptions,
        viewport,
        locale,
        timezoneId,
        storageState,
        permissions,
        userAgent,
        deviceScaleFactor,
        isMobile,
        hasTouch,
        colorScheme,
        geolocation,
        extraHTTPHeaders,
        offline,
        httpCredentials,
        ignoreHTTPSErrors,
        bypassCSP,
        serviceWorkers,
        javaScriptEnabled,
      },
      use,
    ) => {
      if (javaScriptEnabled === false) {
        throw new Error(
          'createMcpTest does not support javaScriptEnabled: false: the Playwright MCP server and this shim both depend on in-page evaluation for selectors and page state.',
        );
      }
      const projectContextOptions = Object.fromEntries(
        Object.entries({
          ...contextOptions,
          baseURL,
          viewport,
          locale,
          timezoneId,
          storageState,
          permissions,
          userAgent,
          deviceScaleFactor,
          isMobile,
          hasTouch,
          colorScheme,
          geolocation,
          extraHTTPHeaders,
          offline,
          httpCredentials,
          ignoreHTTPSErrors,
          bypassCSP,
          serviceWorkers,
          javaScriptEnabled,
        }).filter(([, value]) => value !== undefined),
      );
      const page = await createShimPage(
        {
          ...mcpOptions,
          browser: mcpOptions.browser ?? channel ?? browserName,
          headless: mcpOptions.headless ?? headless,
          contextOptions: {
            ...projectContextOptions,
            ...mcpOptions.contextOptions,
          },
        },
        baseURL,
      );
      await use(page);
      await page.close();
    },

    context: async ({ page }, use) => {
      await use(page.context());
    },
  });

  const expect = baseExpect.extend(buildShimMatchers());

  return { test, expect };
}
