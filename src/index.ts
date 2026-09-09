import { test as base, expect as baseExpect } from '@playwright/test';
import { createMcpToolClient, type McpToolClient } from './tool-client.js';
import { DEFAULT_MCP_OPTIONS, resolveManagedCommand, type McpTransportOptions } from './options.js';
import { resolveRegistry } from './registry.js';
import { McpPage } from './page.js';
import { McpServerStartupError, NoMcpToolClientError } from './errors.js';
import { toBeVisible, type ToBeVisibleOptions } from './matchers.js';
import type { McpLocator } from './locator.js';

export type { McpTransportOptions } from './options.js';
export type { McpToolClient, McpToolDefinition, CreateMcpToolClientOptions } from './tool-client.js';
export { McpPage } from './page.js';
export { McpLocator } from './locator.js';
export * from './errors.js';

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

type McpFixtures = {
  mcpOptions: McpTransportOptions;
  mcpPage: McpPage;
};

export const test = base.extend<McpFixtures>({
  mcpOptions: [{}, { option: true }],

  mcpPage: async ({ mcpOptions }, use) => {
    let client: McpToolClient;
    let close: (() => Promise<void>) | undefined;

    if (mcpOptions.client) {
      client = mcpOptions.client;
    } else {
      const mode = mcpOptions.mode ?? DEFAULT_MCP_OPTIONS.mode;

      if (mode === 'existing') {
        if (!mcpOptions.endpoint) throw new NoMcpToolClientError();
        client = await createMcpToolClient({
          transport: 'http',
          endpoint: mcpOptions.endpoint,
          defaultToolTimeoutMs: mcpOptions.toolTimeoutMs ?? DEFAULT_MCP_OPTIONS.toolTimeoutMs,
        });
        close = async () => client.close?.();
      } else {
        const { command, args, cleanup } = resolveManagedCommand(mcpOptions);
        const startupTimeoutMs = mcpOptions.startupTimeoutMs ?? DEFAULT_MCP_OPTIONS.startupTimeoutMs;
        const startupController = new AbortController();
        let stderr = '';
        try {
          client = await withTimeout(
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
        close = async () => client.close?.();
      }
    }

    const tools = await client.listTools();
    const registry = resolveRegistry(tools, mcpOptions.tools);
    const page = new McpPage(client, registry, {
      toolTimeoutMs: mcpOptions.toolTimeoutMs,
      assertionTimeoutMs: mcpOptions.assertionTimeoutMs,
      pollingIntervalMs: mcpOptions.pollingIntervalMs,
    });

    await use(page);

    await close?.();
  },
});

/**
 * `expect` extended with `toBeVisible` for `McpLocator`. Scoped to this
 * package's own locator type, so it doesn't affect assertions on native
 * Playwright `Locator`/`Page` objects made through `@playwright/test`'s `expect`.
 */
export const expect = baseExpect.extend({
  async toBeVisible(locator: McpLocator, options?: ToBeVisibleOptions) {
    return toBeVisible(locator, !this.isNot, options);
  },
});

declare global {
  namespace PlaywrightTest {
    interface Matchers<R, T> {
      toBeVisible(this: T extends McpLocator ? unknown : never, options?: ToBeVisibleOptions): R;
    }
  }
}
