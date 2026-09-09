import { textFromResult, type McpToolClient } from '../tool-client.js';
import { evalGlobal } from './evaluate.js';
import { ShimLocator, type ClickOptions, type LocatorOptions } from './locator.js';
import {
  altTextSelector,
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

function matchesGlob(value: string, glob: string): boolean {
  let source = '^';
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]!;
    if (char === '*') {
      if (glob[index + 1] === '*') {
        source += '.*';
        index++;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`).test(value);
}

export type WaitForSelectorOptions = { timeout?: number; state?: 'attached' | 'detached' | 'visible' | 'hidden'; strict?: boolean };
export type WaitForURLOptions = {
  timeout?: number;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
};
export type { GetByRoleOptions, GetByTextOptions } from './get-by.js';
export type ShimResponse = {
  status(): number;
  ok(): boolean;
  url(): string;
  headers(): Record<string, string>;
  allHeaders(): Promise<Record<string, string>>;
  headerValue(name: string): Promise<string | null>;
  json(): Promise<never>;
  text(): Promise<never>;
};
export type MouseClickOptions = { button?: 'left' | 'right' | 'middle'; clickCount?: number; delay?: number };
export type MouseMoveOptions = { steps?: number };
export type ApiRequestOptions = {
  headers?: Record<string, string>;
  data?: unknown;
  form?: Record<string, string | number | boolean>;
  params?: Record<string, string | number | boolean | Array<string | number | boolean>>;
  maxRedirects?: number;
};
export type ApiResponse = {
  status(): number;
  ok(): boolean;
  text(): Promise<string>;
  json(): Promise<unknown>;
  headers(): Record<string, string>;
  allHeaders(): Promise<Record<string, string>>;
  url(): string;
};
export type ApiRequest = {
  url(): string;
  method(): string;
  headers(): Record<string, string>;
  allHeaders(): Promise<Record<string, string>>;
  headerValue(name: string): Promise<string | null>;
  isNavigationRequest(): boolean;
  resourceType(): string;
  postData(): string | null;
  postDataJSON(): unknown;
};
type RouteDecision =
  | { action: 'abort'; errorCode?: string }
  | { action: 'continue'; options?: Record<string, unknown> }
  | { action: 'fulfill'; options?: Record<string, unknown> };
type RouteLike = {
  abort(errorCode?: string): Promise<void>;
  continue(options?: Record<string, unknown>): Promise<void>;
  fallback(options?: Record<string, unknown>): Promise<void>;
  fulfill(options?: Record<string, unknown>): Promise<void>;
  request(): ApiRequest;
};
type RouteRequestSnapshot = {
  url: string;
  method: string;
  headers: Record<string, string>;
  isNavigationRequest: boolean;
  resourceType: string;
  postData: string | null;
};
type RetainedNetworkEntry = { index: number; method: string; url: string; status?: number };

function parseRetainedNetworkLog(text: string): RetainedNetworkEntry[] {
  const entries: RetainedNetworkEntry[] = [];
  for (const line of text.split('\n')) {
    const match = /^(\d+)\. \[([A-Z]+)\] (.+?) => \[(\d+|FAILED)\](?: .*)?$/.exec(line);
    if (match) {
      entries.push({
        index: Number(match[1]),
        method: match[2]!,
        url: match[3]!,
        status: match[4] === 'FAILED' ? 0 : Number(match[4]),
      });
      continue;
    }
    const pending = /^(\d+)\. \[([A-Z]+)\] (.+)$/.exec(line);
    if (!pending) continue;
    entries.push({
      index: Number(pending[1]),
      method: pending[2]!,
      url: pending[3]!,
    });
  }
  return entries;
}

function extractMcpResult(raw: string): string {
  const marker = '### Result\n';
  const start = raw.indexOf(marker);
  if (start === -1) return raw.trim();
  const rest = raw.slice(start + marker.length);
  const end = rest.indexOf('\n### ');
  return (end === -1 ? rest : rest.slice(0, end)).trim();
}

function parseHeaderBlock(raw: string): Record<string, string> {
  return Object.fromEntries(
    extractMcpResult(raw)
      .split('\n')
      .flatMap((line) => {
        const colon = line.indexOf(':');
        return colon === -1 ? [] : [[line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()]];
      }),
  );
}

function parsePageErrorMessages(lines: string[]): string[] {
  return lines
    .filter((line) => /^(?:[A-Za-z]*(?:Error|Exception)(?::|$)|Uncaught )/.test(line) && !line.startsWith('[ERROR]'))
    .map((line) => line.replace(/^[A-Za-z]*(?:Error|Exception):\s*/, ''));
}

type TabCoordinator = {
  rootClient: McpToolClient;
  activeIndex: number | undefined;
  tail: Promise<void>;
  pages: Map<number, ShimPage>;
};

/**
 * A best-effort, Playwright-`Page`-shaped facade over the MCP transport,
 * built for swapping into existing `@playwright/test` suites via a `page`
 * fixture override — see shim/index.ts. It is NOT a complete `Page`
 * implementation: event APIs are reconstructed from retained MCP logs,
 * polling, or atomic native operations where possible, while features with
 * no MCP/DOM equivalent remain unsupported and gaps are filled in as real
 * suites hit them.
 */
export class ShimPage {
  private readonly client: McpToolClient;
  private readonly tabCoordinator: TabCoordinator;
  private readonly tabIndex: number;
  private lastKnownUrl = '';
  private lastUrlObservationAt = 0;
  private lastKnownViewport: { width: number; height: number } | null = null;
  private toolNamesPromise: Promise<Set<string>> | null = null;
  private deferredCleanups: Array<() => Promise<void>> = [];
  private observedRouteSequence = 0;
  private observedRouteHandlers = new Map<
    string,
    {
      patternKey: string;
      handler: (route: RouteLike) => unknown | Promise<unknown>;
    }
  >();
  private routeReplayPromise: Promise<void> | null = null;

  constructor(
    client: McpToolClient,
    private readonly baseURL?: string,
    tabCoordinator?: TabCoordinator,
    tabIndex = 0,
  ) {
    this.tabCoordinator =
      tabCoordinator ??
      {
        rootClient: client,
        activeIndex: 0,
        tail: Promise.resolve(),
        pages: new Map(),
      };
    this.tabIndex = tabIndex;
    this.client = this.tabClient(tabIndex);
    this.tabCoordinator.pages.set(tabIndex, this);
  }

  private resolveUrl(url: string): string {
    if (/^[a-z]+:\/\//i.test(url) || !this.baseURL) return url;
    return new URL(url, this.baseURL).toString();
  }

  private hasTool(name: string): Promise<boolean> {
    this.toolNamesPromise ??= this.client.listTools().then((tools) => new Set(tools.map((tool) => tool.name)));
    return this.toolNamesPromise.then((names) => names.has(name));
  }

  /**
   * MCP tools target one active tab. Serialize tab selection and the tool call
   * as one critical section so operations on two Page facades cannot race and
   * accidentally execute against each other's tab.
   */
  private tabClient(index: number): McpToolClient {
    const coordinator = this.tabCoordinator;
    const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
      const result = coordinator.tail.then(operation);
      coordinator.tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };
    return {
      listTools: () => coordinator.rootClient.listTools(),
      callTool: (name, args, options) =>
        enqueue(async () => {
          if (coordinator.activeIndex !== index) {
            await coordinator.rootClient.callTool('browser_tabs', { action: 'select', index });
            coordinator.activeIndex = index;
          }
          return coordinator.rootClient.callTool(name, args, options);
        }),
    };
  }

  private pageForTab(index: number, initialUrl = 'about:blank'): ShimPage {
    const existing = this.tabCoordinator.pages.get(index);
    const page = existing ?? new ShimPage(this.tabCoordinator.rootClient, this.baseURL, this.tabCoordinator, index);
    page.lastKnownUrl = initialUrl;
    page.lastUrlObservationAt = Date.now();
    return page;
  }

  private async newContextPage(): Promise<ShimPage> {
    const raw = textFromResult(
      await this.client.callTool('browser_run_code_unsafe', {
        code: `async (page) => {
          const created = await page.context().newPage();
          return { index: page.context().pages().indexOf(created), url: created.url() };
        }`,
      }),
    );
    const result = JSON.parse(extractMcpResult(raw)) as { index: number; url: string };
    this.knownTabCount = Math.max(this.knownTabCount, result.index + 1);
    // Some MCP versions select a newly created tab implicitly; force the next
    // operation to establish its intended tab instead of trusting stale state.
    this.tabCoordinator.activeIndex = undefined;
    return this.pageForTab(result.index, result.url);
  }

  private emitEvent(event: string, value: unknown): void {
    for (const handler of [...(this.eventListeners.get(event) ?? [])]) handler(value);
  }

  /** Fetches the real, current URL and refreshes the cache backing the synchronous `url()` getter. */
  private async refreshUrl(): Promise<string> {
    const current = (await evalGlobal(this.client, '() => location.href')) as string;
    this.lastKnownUrl = current;
    this.lastUrlObservationAt = Date.now();
    return current;
  }

  private async observeCurrentUrl(force = false): Promise<void> {
    if (!force && Date.now() - this.lastUrlObservationAt < 200) return;
    this.lastUrlObservationAt = Date.now();
    try {
      await this.refreshUrl();
    } catch {
      // Navigation can briefly destroy the execution context; the next action/read retries.
    }
  }

  private async afterLocatorAction(): Promise<void> {
    await this.replayObservedRouteRequests();
    await this.observeCurrentUrl(true);
    if ([...this.eventListeners.values()].some((listeners) => listeners.length > 0)) {
      await this.pollEvents();
      await this.pollEvents();
    }
  }

  private async beforeLocatorOperation(): Promise<void> {
    await this.waitForEventBaselines();
    await this.replayObservedRouteRequests();
  }

  locator(selector: string, options?: LocatorOptions): ShimLocator {
    return new ShimLocator(
      this.client,
      selector,
      options,
      () => this.beforeLocatorOperation(),
      (target, clickOptions) => this.clickAndCapturePendingPopup(target, clickOptions),
      () => this.afterLocatorAction(),
      async (url) => {
        this.lastKnownUrl = url;
        this.lastUrlObservationAt = Date.now();
      },
      (cleanup) => this.deferredCleanups.push(cleanup),
      this,
    );
  }

  frameLocator(selector: string): ShimLocator {
    return this.locator(`${selector} >> internal:control=enter-frame`);
  }

  getByRole(role: string, options?: GetByRoleOptions): ShimLocator {
    return this.locator(roleSelector(role, options));
  }

  getByText(text: TextPattern, options?: GetByTextOptions): ShimLocator {
    return this.locator(textSelector(text, options));
  }

  getByTestId(id: string): ShimLocator {
    return this.locator(testIdSelector(id));
  }

  getByPlaceholder(text: string): ShimLocator {
    return this.locator(placeholderSelector(text));
  }

  getByAltText(text: string): ShimLocator {
    return this.locator(altTextSelector(text));
  }

  getByTitle(text: string): ShimLocator {
    return this.locator(titleSelector(text));
  }

  getByLabel(text: TextPattern, options?: GetByTextOptions): ShimLocator {
    return this.locator(labelSelector(text, options));
  }

  /**
   * Use the native page operation through the code tool so `waitUntil`,
   * `timeout`, the final redirected URL, status, and viewport all cross the
   * transport in one round trip. Besides matching Playwright's navigation
   * semantics, this avoids losing short-lived post-hydration DOM states to
   * several serialized follow-up reads.
   */
  async goto(url: string, options?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit'; timeout?: number }): Promise<ShimResponse> {
    await this.waitForEventBaselines();
    const full = this.resolveUrl(url);
    const timeout = options?.timeout ?? 60_000;
    const navigationOptions = {
      ...(options?.waitUntil ? { waitUntil: options.waitUntil } : {}),
      timeout,
    };
    const raw = textFromResult(
      await this.client.callTool('browser_run_code_unsafe', {
        code: `async (page) => {
          const response = await page.goto(${JSON.stringify(full)}, ${JSON.stringify(navigationOptions)});
          return {
            url: page.url(),
            status: response?.status() ?? 200,
            headers: response ? await response.allHeaders() : {},
            viewport: page.viewportSize()
          };
        }`,
      }, timeout > 0 ? { timeoutMs: timeout + 5_000 } : undefined),
    );
    const navigation = JSON.parse(extractMcpResult(raw)) as {
      url: string;
      status: number;
      headers: Record<string, string>;
      viewport: { width: number; height: number } | null;
    };
    this.lastKnownUrl = navigation.url;
    this.lastUrlObservationAt = Date.now();
    if (navigation.viewport) this.lastKnownViewport = navigation.viewport;
    await this.replayObservedRouteRequests();
    if ((this.eventListeners.get('request')?.length ?? 0) || (this.eventListeners.get('response')?.length ?? 0)) {
      await this.pollEvents();
    }
    if (this.eventListeners.get('load')?.length) {
      // A poll may already be finishing from before browser_navigate. Waiting
      // twice guarantees one serialized pass observes the new document.
      await this.pollEvents();
      await this.pollEvents();
    }
    return this.navigationResponse(navigation.status, navigation.url, navigation.headers);
  }

  private async waitForNetworkIdle(timeoutMs = 10_000, quietMs = 500): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastCount = -1;
    let stableSince = Date.now();
    while (Date.now() < deadline) {
      let count: number;
      try {
        count = (await evalGlobal(this.client, `() => performance.getEntriesByType('resource').length`)) as number;
      } catch {
        return; // page mid-navigation; can't measure further, don't hang the whole goto() on it
      }
      if (count === lastCount) {
        if (Date.now() - stableSince >= quietMs) return;
      } else {
        lastCount = count;
        stableSince = Date.now();
      }
      await sleep(100);
    }
  }

  /** Prevent listeners registered after a navigation from replaying old requests. */
  private async primeNetworkHistory(): Promise<void> {
    try {
      if (await this.hasTool('browser_network_requests')) {
        const text = textFromResult(await this.client.callTool('browser_network_requests', { static: true }));
        for (const entry of parseRetainedNetworkLog(text)) {
          this.seenNetworkRequestIndexes.add(entry.index);
          if (entry.status !== undefined) this.seenNetworkResponseIndexes.add(entry.index);
        }
        return;
      }
    } catch {
      // Fall through to Resource Timing for older/incompatible servers.
    }
    try {
      const urls = (await evalGlobal(this.client, `() => performance.getEntriesByType('resource').map((entry) => entry.name)`)) as string[];
      for (const url of urls) this.seenResourceUrls.add(url);
    } catch {
      // A page mid-navigation may not be queryable yet; the next poll can recover.
    }
  }

  async goBack(options?: WaitForURLOptions): Promise<ShimResponse | null> {
    return this.nativeHistoryNavigation('goBack', options);
  }

  async goForward(options?: WaitForURLOptions): Promise<ShimResponse | null> {
    return this.nativeHistoryNavigation('goForward', options);
  }

  private async nativeHistoryNavigation(
    operation: 'goBack' | 'goForward' | 'reload',
    options?: WaitForURLOptions,
  ): Promise<ShimResponse | null> {
    await this.waitForEventBaselines();
    const timeout = options?.timeout ?? 60_000;
    const navigationOptions = {
      ...(options?.waitUntil ? { waitUntil: options.waitUntil } : {}),
      timeout,
    };
    const raw = textFromResult(
      await this.client.callTool('browser_run_code_unsafe', {
        code: `async (page) => {
          const response = await page[${JSON.stringify(operation)}](${JSON.stringify(navigationOptions)});
          return {
            hasResponse: !!response,
            url: page.url(),
            status: response?.status() ?? 0,
            headers: response ? await response.allHeaders() : {},
            viewport: page.viewportSize()
          };
        }`,
      }, timeout > 0 ? { timeoutMs: timeout + 5_000 } : undefined),
    );
    const navigation = JSON.parse(extractMcpResult(raw)) as {
      hasResponse: boolean;
      url: string;
      status: number;
      headers: Record<string, string>;
      viewport: { width: number; height: number } | null;
    };
    this.lastKnownUrl = navigation.url;
    this.lastUrlObservationAt = Date.now();
    if (navigation.viewport) this.lastKnownViewport = navigation.viewport;
    await this.replayObservedRouteRequests();
    if ((this.eventListeners.get('request')?.length ?? 0) || (this.eventListeners.get('response')?.length ?? 0)) {
      await this.pollEvents();
    }
    if (this.eventListeners.get('load')?.length) {
      await this.pollEvents();
      await this.pollEvents();
    }
    return navigation.hasResponse
      ? this.navigationResponse(navigation.status, navigation.url, navigation.headers)
      : null;
  }

  private routePatternKey(pattern: string | RegExp): string {
    return typeof pattern === 'string' ? `string:${pattern}` : `regexp:${pattern.source}/${pattern.flags}`;
  }

  private observedRequest(snapshot: RouteRequestSnapshot): ApiRequest {
    const headers = Object.fromEntries(Object.entries(snapshot.headers).map(([name, value]) => [name.toLowerCase(), value]));
    return {
      url: () => snapshot.url,
      method: () => snapshot.method,
      headers: () => ({ ...headers }),
      allHeaders: async () => ({ ...headers }),
      headerValue: async (name) => headers[name.toLowerCase()] ?? null,
      isNavigationRequest: () => snapshot.isNavigationRequest,
      resourceType: () => snapshot.resourceType,
      postData: () => snapshot.postData,
      postDataJSON: () => {
        if (!snapshot.postData) return null;
        try {
          return JSON.parse(snapshot.postData);
        } catch {
          return null;
        }
      },
    };
  }

  private replayObservedRouteRequests(): Promise<void> {
    if (!this.observedRouteHandlers.size) return Promise.resolve();
    if (this.routeReplayPromise) return this.routeReplayPromise;
    const replay = this.replayObservedRouteRequestsOnce();
    this.routeReplayPromise = replay;
    void replay
      .finally(() => {
        if (this.routeReplayPromise === replay) this.routeReplayPromise = null;
      })
      .catch(() => {});
    return replay;
  }

  private async replayObservedRouteRequestsOnce(): Promise<void> {
    const ids = [...this.observedRouteHandlers.keys()];
    if (!ids.length) return;
    const raw = textFromResult(
      await this.client.callTool('browser_run_code_unsafe', {
        code: `async (page) => {
          const queues = page.__playwrightMcpObservedRouteQueues || {};
          const drained = {};
          for (const id of ${JSON.stringify(ids)}) {
            drained[id] = Array.isArray(queues[id]) ? queues[id].splice(0) : [];
          }
          return drained;
        }`,
      }),
    );
    const drained = JSON.parse(extractMcpResult(raw)) as Record<string, RouteRequestSnapshot[]>;
    for (const id of ids) {
      const registration = this.observedRouteHandlers.get(id);
      if (!registration) continue;
      for (const snapshot of drained[id] ?? []) {
        let decision: RouteDecision | undefined;
        const route: RouteLike = {
          abort: async (errorCode) => {
            decision = { action: 'abort', errorCode };
          },
          continue: async (options) => {
            decision = { action: 'continue', options };
          },
          fallback: async (options) => {
            decision = { action: 'continue', options };
          },
          fulfill: async (options) => {
            decision = { action: 'fulfill', options };
          },
          request: () => this.observedRequest(snapshot),
        };
        await registration.handler(route);
        if (decision && decision.action !== 'continue') {
          throw new Error(
            `page.route(): request-dependent ${decision.action}() is not representable over the MCP transport; only request observation followed by continue()/fallback() is supported.`,
          );
        }
      }
    }
  }

  /**
   * MCP cannot invoke a callback in the test runner from a live native route.
   * Static/stateful action handlers are sampled into a short decision
   * sequence. Request-observing handlers instead enqueue the native Request's
   * metadata in the MCP process, continue immediately, and replay the handler
   * in the test runner after the triggering operation. This preserves closure
   * side effects (for example collecting POST content types) while making the
   * unavoidable limit explicit: a decision based on request data cannot be
   * applied retroactively, so only continue()/fallback() is supported there.
   */
  async route(pattern: string | RegExp, handler: (route: RouteLike) => unknown | Promise<unknown>): Promise<void> {
    const patternSource =
      pattern instanceof RegExp ? `new RegExp(${JSON.stringify(pattern.source)}, ${JSON.stringify(pattern.flags)})` : JSON.stringify(pattern);
    if (/\.\s*request\s*\(/.test(Function.prototype.toString.call(handler))) {
      const id = `route-${++this.observedRouteSequence}`;
      this.observedRouteHandlers.set(id, { patternKey: this.routePatternKey(pattern), handler });
      try {
        await this.client.callTool('browser_run_code_unsafe', {
          code: `async (page) => {
            const queues = page.__playwrightMcpObservedRouteQueues ||= {};
            queues[${JSON.stringify(id)}] = [];
            await page.route(${patternSource}, async (route) => {
              const request = route.request();
              queues[${JSON.stringify(id)}].push({
                url: request.url(),
                method: request.method(),
                headers: await request.allHeaders(),
                isNavigationRequest: request.isNavigationRequest(),
                resourceType: request.resourceType(),
                postData: request.postData()
              });
              await route.continue();
            });
          }`,
        });
      } catch (error) {
        this.observedRouteHandlers.delete(id);
        throw error;
      }
      return;
    }

    const sample = async (): Promise<RouteDecision> => {
      let decision: RouteDecision | undefined;
      const route: RouteLike = {
        abort: async (errorCode) => {
          decision = { action: 'abort', errorCode };
        },
        continue: async (options) => {
          decision = { action: 'continue', options };
        },
        fallback: async (options) => {
          decision = { action: 'continue', options };
        },
        fulfill: async (options) => {
          decision = { action: 'fulfill', options };
        },
        request: () => {
          throw new Error('page.route(): failed to classify a request-inspecting route handler.');
        },
      };
      await handler(route);
      return decision ?? { action: 'continue' };
    };

    const first = await sample();
    const second = await sample();
    const decisions = JSON.stringify(first) === JSON.stringify(second) ? [first] : [first, second];
    await this.client.callTool('browser_run_code_unsafe', {
      code: `async (page) => {
        const decisions = ${JSON.stringify(decisions)};
        let index = 0;
        await page.route(${patternSource}, async (route) => {
          const decision = decisions[Math.min(index++, decisions.length - 1)];
          if (decision.action === 'abort') await route.abort(decision.errorCode);
          else if (decision.action === 'fulfill') await route.fulfill(decision.options);
          else await route.continue(decision.options);
        });
      }`,
    });
  }

  async unroute(pattern?: string | RegExp): Promise<void> {
    await this.replayObservedRouteRequests();
    if (pattern === undefined) {
      await this.client.callTool('browser_run_code_unsafe', {
        code: `async (page) => { await page.unrouteAll(); }`,
      });
      this.observedRouteHandlers.clear();
      return;
    }
    const patternSource =
      pattern instanceof RegExp
        ? `new RegExp(${JSON.stringify(pattern.source)}, ${JSON.stringify(pattern.flags)})`
        : JSON.stringify(pattern);
    await this.client.callTool('browser_run_code_unsafe', {
      code: `async (page) => { await page.unroute(${patternSource}); }`,
    });
    const patternKey = this.routePatternKey(pattern);
    for (const [id, registration] of this.observedRouteHandlers) {
      if (registration.patternKey === patternKey) this.observedRouteHandlers.delete(id);
    }
  }

  async dispatchEvent(selector: string, type: string, eventInit?: Record<string, unknown>): Promise<void> {
    await this.locator(selector).first().dispatchEvent(type, eventInit);
  }

  /** Builds the synchronous portion of Playwright's navigation response facade. */
  private navigationResponse(status: number, url: string, headers: Record<string, string>): ShimResponse {
    return {
      status: () => status,
      ok: () => status >= 200 && status < 400,
      url: () => url,
      headers: () => ({ ...headers }),
      allHeaders: async () => ({ ...headers }),
      headerValue: async (name) => headers[name.toLowerCase()] ?? null,
      json: async () => {
        throw new Error('ShimResponse.json(): navigation response bodies are not retained by the MCP transport.');
      },
      text: async () => {
        throw new Error('ShimResponse.text(): navigation response bodies are not retained by the MCP transport.');
      },
    };
  }

  private retainedRequest(
    entry: RetainedNetworkEntry,
    postData: string | null,
    isNavigationRequest: boolean,
    resourceType: string,
  ): ApiRequest {
    let headers: Record<string, string> = {};
    let headersPromise: Promise<Record<string, string>> | null = null;
    const allHeaders = (): Promise<Record<string, string>> => {
      headersPromise ??= (async () => {
        try {
          const raw = textFromResult(
            await this.client.callTool('browser_network_request', {
              index: entry.index,
              part: 'request-headers',
            }),
          );
          headers = parseHeaderBlock(raw);
        } catch {
          headers = {};
        }
        return { ...headers };
      })();
      return headersPromise;
    };
    return {
      url: () => entry.url,
      method: () => entry.method,
      headers: () => ({ ...headers }),
      allHeaders,
      headerValue: async (name) => (await allHeaders())[name.toLowerCase()] ?? null,
      isNavigationRequest: () => isNavigationRequest,
      resourceType: () => resourceType,
      postData: () => postData,
      postDataJSON: () => {
        if (!postData) return null;
        try {
          return JSON.parse(postData);
        } catch {
          return null;
        }
      },
    };
  }

  async click(selector: string, options?: Parameters<ShimLocator['click']>[0]): Promise<void> {
    await this.locator(selector).first().click(options);
  }
  async dblclick(selector: string): Promise<void> {
    await this.locator(selector).first().dblclick();
  }
  async fill(selector: string, value: string): Promise<void> {
    await this.locator(selector).first().fill(value);
  }
  async type(selector: string, value: string): Promise<void> {
    await this.locator(selector).first().type(value);
  }
  async check(selector: string): Promise<void> {
    await this.locator(selector).first().check();
  }
  async uncheck(selector: string): Promise<void> {
    await this.locator(selector).first().uncheck();
  }
  async hover(selector: string): Promise<void> {
    await this.locator(selector).first().hover();
  }
  async selectOption(selector: string, value: string | string[]): Promise<void> {
    await this.locator(selector).first().selectOption(value);
  }
  async focus(selector: string): Promise<void> {
    await this.locator(selector).first().focus();
  }
  async textContent(selector: string): Promise<string | null> {
    return this.locator(selector).first().textContent();
  }
  async inputValue(selector: string): Promise<string> {
    return this.locator(selector).first().inputValue();
  }
  async isVisible(selector: string): Promise<boolean> {
    return this.locator(selector).first().isVisible();
  }
  async getAttribute(selector: string, name: string): Promise<string | null> {
    return this.locator(selector).first().getAttribute(name);
  }
  async press(selector: string, key: string): Promise<void> {
    await this.locator(selector).first().press(key);
  }

  /** Legacy ElementHandle-returning query, still used by some suites. Each handle is a full ShimLocator pinned to its index. */
  async $$(selector: string): Promise<ShimLocator[]> {
    const locator = this.locator(selector);
    const count = await locator.count();
    return Array.from({ length: count }, (_, i) => locator.nth(i));
  }

  /** Legacy: returns the first match (real Playwright doesn't strict-mode-check `$`), or null if there isn't one. */
  async $(selector: string): Promise<ShimLocator | null> {
    const locator = this.locator(selector);
    return (await locator.count()) === 0 ? null : locator.first();
  }

  async $eval(selector: string, fn: Function | string, arg?: unknown): Promise<unknown> {
    return this.locator(selector).first().evaluate(fn, arg);
  }

  async innerHTML(selector: string): Promise<string> {
    return this.locator(selector).first().innerHTML();
  }

  async innerText(selector: string): Promise<string> {
    return this.locator(selector).first().innerText();
  }

  keyboard = {
    press: async (key: string): Promise<void> => {
      await this.client.callTool('browser_press_key', { key });
    },
    /** Types into whatever's currently focused, one key event per character — no separate "type text into focused element" MCP tool exists. */
    type: async (text: string): Promise<void> => {
      for (const char of text) {
        await this.client.callTool('browser_press_key', { key: char });
      }
    },
  };

  clock = {
    install: async (options?: { time?: number | string | Date }): Promise<void> => {
      await this.client.callTool('browser_run_code_unsafe', {
        code: `async (page) => { await page.clock.install(${JSON.stringify(options ?? {})}); }`,
      });
    },
  };

  /**
   * MCP has no pushed event stream, but request/response can be reconstructed
   * from Resource Timing and console/pageerror can be polled from the server's
   * retained message log. Other event classes still fail explicitly.
   */
  async waitForEvent(
    event: string,
    optionsOrPredicate?:
      | ((arg: unknown) => boolean | Promise<boolean>)
      | { predicate?: (arg: unknown) => boolean | Promise<boolean>; timeout?: number },
  ): Promise<unknown> {
    if (!['request', 'response', 'console', 'pageerror', 'load', 'popup', 'download', 'filechooser'].includes(event)) {
      throw new Error(`page.waitForEvent("${event}"): not supported over the MCP transport — it has no event-stream to subscribe to (see ShimPage's docstring).`);
    }
    const predicate = typeof optionsOrPredicate === 'function' ? optionsOrPredicate : optionsOrPredicate?.predicate;
    // Playwright's page.waitForEvent() defaults to 0 (no operation-level
    // timeout); the enclosing test timeout remains authoritative. A fixed
    // shim-only 30s deadline incorrectly fails slow HMR/build events.
    const timeoutMs = (typeof optionsOrPredicate === 'object' ? optionsOrPredicate?.timeout : undefined) ?? 0;
    // Popup delivery crosses an extra MCP result-serialization hop after the
    // browser event itself. Keep the browser-facing timeout intact while
    // allowing a small transport-only completion grace.
    const isAtomicClickEvent = event === 'popup' || event === 'download' || event === 'filechooser';
    const completionTimeoutMs = timeoutMs > 0 && isAtomicClickEvent ? timeoutMs + 2_000 : timeoutMs;
    const clickEventWaiter = isAtomicClickEvent
      ? { deadline: timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY }
      : undefined;
    if (event === 'popup' && clickEventWaiter) this.popupWaiters.add(clickEventWaiter);
    if (event === 'download' && clickEventWaiter) this.downloadWaiters.add(clickEventWaiter);
    if (event === 'filechooser' && clickEventWaiter) this.fileChooserWaiters.add(clickEventWaiter);
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const handler = async (arg: unknown) => {
        if (settled) return;
        try {
          if (predicate && !(await predicate(arg))) return;
        } catch (err) {
          if (settled) return;
          settled = true;
          if (clickEventWaiter) {
            this.popupWaiters.delete(clickEventWaiter);
            this.downloadWaiters.delete(clickEventWaiter);
            this.fileChooserWaiters.delete(clickEventWaiter);
          }
          this.off(event, handler);
          if (timer) clearTimeout(timer);
          reject(err);
          return;
        }
        if (settled) return;
        settled = true;
        if (clickEventWaiter) {
          this.popupWaiters.delete(clickEventWaiter);
          this.downloadWaiters.delete(clickEventWaiter);
          this.fileChooserWaiters.delete(clickEventWaiter);
        }
        this.off(event, handler);
        if (timer) clearTimeout(timer);
        resolve(arg);
      };
      if (completionTimeoutMs > 0) {
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          if (clickEventWaiter) {
            this.popupWaiters.delete(clickEventWaiter);
            this.downloadWaiters.delete(clickEventWaiter);
            this.fileChooserWaiters.delete(clickEventWaiter);
          }
          this.off(event, handler);
          reject(new Error(`waitForEvent("${event}") timed out after ${timeoutMs}ms`));
        }, completionTimeoutMs);
      }
      this.on(event, handler);
    });
  }

  /** Returns native retained page errors, with a console-log fallback for older servers. */
  async pageErrors(): Promise<Error[]> {
    try {
      const raw = textFromResult(
        await this.client.callTool('browser_run_code_unsafe', {
          code: `async (page) => (await page.pageErrors()).map((error) => ({
            name: error.name,
            message: error.message,
            stack: error.stack
          }))`,
        }),
      );
      const entries = JSON.parse(extractMcpResult(raw)) as Array<{ name: string; message: string; stack?: string }>;
      return entries.map((entry) => Object.assign(new Error(entry.message), { name: entry.name, stack: entry.stack }));
    } catch {
      const text = textFromResult(await this.client.callTool('browser_console_messages', { level: 'debug', all: true }));
      return parsePageErrorMessages(text.split('\n')).map((message) => new Error(message));
    }
  }

  /** Register a native Playwright init script for this page's future documents. */
  async addInitScript(
    script: Function | string | { path?: string; content?: string },
    arg?: unknown,
  ): Promise<void> {
    const scriptSource = typeof script === 'function' ? `(${script.toString()})` : JSON.stringify(script);
    const argSource = arg === undefined ? '' : `, ${JSON.stringify(arg)}`;
    await this.client.callTool('browser_run_code_unsafe', {
      code: `async (page) => { await page.addInitScript(${scriptSource}${argSource}); }`,
    });
  }

  /** Waits through the shared serialized network poll, then hydrates retained response data on demand. */
  async waitForResponse(urlOrPattern: string | RegExp | ((response: ApiResponse) => boolean | Promise<boolean>), options?: { timeout?: number }): Promise<ApiResponse> {
    const isPredicate = typeof urlOrPattern === 'function';
    const isRegex = urlOrPattern instanceof RegExp;
    const toResponse = (url: string, status: number, index?: number, initialHeaders: Record<string, string> = {}): ApiResponse => {
      const readBody = async (): Promise<string> => {
        if (index === undefined) throw new Error('ApiResponse.text(): response body is unavailable from the Resource Timing fallback.');
        const raw = textFromResult(await this.client.callTool('browser_network_request', { index, part: 'response-body' }));
        return extractMcpResult(raw);
      };
      return {
        status: () => status,
        ok: () => status >= 200 && status < 400,
        headers: () => initialHeaders,
        allHeaders: async () => initialHeaders,
        url: () => url,
        text: readBody,
        json: async () => JSON.parse(await readBody()),
      };
    };
    const hydrateHeaders = async (entry: RetainedNetworkEntry): Promise<Record<string, string>> => {
      try {
        const raw = textFromResult(await this.client.callTool('browser_network_request', { index: entry.index, part: 'response-headers' }));
        return parseHeaderBlock(raw);
      } catch {
        return {};
      }
    };
    const matched = (await this.waitForEvent('response', {
      timeout: options?.timeout,
      predicate: async (arg) => {
        const response = arg as ApiResponse;
        if (isPredicate) return urlOrPattern(response);
        if (isRegex) {
          urlOrPattern.lastIndex = 0;
          return urlOrPattern.test(response.url());
        }
        return response.url().includes(urlOrPattern);
      },
    })) as ApiResponse & { _index?: number };
    const entry: RetainedNetworkEntry = {
      index: matched._index ?? -1,
      method: 'GET',
      url: matched.url(),
      status: matched.status(),
    };
    const headers = matched._index === undefined ? {} : await hydrateHeaders(entry);
    return toResponse(entry.url, entry.status ?? 0, matched._index, headers);
  }

  /** Thin wrapper over the same `on('request', ...)` Resource-Timing poll `waitForEvent` already drives — no separate implementation needed. */
  async waitForRequest(
    urlOrPattern: string | RegExp | ((request: ApiRequest) => boolean | Promise<boolean>),
    options?: { timeout?: number },
  ): Promise<ApiRequest> {
    const isPredicate = typeof urlOrPattern === 'function';
    const isRegex = urlOrPattern instanceof RegExp;
    const predicate = async (arg: unknown) => {
      const request = arg as ApiRequest;
      if (isPredicate) return urlOrPattern(request);
      if (isRegex) {
        urlOrPattern.lastIndex = 0;
        return urlOrPattern.test(request.url());
      }
      return request.url().includes(urlOrPattern);
    };
    return this.waitForEvent('request', { predicate, timeout: options?.timeout }) as Promise<ApiRequest>;
  }

  /**
   * Delegates to the managed page's native `APIRequestContext`, preserving
   * cookie sharing and request options without navigating or otherwise
   * mutating the browser page.
   */
  request = {
    fetch: (url: string, options?: ApiRequestOptions & { method?: string }): Promise<ApiResponse> => this.apiFetch(url, options?.method ?? 'GET', options),
    get: (url: string, options?: ApiRequestOptions): Promise<ApiResponse> => this.apiFetch(url, 'GET', options),
    post: (url: string, options?: ApiRequestOptions): Promise<ApiResponse> => this.apiFetch(url, 'POST', options),
    put: (url: string, options?: ApiRequestOptions): Promise<ApiResponse> => this.apiFetch(url, 'PUT', options),
    delete: (url: string, options?: ApiRequestOptions): Promise<ApiResponse> => this.apiFetch(url, 'DELETE', options),
  };

  /** BrowserContext-shaped facade backed by MCP's storage and network capability tools. */
  context() {
    return {
      request: this.request,
      pages: (): ShimPage[] =>
        [...this.tabCoordinator.pages.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, page]) => page),
      newPage: (): Promise<ShimPage> => this.newContextPage(),
      waitForEvent: (
        event: string,
        optionsOrPredicate?:
          | ((page: ShimPage) => boolean | Promise<boolean>)
          | { predicate?: (page: ShimPage) => boolean | Promise<boolean>; timeout?: number },
      ): Promise<unknown> => {
        if (event !== 'page') {
          throw new Error(`context.waitForEvent("${event}"): only the "page" event is supported over the MCP transport.`);
        }
        return this.waitForEvent('popup', optionsOrPredicate as Parameters<ShimPage['waitForEvent']>[1]);
      },
      cookies: async (): Promise<Array<{ name: string; value: string }>> => {
        if (await this.hasTool('browser_cookie_list')) {
          const text = textFromResult(await this.client.callTool('browser_cookie_list', {}));
          if (text.includes('No cookies found')) return [];
          return [...text.matchAll(/^([^=\n]+)=(.*?) \(domain: .*?, path: .*?\)$/gm)].map((match) => ({
            name: match[1]!,
            value: match[2]!,
          }));
        }
        const raw = (await evalGlobal(this.client, '() => document.cookie')) as string;
        return raw
          .split(';')
          .map((pair) => pair.trim())
          .filter(Boolean)
          .map((pair) => {
            const eq = pair.indexOf('=');
            return { name: pair.slice(0, eq), value: decodeURIComponent(pair.slice(eq + 1)) };
          });
      },
      addCookies: async (
        cookies: Array<{
          name: string;
          value: string;
          url?: string;
          domain?: string;
          path?: string;
          expires?: number;
          httpOnly?: boolean;
          secure?: boolean;
          sameSite?: 'Strict' | 'Lax' | 'None';
        }>,
      ): Promise<void> => {
        for (const cookie of cookies) {
          const { url, ...params } = cookie;
          if (await this.hasTool('browser_cookie_set')) {
            await this.client.callTool('browser_cookie_set', {
              ...params,
              domain: params.domain ?? (url ? new URL(url).hostname : undefined),
            });
          } else {
            await evalGlobal(
              this.client,
              `(cookie) => { document.cookie = cookie.name + '=' + encodeURIComponent(cookie.value) + ';path=' + (cookie.path || '/'); return true; }`,
              params,
            );
          }
        }
      },
      clearCookies: async (): Promise<void> => {
        if (await this.hasTool('browser_cookie_clear')) {
          await this.client.callTool('browser_cookie_clear', {});
        } else {
          await evalGlobal(
            this.client,
            `() => { document.cookie.split(';').forEach((c) => { document.cookie = c.trim().split('=')[0] + '=;expires=Thu, 01 Jan 1970 00:00:00 UTC;path=/'; }); return true; }`,
          );
        }
      },
      setOffline: async (offline: boolean): Promise<void> => {
        if (await this.hasTool('browser_network_state_set')) {
          await this.client.callTool('browser_network_state_set', { state: offline ? 'offline' : 'online' });
        } else {
          await this.client.callTool('browser_run_code_unsafe', {
            code: `async (page) => { await page.context().setOffline(${offline}); }`,
          });
        }
      },
      grantPermissions: async (permissions: string[], options?: { origin?: string }): Promise<void> => {
        await this.client.callTool('browser_run_code_unsafe', {
          code: `async (page) => { await page.context().grantPermissions(${JSON.stringify(permissions)}, ${JSON.stringify(options ?? {})}); }`,
        });
      },
      newCDPSession: async (_page: unknown) => ({
        send: async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
          const raw = textFromResult(
            await this.client.callTool('browser_run_code_unsafe', {
              code: `async (page) => {
                const session = await page.context().newCDPSession(page);
                return (await session.send(${JSON.stringify(method)}, ${JSON.stringify(params ?? {})})) ?? null;
              }`,
            }),
          );
          return JSON.parse(extractMcpResult(raw)) as unknown;
        },
      }),
      // The owning page fixture closes the MCP client after dependent context
      // fixtures tear down; closing here would double-close that connection.
      close: async (): Promise<void> => {},
    };
  }

  private async apiFetch(url: string, method: string, options?: ApiRequestOptions): Promise<ApiResponse> {
    const requestUrl = new URL(this.resolveUrl(url), this.lastKnownUrl || undefined);
    for (const [name, rawValue] of Object.entries(options?.params ?? {})) {
      const values = Array.isArray(rawValue) ? rawValue : [rawValue];
      for (const value of values) requestUrl.searchParams.append(name, String(value));
    }
    const full = requestUrl.toString();
    const requestOptions = {
      method,
      headers: options?.headers,
      data: options?.data,
      form: options?.form,
      maxRedirects: options?.maxRedirects,
    };
    const raw = textFromResult(
      await this.client.callTool('browser_run_code_unsafe', {
        code: `async (page) => {
          const response = await page.request.fetch(${JSON.stringify(full)}, ${JSON.stringify(requestOptions)});
          return {
            status: response.status(),
            ok: response.ok(),
            text: await response.text(),
            headers: response.headers(),
            url: response.url(),
          };
        }`,
      }),
    );
    const result = JSON.parse(extractMcpResult(raw)) as {
      status: number;
      ok: boolean;
      text: string;
      headers: Record<string, string>;
      url: string;
    };
    await this.replayObservedRouteRequests();
    return {
      status: () => result.status,
      ok: () => result.ok,
      headers: () => result.headers,
      allHeaders: async () => result.headers,
      text: async () => result.text,
      json: async () => JSON.parse(result.text),
      url: () => result.url || full,
    };
  }

  /** Delegate coordinate input to Playwright's native mouse through the code tool. */
  mouse = {
    move: async (x: number, y: number, options?: MouseMoveOptions): Promise<void> => {
      await this.client.callTool('browser_run_code_unsafe', {
        code: `async (page) => { await page.mouse.move(${x}, ${y}, ${JSON.stringify(options ?? {})}); }`,
      });
      await this.afterLocatorAction();
    },
    down: async (options?: MouseClickOptions): Promise<void> => {
      await this.client.callTool('browser_run_code_unsafe', {
        code: `async (page) => { await page.mouse.down(${JSON.stringify(options ?? {})}); }`,
      });
      await this.afterLocatorAction();
    },
    up: async (options?: MouseClickOptions): Promise<void> => {
      await this.client.callTool('browser_run_code_unsafe', {
        code: `async (page) => { await page.mouse.up(${JSON.stringify(options ?? {})}); }`,
      });
      await this.afterLocatorAction();
    },
    click: async (x: number, y: number, options?: MouseClickOptions): Promise<void> => {
      await this.client.callTool('browser_run_code_unsafe', {
        code: `async (page) => { await page.mouse.click(${x}, ${y}, ${JSON.stringify(options ?? {})}); }`,
      });
      await this.afterLocatorAction();
    },
  };

  async setExtraHTTPHeaders(headers: Record<string, string>): Promise<void> {
    await this.client.callTool('browser_run_code_unsafe', {
      code: `async (page) => { await page.setExtraHTTPHeaders(${JSON.stringify(headers)}); }`,
    });
  }

  async evaluate(fn: Function | string, arg?: unknown): Promise<unknown> {
    await this.waitForEventBaselines();
    if (arg instanceof ShimLocator) return arg.evaluate(fn);
    const result = await evalGlobal(this.client, fn, arg);
    await this.replayObservedRouteRequests();
    await this.observeCurrentUrl();
    return result;
  }

  async waitForTimeout(ms: number): Promise<void> {
    await sleep(ms);
    await this.replayObservedRouteRequests();
  }

  /** Polls `fn` in the page until it returns a truthy value, or times out. Returns that value (real Playwright returns a JSHandle; a plain value is close enough for how tests actually consume it). */
  async waitForFunction(fn: Function | string, arg?: unknown, options?: { timeout?: number; polling?: number }): Promise<unknown> {
    const timeout = options?.timeout ?? 60_000;
    const deadline = Date.now() + timeout;
    const pollMs = options?.polling ?? 100;
    for (;;) {
      const result = await evalGlobal(this.client, fn, arg);
      if (result) return result;
      if (Date.now() >= deadline) throw new Error(`waitForFunction() timed out after ${timeout}ms`);
      await sleep(pollMs);
    }
  }

  async waitForSelector(selector: string, options?: WaitForSelectorOptions): Promise<ShimLocator> {
    const state = options?.state ?? 'visible';
    const deadline = Date.now() + (options?.timeout ?? 60_000);
    const locator = this.locator(selector);
    for (;;) {
      const count = await locator.count();
      if (options?.strict && count > 1) {
        throw new Error(`strict mode violation: locator("${selector}") resolved to ${count} elements`);
      }
      const first = locator.first();
      const satisfied =
        state === 'attached'
          ? count > 0
          : state === 'detached'
            ? count === 0
            : state === 'hidden'
              ? count === 0 || (await first.isHidden())
              : count > 0 && (await first.isVisible());
      if (satisfied) return locator;
      if (Date.now() >= deadline) throw new Error(`waitForSelector("${selector}", state=${state}) timed out`);
      await sleep(100);
    }
  }

  async waitForURL(urlOrPattern: string | RegExp | ((url: URL) => boolean), options?: WaitForURLOptions): Promise<void> {
    const deadline = Date.now() + (options?.timeout ?? 30_000);
    for (;;) {
      const current = await this.refreshUrl();
      const matches =
        typeof urlOrPattern === 'function'
          ? urlOrPattern(new URL(current))
          : urlOrPattern instanceof RegExp
            ? urlOrPattern.test(current)
            : urlOrPattern.includes('*')
              ? matchesGlob(current, urlOrPattern)
              : current === this.resolveUrl(urlOrPattern) || current.includes(urlOrPattern);
      if (matches) {
        if (options?.waitUntil && options.waitUntil !== 'commit') {
          await this.waitForLoadState(options.waitUntil, { timeout: Math.max(1, deadline - Date.now()) });
        }
        return;
      }
      if (Date.now() >= deadline) throw new Error(`waitForURL(${typeof urlOrPattern === 'function' ? urlOrPattern.toString() : String(urlOrPattern)}) timed out, last url was ${current}`);
      await sleep(100);
    }
  }

  /** Detects both URL changes and same-URL reloads via a document-scoped marker. */
  async waitForNavigation(options?: WaitForURLOptions): Promise<void> {
    const marker = `mcp-nav-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const before = (await evalGlobal(
      this.client,
      `(marker) => { window.__playwrightMcpNavigationMarker = marker; return location.href; }`,
      marker,
    )) as string;
    this.lastKnownUrl = before;
    const deadline = Date.now() + (options?.timeout ?? 30_000);
    for (;;) {
      const state = (await evalGlobal(
        this.client,
        `() => ({ url: location.href, marker: window.__playwrightMcpNavigationMarker })`,
      )) as { url: string; marker?: string };
      this.lastKnownUrl = state.url;
      if (state.url !== before || state.marker !== marker) return;
      if (Date.now() >= deadline) throw new Error(`waitForNavigation() timed out waiting for a navigation from ${before}`);
      await sleep(100);
    }
  }

  /** MCP actions usually wait for load; keep the explicit Playwright states observable for direct in-page navigations too. */
  async waitForLoadState(state: 'load' | 'domcontentloaded' | 'networkidle' = 'load', options?: { timeout?: number }): Promise<void> {
    if (state === 'networkidle') {
      await this.waitForNetworkIdle(options?.timeout);
      return;
    }
    const readyState = state === 'load' ? 'complete' : 'interactive';
    await this.waitForFunction(
      `(expected) => document.readyState === 'complete' || document.readyState === expected`,
      readyState,
      { timeout: options?.timeout },
    );
  }

  private eventListeners = new Map<string, Array<(arg: unknown) => void>>();
  private resourcePollTimer: ReturnType<typeof setInterval> | null = null;
  private seenResourceUrls = new Set<string>();
  private seenNetworkRequestIndexes = new Set<number>();
  private seenNetworkResponseIndexes = new Set<number>();
  private knownTabCount = 1;
  private seenConsoleEntries = 0;
  private seenPageErrorEntries = 0;
  private eventPollPromise: Promise<void> | null = null;
  private networkListenerReady: Promise<void> | null = null;
  private loadListenerReady: Promise<void> | null = null;
  private consoleListenerReady: Promise<void> | null = null;
  private currentDocumentId: string | null = null;
  private popupWaiters = new Set<{ deadline: number }>();
  private downloadWaiters = new Set<{ deadline: number }>();
  private fileChooserWaiters = new Set<{ deadline: number }>();

  private async waitForEventBaselines(): Promise<void> {
    await Promise.all([this.networkListenerReady, this.loadListenerReady, this.consoleListenerReady]);
  }

  private async readDocumentState(): Promise<{ id: string; url: string; readyState: string }> {
    return (await evalGlobal(
      this.client,
      `() => {
        window.__playwrightMcpDocumentId ||= Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
        return { id: window.__playwrightMcpDocumentId, url: location.href, readyState: document.readyState };
      }`,
    )) as { id: string; url: string; readyState: string };
  }

  private async primeLoadDocument(): Promise<void> {
    try {
      const state = await this.readDocumentState();
      this.currentDocumentId = state.id;
      this.lastKnownUrl = state.url;
    } catch {
      // A later poll will establish the baseline if the page was transiently unavailable.
    }
  }

  /**
   * Install the listener in the MCP process, directly on the managed native
   * Page. Polling `browser_console_messages` alone can miss a navigation/HMR
   * message between snapshots; this persistent queue preserves exact events.
   */
  private async installNativeConsoleEventBridge(): Promise<void> {
    await this.client.callTool('browser_run_code_unsafe', {
      code: `async (page) => {
        if (!page.__playwrightMcpShimConsoleEvents) {
          const state = { console: [], pageErrors: [] };
          Object.defineProperty(page, '__playwrightMcpShimConsoleEvents', {
            value: state,
            configurable: true
          });
          page.on('console', (message) => {
            state.console.push({
              type: message.type(),
              text: message.text(),
              location: message.location()
            });
            if (state.console.length > 200) state.console.shift();
          });
          page.on('pageerror', (error) => {
            state.pageErrors.push({
              name: error.name,
              message: error.message,
              stack: error.stack
            });
            if (state.pageErrors.length > 200) state.pageErrors.shift();
          });
        }
      }`,
    });
  }

  /**
   * Starts one lazy background poll for reconstructible events. Request and
   * response both fire when Resource Timing reports completion; console and
   * pageerror drain a native listener queue installed in the MCP process.
   */
  on(event: string, handler: (arg: unknown) => void): void {
    if (!['request', 'response', 'console', 'pageerror', 'load', 'popup', 'download', 'filechooser'].includes(event)) return;
    const isNetworkEvent = event === 'request' || event === 'response';
    const isConsoleEvent = event === 'console' || event === 'pageerror';
    const hadNetworkListeners =
      (this.eventListeners.get('request')?.length ?? 0) + (this.eventListeners.get('response')?.length ?? 0) > 0;
    const hadLoadListeners = (this.eventListeners.get('load')?.length ?? 0) > 0;
    const hadConsoleListeners =
      (this.eventListeners.get('console')?.length ?? 0) + (this.eventListeners.get('pageerror')?.length ?? 0) > 0;
    const list = this.eventListeners.get(event) ?? [];
    list.push(handler);
    this.eventListeners.set(event, list);
    if (isConsoleEvent && !hadConsoleListeners) {
      // Retained-message polling below remains a compatibility fallback when
      // an older/custom MCP server does not expose the unsafe native bridge.
      const baseline = this.installNativeConsoleEventBridge().catch(() => {});
      this.consoleListenerReady = baseline;
      void baseline
        .finally(() => {
          if (this.consoleListenerReady === baseline) this.consoleListenerReady = null;
          this.ensureResourcePolling();
        })
        .catch(() => {});
    } else if (event === 'load' && !hadLoadListeners) {
      const baseline = this.primeLoadDocument();
      this.loadListenerReady = baseline;
      void baseline
        .finally(() => {
          if (this.loadListenerReady === baseline) this.loadListenerReady = null;
          this.ensureResourcePolling();
        })
        .catch(() => {});
    } else if (isNetworkEvent && !hadNetworkListeners) {
      const baseline = this.primeNetworkHistory();
      this.networkListenerReady = baseline;
      void baseline
        .finally(() => {
          if (this.networkListenerReady === baseline) this.networkListenerReady = null;
          this.ensureResourcePolling();
        })
        .catch(() => {});
    } else {
      this.ensureResourcePolling();
    }
  }
  once(event: string, handler: (arg: unknown) => void): void {
    if (!['request', 'response', 'console', 'pageerror', 'load', 'popup', 'download', 'filechooser'].includes(event)) return;
    const wrapped = (arg: unknown) => {
      this.off(event, wrapped);
      handler(arg);
    };
    this.on(event, wrapped);
  }
  off(event: string, handler: (arg: unknown) => void): void {
    const list = this.eventListeners.get(event);
    if (!list) return;
    this.eventListeners.set(
      event,
      list.filter((h) => h !== handler),
    );
  }
  /** Node's EventEmitter-style aliases — Playwright's Page mixes in EventEmitter, so both spellings are valid call sites. */
  addListener(event: string, handler: (arg: unknown) => void): void {
    this.on(event, handler);
  }
  removeListener(event: string, handler: (arg: unknown) => void): void {
    this.off(event, handler);
  }

  private ensureResourcePolling(): void {
    if (this.resourcePollTimer) return;
    const poll = () => void this.pollEvents();
    this.resourcePollTimer = setInterval(poll, 200);
    poll();
  }

  private async readTabUrls(): Promise<string[]> {
    const raw = textFromResult(
      await this.client.callTool('browser_run_code_unsafe', {
        code: `async (page) => page.context().pages().map((candidate) => candidate.url())`,
      }),
    );
    const value = JSON.parse(extractMcpResult(raw)) as unknown;
    return Array.isArray(value) ? value.map(String) : [];
  }

  /** Capture popup/download/filechooser events atomically with the click that triggers them. */
  private async clickAndCapturePendingPopup(target: string, options?: ClickOptions): Promise<boolean> {
    if (!this.popupWaiters.size && !this.downloadWaiters.size && !this.fileChooserWaiters.size) return false;
    const event = this.popupWaiters.size ? 'popup' : this.downloadWaiters.size ? 'download' : 'filechooser';
    const waiters =
      event === 'popup'
        ? this.popupWaiters
        : event === 'download'
          ? this.downloadWaiters
          : this.fileChooserWaiters;
    const deadline = Math.min(...[...waiters].map((waiter) => waiter.deadline));
    const eventTimeout = Number.isFinite(deadline) ? Math.max(1, deadline - Date.now()) : 0;
    const clickTimeout = Number.isFinite(deadline)
      ? Math.min(options?.timeout ?? eventTimeout, eventTimeout)
      : options?.timeout;
    const clickOptions = {
      button: options?.button,
      clickCount: options?.clickCount,
      force: options?.force,
      timeout: clickTimeout,
    };
    const raw = textFromResult(
      await this.client.callTool('browser_run_code_unsafe', {
        code: `async (page) => {
          const [result] = await Promise.all([
            page.waitForEvent(${JSON.stringify(event)}, { timeout: ${eventTimeout} }),
            page.locator(${JSON.stringify(target)}).click(${JSON.stringify(clickOptions)})
          ]);
          if (${JSON.stringify(event)} === 'popup') {
            const pages = page.context().pages();
            return { event: 'popup', index: pages.indexOf(result), url: result.url() };
          }
          if (${JSON.stringify(event)} === 'filechooser') {
            return { event: 'filechooser', multiple: result.isMultiple() };
          }
          return {
            event: 'download',
            url: result.url(),
            suggestedFilename: result.suggestedFilename()
          };
        }`,
      }),
    );
    if (event === 'filechooser' && raw.includes('[File chooser]')) {
      this.emitEvent('filechooser', this.fileChooserFacade(false));
      return true;
    }
    const extractedResult = extractMcpResult(raw);
    let parsedResult: unknown;
    try {
      parsedResult = JSON.parse(extractedResult);
    } catch (error) {
      throw new Error(`Failed to parse atomic ${event} result: ${raw}`, { cause: error });
    }
    const result = parsedResult as
      | { event: 'popup'; index: number; url: string }
      | { event: 'download'; url: string; suggestedFilename: string }
      | { event: 'filechooser'; multiple: boolean };
    if (result.event === 'popup') {
      if (result.index >= 0) this.knownTabCount = Math.max(this.knownTabCount, result.index + 1);
      this.tabCoordinator.activeIndex = undefined;
      this.emitEvent('popup', this.pageForTab(result.index, result.url));
    } else if (result.event === 'download') {
      this.emitEvent('download', {
        url: () => result.url,
        suggestedFilename: () => result.suggestedFilename,
      });
    } else {
      this.emitEvent('filechooser', this.fileChooserFacade(result.multiple));
    }
    return true;
  }

  private fileChooserFacade(multiple: boolean) {
    return {
      isMultiple: (): boolean => multiple,
      page: (): ShimPage => this,
      setFiles: async (
        files: string | string[] | { name: string; mimeType: string; buffer: string } | Array<{ name: string; mimeType: string; buffer: string }>,
        options?: { timeout?: number; noWaitAfter?: boolean },
      ): Promise<void> => {
        const entries = Array.isArray(files) ? files : [files];
        if (!entries.every((entry) => typeof entry === 'string')) {
          throw new Error('FileChooser.setFiles() currently supports filesystem paths over the MCP transport.');
        }
        await this.client.callTool(
          'browser_file_upload',
          {
            paths: entries,
          },
          options?.timeout && options.timeout > 0 ? { timeoutMs: options.timeout + 5_000 } : undefined,
        );
      },
    };
  }

  private pollEvents(): Promise<void> {
    if (this.eventPollPromise) return this.eventPollPromise;
    const poll = this.pollEventsOnce();
    this.eventPollPromise = poll;
    void poll
      .finally(() => {
        if (this.eventPollPromise === poll) this.eventPollPromise = null;
      })
      .catch(() => {});
    return poll;
  }

  private async pollEventsOnce(): Promise<void> {
    try {
      await this.replayObservedRouteRequests();
      if (this.eventListeners.get('load')?.length) {
        await this.loadListenerReady;
        try {
          const state = await this.readDocumentState();
          if (this.currentDocumentId === null) {
            this.currentDocumentId = state.id;
            this.lastKnownUrl = state.url;
          } else if (state.id !== this.currentDocumentId && state.readyState === 'complete') {
            this.currentDocumentId = state.id;
            this.lastKnownUrl = state.url;
            this.emitEvent('load', this);
          }
        } catch {
          // A document can be briefly unavailable while navigation commits.
        }
      }

      if (this.eventListeners.get('popup')?.length) {
        try {
          const urls = await this.readTabUrls();
          for (let index = this.knownTabCount; index < urls.length; index++) {
            this.emitEvent('popup', this.pageForTab(index, urls[index]!));
          }
          this.knownTabCount = Math.max(this.knownTabCount, urls.length);
        } catch {
          // Older MCP servers may not expose the Playwright-code tool.
        }
      }

      if ((this.eventListeners.get('request')?.length ?? 0) || (this.eventListeners.get('response')?.length ?? 0)) {
        await this.waitForEventBaselines();
        let usedRetainedNetworkLog = false;
        try {
          if (await this.hasTool('browser_network_requests')) {
            usedRetainedNetworkLog = true;
            const text = textFromResult(await this.client.callTool('browser_network_requests', { static: true }));
            for (const { index, method, url, status } of parseRetainedNetworkLog(text)) {
              if (!this.seenNetworkRequestIndexes.has(index)) {
                let postData: string | null = null;
                if (method !== 'GET' && method !== 'HEAD') {
                  try {
                    const raw = textFromResult(await this.client.callTool('browser_network_request', { index, part: 'request-body' }));
                    postData = extractMcpResult(raw);
                  } catch {
                    if (status === undefined) continue;
                  }
                }
                this.seenNetworkRequestIndexes.add(index);
                const isNavigationRequest = method !== 'GET' || url === this.lastKnownUrl;
                const resourceType = /^wss?:/i.test(url) ? 'websocket' : isNavigationRequest ? 'document' : 'fetch';
                this.emitEvent(
                  'request',
                  this.retainedRequest(
                    { index, method, url, status },
                    postData,
                    isNavigationRequest,
                    resourceType,
                  ),
                );
              }
              if (status !== undefined && !this.seenNetworkResponseIndexes.has(index)) {
                this.seenNetworkResponseIndexes.add(index);
                this.emitEvent('response', {
                  _index: index,
                  url: () => url,
                  status: () => status,
                  ok: () => status >= 200 && status < 400,
                  headers: () => ({}),
                  allHeaders: async () => ({}),
                });
              }
            }
          }
        } catch {
          // Fall back to Resource Timing below.
          usedRetainedNetworkLog = false;
        }
        if (!usedRetainedNetworkLog) {
          try {
            const entries = (await evalGlobal(this.client, `() => performance.getEntriesByType('resource').map((e) => ({ url: e.name, status: e.responseStatus || 0 }))`)) as Array<{
              url: string;
              status: number;
            }>;
            for (const entry of entries) {
              if (this.seenResourceUrls.has(entry.url)) continue;
              this.seenResourceUrls.add(entry.url);
              const status = entry.status || 200;
              this.emitEvent('request', {
                url: () => entry.url,
                method: () => 'GET',
                headers: () => ({}),
                allHeaders: async () => ({}),
                headerValue: async () => null,
                isNavigationRequest: () => entry.url === this.lastKnownUrl,
                resourceType: () => (entry.url === this.lastKnownUrl ? 'document' : 'fetch'),
                postData: () => null,
                postDataJSON: () => null,
              });
              this.emitEvent('response', {
                url: () => entry.url,
                status: () => status,
                ok: () => status < 400,
                headers: () => ({}),
                allHeaders: async () => ({}),
              });
            }
          } catch {
            // Page mid-navigation or similar transient state; try again next tick.
          }
        }
      }

      if ((this.eventListeners.get('console')?.length ?? 0) || (this.eventListeners.get('pageerror')?.length ?? 0)) {
        let usedNativeBridge = false;
        try {
          await this.consoleListenerReady;
          const raw = textFromResult(
            await this.client.callTool('browser_run_code_unsafe', {
              code: `async (page) => {
                const state = page.__playwrightMcpShimConsoleEvents;
                if (!state) return null;
                return {
                  console: state.console.splice(0),
                  pageErrors: state.pageErrors.splice(0)
                };
              }`,
            }),
          );
          const drained = JSON.parse(extractMcpResult(raw)) as
            | {
                console: Array<{
                  type: string;
                  text: string;
                  location?: { url?: string; lineNumber?: number; columnNumber?: number };
                }>;
                pageErrors: Array<{ name?: string; message: string; stack?: string }>;
              }
            | null;
          if (drained) {
            usedNativeBridge = true;
            for (const message of drained.console) {
              const entry = {
                type: () => message.type,
                text: () => message.text,
                location: () => ({
                  url: message.location?.url ?? '',
                  lineNumber: message.location?.lineNumber ?? 0,
                  columnNumber: message.location?.columnNumber ?? 0,
                }),
              };
              for (const handler of this.eventListeners.get('console') ?? []) handler(entry);
            }
            for (const entry of drained.pageErrors) {
              const error = Object.assign(new Error(entry.message), {
                name: entry.name ?? 'Error',
                stack: entry.stack,
              });
              for (const handler of this.eventListeners.get('pageerror') ?? []) handler(error);
            }
          }
        } catch {
          // Fall back to the retained console-message tool below.
        }

        if (!usedNativeBridge) {
          try {
            const text = textFromResult(await this.client.callTool('browser_console_messages', { level: 'debug', all: true }));
            const lines = text.split('\n');
            const consoleEntries = lines.flatMap((line) => {
              const match = /^(?:\[\s*\d+ms\]\s*)?\[([A-Z]+)\] (.*) @ (.*):(\d+)$/.exec(line);
              if (!match) return [];
              const [, rawType, message, url, lineNumber] = match;
              return [
                {
                  type: () => rawType!.toLowerCase(),
                  text: () => message!,
                  location: () => ({ url: url!, lineNumber: Number(lineNumber), columnNumber: 0 }),
                },
              ];
            });
            for (const entry of consoleEntries.slice(this.seenConsoleEntries)) {
              for (const handler of this.eventListeners.get('console') ?? []) handler(entry);
            }
            this.seenConsoleEntries = consoleEntries.length;

            const pageErrors = parsePageErrorMessages(lines);
            for (const message of pageErrors.slice(this.seenPageErrorEntries)) {
              const error = new Error(message);
              for (const handler of this.eventListeners.get('pageerror') ?? []) handler(error);
            }
            this.seenPageErrorEntries = pageErrors.length;
          } catch {
            // Older MCP servers may not expose either event source.
          }
        }
      }
    } finally {
      // Individual event sources are best-effort; the interval retries.
    }
  }

  /** Called by the `close()` wrapper factory.ts attaches — stops the background request/response poll started by `on()`. */
  stopEventPolling(): void {
    if (this.resourcePollTimer) clearInterval(this.resourcePollTimer);
    this.resourcePollTimer = null;
  }

  /** Releases temporary upload payloads once the owning browser page is done with them. */
  async cleanupTemporaryFiles(): Promise<void> {
    const cleanups = this.deferredCleanups.splice(0);
    await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
  }

  async emulateMedia(options?: { media?: 'screen' | 'print' | null; colorScheme?: 'dark' | 'light' | 'no-preference' | null; reducedMotion?: 'reduce' | 'no-preference' | null }): Promise<void> {
    await this.client.callTool('browser_run_code_unsafe', {
      code: `async (page) => { await page.emulateMedia(${JSON.stringify(options ?? {})}); }`,
    });
  }

  async setViewportSize(size: { width: number; height: number }): Promise<void> {
    await this.client.callTool('browser_resize', { width: size.width, height: size.height });
    this.lastKnownViewport = size;
  }

  /**
   * Real Playwright's is synchronous (cache-backed), same rationale as
   * `url()`. We only ever *learn* the viewport by an explicit
   * `setViewportSize()` call or a live query — `goto()` opportunistically
   * queries it once per navigation so a test that never calls
   * `setViewportSize()` still gets a real answer instead of `null`.
   */
  viewportSize(): { width: number; height: number } | null {
    return this.lastKnownViewport;
  }

  /**
   * Synchronous, like real Playwright's `page.url()` — returns the last
   * *known* URL rather than fetching fresh (real Playwright is also
   * cache-backed, just kept live via CDP events we don't have). The cache is
   * refreshed after every navigation/waitForURL/waitForNavigation call; a
   * client-side route change we didn't initiate (e.g. an in-page link click)
   * won't be reflected until the next such call. Assertions needing a fresh
   * read (`toHaveURL`) go through `currentUrl()` instead.
   */
  url(): string {
    return this.lastKnownUrl;
  }

  /** Always-fresh async URL read, used internally by matchers/waits where staleness would be wrong. */
  async currentUrl(): Promise<string> {
    return this.refreshUrl();
  }

  async title(): Promise<string> {
    return (await evalGlobal(this.client, '() => document.title')) as string;
  }

  async content(): Promise<string> {
    return (await evalGlobal(this.client, '() => document.documentElement.outerHTML')) as string;
  }

  async reload(options?: WaitForURLOptions): Promise<ShimResponse | null> {
    return this.nativeHistoryNavigation('reload', options);
  }

  async close(): Promise<void> {
    this.stopEventPolling();
    await this.cleanupTemporaryFiles();
    await this.client.callTool('browser_run_code_unsafe', {
      code: 'async (page) => { await page.close(); }',
    });
    this.tabCoordinator.pages.delete(this.tabIndex);
    this.tabCoordinator.activeIndex = undefined;
  }
}
