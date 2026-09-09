import { test, expect } from '@playwright/test';
import { McpPage } from '../../src/page.js';
import { toBeVisible } from '../../src/matchers.js';
import { FakeMcpToolClient, toolDef, textResult } from './helpers/fake-client.js';

const REGISTRY = { navigate: 'browser_navigate', snapshot: 'browser_snapshot', click: 'browser_click', type: 'browser_type' };

function makePage(pollingIntervalMs = 10, assertionTimeoutMs = 200) {
  const client = new FakeMcpToolClient(
    ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type'].map(toolDef),
    { browser_snapshot: () => textResult('### Snapshot\n```yaml\n\n```') },
  );
  return new McpPage(client, REGISTRY, { pollingIntervalMs, assertionTimeoutMs });
}

test.describe('toBeVisible', () => {
  test('passes once isVisible() flips to true within the timeout', async () => {
    const page = makePage();
    const locator = page.getByText('Saved');
    let calls = 0;
    locator.isVisible = async () => (++calls >= 3 ? true : false);

    const result = await toBeVisible(locator, true);
    expect(result.pass).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  test('fails with a descriptive message after the timeout elapses', async () => {
    const page = makePage(10, 50);
    const locator = page.getByText('Never appears');
    locator.isVisible = async () => false;

    const result = await toBeVisible(locator, true);
    expect(result.pass).toBe(false);
    expect(result.message()).toContain('Never appears');
  });

  test('an explicit options.timeout overrides the page default', async () => {
    const page = makePage(10, 5_000);
    const locator = page.getByText('Never appears');
    locator.isVisible = async () => false;

    const start = Date.now();
    const result = await toBeVisible(locator, true, { timeout: 60 });
    expect(result.pass).toBe(false);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  test('pass reflects the raw observed value, not whether it matched expectedVisible', async () => {
    // `pass` must be the raw fact ("is it visible"), never pre-negated —
    // index.ts's expect.extend relies on Playwright applying its own isNot XOR
    // on top of this. Requesting expectedVisible: false against an
    // already-invisible locator exits early, but still reports pass: false.
    const page = makePage();
    const locator = page.getByText('Gone');
    locator.isVisible = async () => false;

    const result = await toBeVisible(locator, false);
    expect(result.pass).toBe(false);
  });

  test('exits early once the observed value reaches expectedVisible, without waiting out the timeout', async () => {
    const page = makePage(10, 5_000);
    const locator = page.getByText('Gone');
    locator.isVisible = async () => false;

    const start = Date.now();
    const result = await toBeVisible(locator, false);
    expect(result.pass).toBe(false);
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});
