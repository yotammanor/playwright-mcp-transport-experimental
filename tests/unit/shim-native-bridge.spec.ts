import { expect, test } from '@playwright/test';
import { ShimPage } from '../../src/shim/page.js';
import { FakeMcpToolClient, textResult, toolDef } from './helpers/fake-client.js';

test.describe('ShimPage native Playwright bridge', () => {
  test('addInitScript forwards string content to the managed page', async () => {
    const client = new FakeMcpToolClient([toolDef('browser_run_code_unsafe')], {
      browser_run_code_unsafe: () => textResult('### Result\ntrue'),
    });
    const page = new ShimPage(client);

    await page.addInitScript('window.__shimInitValue = "ready";');

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.args.code).toContain(
      'page.addInitScript("window.__shimInitValue = \\"ready\\";")',
    );
  });

  test('clock.install delegates to the managed native page', async () => {
    const client = new FakeMcpToolClient([toolDef('browser_run_code_unsafe')], {
      browser_run_code_unsafe: () => textResult('### Result\ntrue'),
    });
    const page = new ShimPage(client);

    await page.clock.install({ time: '2026-01-02T03:04:05Z' });

    expect(client.calls[0]!.args.code).toContain(
      'page.clock.install({"time":"2026-01-02T03:04:05Z"})',
    );
  });

  test('console events install a persistent native listener in the MCP process', async () => {
    const client = new FakeMcpToolClient([toolDef('browser_run_code_unsafe')], {
      browser_run_code_unsafe: (args) =>
        textResult(
          String(args.code).includes('const state = page.__playwrightMcpShimConsoleEvents')
            ? '### Result\nnull'
            : '### Result\ntrue',
        ),
    });
    const page = new ShimPage(client);
    const message = { type: () => 'log', text: () => 'native-console-event' };

    const pending = page.waitForEvent(
      'console',
      (entry: { text(): string }) => entry.text() === 'native-console-event',
    );
    await page.waitForTimeout(5);
    (
      page as unknown as {
        emitEvent(event: string, value: unknown): void;
      }
    ).emitEvent('console', message);

    expect(await pending).toBe(message);
    expect(client.calls.some((call) => String(call.args.code).includes("page.on('console'"))).toBe(true);
    page.stopEventPolling();
  });

  test('route.request replays live metadata into observational continue handlers', async () => {
    let drained = false;
    const client = new FakeMcpToolClient([toolDef('browser_run_code_unsafe')], {
      browser_run_code_unsafe: (args) => {
        const code = String(args.code);
        if (!code.includes('const drained')) return textResult('### Result\ntrue');
        const requests = drained
          ? []
          : [
              {
                url: 'http://127.0.0.1/shim.html?route-observe=true',
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                isNavigationRequest: false,
                resourceType: 'fetch',
                postData: '{"routed":true}',
              },
            ];
        drained = true;
        return textResult(`### Result\n${JSON.stringify({ 'route-1': requests })}`);
      },
    });
    const page = new ShimPage(client);
    const observed: Array<{ method: string; contentType: string | undefined; data: unknown }> = [];

    await page.route('**/shim.html?route-observe=true', async (route) => {
      const request = route.request();
      observed.push({
        method: request.method(),
        contentType: request.headers()['content-type'],
        data: request.postDataJSON(),
      });
      await route.continue();
    });
    await page.waitForTimeout(0);

    expect(observed).toEqual([
      {
        method: 'POST',
        contentType: 'application/json',
        data: { routed: true },
      },
    ]);
  });

  test('stateful route handlers install their first two decisions in order', async () => {
    const client = new FakeMcpToolClient([toolDef('browser_run_code_unsafe')], {
      browser_run_code_unsafe: () => textResult('### Result\ntrue'),
    });
    const page = new ShimPage(client);
    let attempts = 0;

    await page.route('**/retry.js', async (route) => {
      attempts++;
      if (attempts === 1) await route.abort('failed');
      else await route.continue();
    });

    expect(attempts).toBe(2);
    const code = String(client.calls[0]!.args.code);
    expect(code).toContain('"action":"abort","errorCode":"failed"');
    expect(code).toContain('"action":"continue"');
  });
});
