import { test, expect } from '@playwright/test';
import type { McpToolClient } from '../../src/tool-client.js';
import { ShimPage } from '../../src/shim/page.js';

const client = {} as McpToolClient;

test.describe('shim selector construction', () => {
  test('getByLabel preserves label association semantics and regular expressions', () => {
    const page = new ShimPage(client);
    expect(page.getByLabel('Like').selector).toBe('internal:label="Like"i');
    expect(page.getByLabel(/alternate email/i).selector).toBe('internal:label=/alternate email/i');
  });

  test('getByRole accepts a regular-expression accessible name', () => {
    const page = new ShimPage(client);
    expect(page.getByRole('link', { name: /^30 min/ }).selector).toBe('role=link[name=/^30 min/]');
  });

  test('locator options encode text and nested-locator filters', () => {
    const page = new ShimPage(client);
    const button = page.getByLabel('Like');

    expect(button.page()).toBe(page);
    expect(page.locator('astro-island', { has: button }).selector).toBe(
      'astro-island >> internal:has="internal:label=\\"Like\\"i"',
    );
    expect(page.locator('button', { hasText: 'Save' }).selector).toBe('button >> internal:has-text="Save"i');
    const filtered = page.locator('section').filter({ has: button });
    expect(filtered.selector).toBe(
      'section >> internal:has="internal:label=\\"Like\\"i"',
    );
    expect(filtered.page()).toBe(page);
  });

  test('frameLocator enters the selected frame before chaining', () => {
    const page = new ShimPage(client);
    expect(page.frameLocator('iframe').locator('h1').selector).toBe('iframe >> internal:control=enter-frame >> h1');
    expect(page.locator('.payment').frameLocator('iframe').getByText('Pay').selector).toBe(
      '.payment >> iframe >> internal:control=enter-frame >> text=Pay',
    );
  });
});
