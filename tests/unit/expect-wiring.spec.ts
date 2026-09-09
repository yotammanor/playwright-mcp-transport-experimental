import { test as base } from '@playwright/test';
import { expect } from '../../src/index.js';
import { McpPage } from '../../src/page.js';
import { FakeMcpToolClient, toolDef, textResult } from './helpers/fake-client.js';

const REGISTRY = { navigate: 'browser_navigate', snapshot: 'browser_snapshot', click: 'browser_click', type: 'browser_type' };

function makePage() {
  const client = new FakeMcpToolClient(
    ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type'].map(toolDef),
    { browser_snapshot: () => textResult('### Snapshot\n```yaml\n\n```') },
  );
  return new McpPage(client, REGISTRY, { pollingIntervalMs: 10, assertionTimeoutMs: 200 });
}

// Regression coverage for a real bug: index.ts's expect.extend passed `!this.isNot`
// as expectedVisible but matchers.ts also returned pass pre-negated toward that
// target, so Playwright's own isNot XOR double-negated the result and
// `.not.toBeVisible()` failed for genuinely-invisible locators.
base.describe('expect(locator).toBeVisible() wiring', () => {
  base('passes when the locator is visible', async () => {
    const page = makePage();
    const locator = page.getByText('Present');
    locator.isVisible = async () => true;
    await expect(locator).toBeVisible();
  });

  base('.not.toBeVisible() passes when the locator is absent', async () => {
    const page = makePage();
    const locator = page.getByText('Absent');
    locator.isVisible = async () => false;
    await expect(locator).not.toBeVisible();
  });

  base('.not.toBeVisible() fails when the locator is actually visible', async () => {
    const page = makePage();
    const locator = page.getByText('Present');
    locator.isVisible = async () => true;
    let threw = false;
    try {
      await expect(locator).not.toBeVisible({ timeout: 50 });
    } catch {
      threw = true;
    }
    base.expect(threw).toBe(true);
  });

  base('toBeVisible() fails when the locator never appears', async () => {
    const page = makePage();
    const locator = page.getByText('Never');
    locator.isVisible = async () => false;
    let threw = false;
    try {
      await expect(locator).toBeVisible({ timeout: 50 });
    } catch {
      threw = true;
    }
    base.expect(threw).toBe(true);
  });
});
