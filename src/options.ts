import { createRequire } from 'node:module';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpToolClient } from './tool-client.js';

/**
 * `npx @playwright/mcp@latest` re-resolves the "latest" tag against the npm
 * registry on *every single spawn* — with one managed server per test (see
 * shim/factory.ts), that's real per-test latency and an occasional source of
 * flakiness (observed: sporadic `MCP error -32000: Connection closed` under
 * many rapid sequential spawns). When this package is actually installed,
 * invoke its `cli.js` directly via `node` instead — same server, no registry
 * round-trip. `require.resolve` on the package's `package.json` (an allowed
 * export) sidesteps its `exports` map not listing `cli.js` directly.
 */
function resolveLocalMcpServerScript(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const pkgJsonPath = require.resolve('@playwright/mcp/package.json');
    return path.join(path.dirname(pkgJsonPath), 'cli.js');
  } catch {
    return undefined;
  }
}

export type McpServerMode = 'managed' | 'existing';

export type McpBrowserToolNames = {
  navigate: string;
  snapshot: string;
  click: string;
  type: string;
  screenshot: string;
  verifyTextVisible: string;
  verifyElementVisible: string;
};

/** Semantic op -> ordered list of tool-name candidates to try against the connected server. */
export const DEFAULT_TOOL_CANDIDATES: Record<keyof McpBrowserToolNames, string[]> = {
  navigate: ['browser_navigate'],
  snapshot: ['browser_snapshot'],
  click: ['browser_click'],
  type: ['browser_type', 'browser_fill'],
  screenshot: ['browser_take_screenshot'],
  verifyTextVisible: ['browser_verify_text_visible'],
  verifyElementVisible: ['browser_verify_element_visible'],
};

/** Ops the registry requires to resolve; missing ones fail fast at setup. */
export const REQUIRED_OPS: Array<keyof McpBrowserToolNames> = ['navigate', 'snapshot', 'click', 'type'];

export type McpTransportOptions = {
  mode?: McpServerMode;

  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  startupTimeoutMs?: number;

  headless?: boolean;
  browser?: 'chrome' | 'chromium' | 'firefox' | 'webkit' | string;
  /** Optional MCP capability groups to expose (for example network or storage). */
  capabilities?: string[];
  /** Spawns the managed server with `--isolated` (default true) so concurrent Playwright workers each get their own ephemeral browser profile instead of colliding on a shared user-data-dir. */
  isolated?: boolean;
  /**
   * Forwarded verbatim to `@playwright/mcp`'s `--config` file as
   * `browser.contextOptions` (the same shape as Playwright's own
   * `browser.newContext(options)`/a test project's `use: {...}` block) —
   * `timezoneId`, `locale`, `viewport`, `geolocation`, etc. The MCP server
   * otherwise launches its browser context with bare OS defaults, which
   * silently diverges from a target repo's configured test environment (e.g.
   * a `timezoneId` mismatch between the machine running the MCP server and a
   * project's configured one can trigger app-level UI, like a "confirm your
   * timezone" dialog, that a real Playwright-launched context would never
   * see, cascading into unrelated-looking failures downstream).
   */
  contextOptions?: Record<string, unknown>;

  serverName?: string;
  endpoint?: string;

  toolTimeoutMs?: number;
  assertionTimeoutMs?: number;
  pollingIntervalMs?: number;

  tools?: Partial<McpBrowserToolNames>;

  client?: McpToolClient;

  debug?: boolean;
};

export type McpOptions = {
  mcp: McpTransportOptions;
};

export const DEFAULT_MCP_OPTIONS: Required<
  Pick<McpTransportOptions, 'mode' | 'command' | 'args' | 'startupTimeoutMs' | 'toolTimeoutMs' | 'assertionTimeoutMs' | 'pollingIntervalMs'>
> = {
  mode: 'managed',
  command: 'npx',
  args: ['@playwright/mcp@latest', '--headless', '--snapshot-mode=none', '--isolated'],
  startupTimeoutMs: 60_000,
  toolTimeoutMs: 60_000,
  assertionTimeoutMs: 5_000,
  pollingIntervalMs: 100,
};

/**
 * Builds the managed-mode spawn command/args.
 * Explicit `args` always win; convenience options (headless/browser/capabilities)
 * are only converted to CLI flags when `args` was not provided.
 */
export function resolveManagedCommand(options: McpTransportOptions): {
  command: string;
  args: string[];
  cleanup?: () => void;
} {
  if (options.args) {
    return { command: options.command ?? DEFAULT_MCP_OPTIONS.command, args: options.args };
  }

  // Only take the direct-local-script shortcut when the caller hasn't named an
  // explicit command of their own to run @playwright/mcp through.
  const localScript = options.command ? undefined : resolveLocalMcpServerScript();
  const command = localScript ? process.execPath : (options.command ?? DEFAULT_MCP_OPTIONS.command);
  const args: string[] = localScript ? [localScript] : ['@playwright/mcp@latest'];

  const headless = options.headless ?? true;
  if (headless) args.push('--headless');
  // The shim never consumes MCP accessibility snapshots. Disabling them
  // avoids delaying action completion until after short-lived UI states have
  // disappeared, and removes substantial per-action serialization overhead.
  args.push('--snapshot-mode=none');
  if (options.browser) args.push(`--browser=${options.browser}`);
  const capabilities = options.capabilities ?? [];
  if (capabilities.length) args.push(`--caps=${capabilities.join(',')}`);
  if (options.isolated ?? true) args.push('--isolated');
  let cleanup: (() => void) | undefined;
  if (options.contextOptions) {
    const config = writeContextOptionsConfig(options.contextOptions);
    args.push(`--config=${config.path}`);
    cleanup = config.cleanup;
  }

  return { command, args, cleanup };
}

/** Materializes `--config`'s one-shot JSON file; `@playwright/mcp` only accepts a path, not inline JSON. */
function writeContextOptionsConfig(contextOptions: Record<string, unknown>): {
  path: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mcp-transport-config-'));
  const configPath = path.join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ browser: { contextOptions } }), 'utf-8');
  return {
    path: configPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function resolveToolNames(overrides: Partial<McpBrowserToolNames> | undefined): Partial<McpBrowserToolNames> {
  return { ...overrides };
}
