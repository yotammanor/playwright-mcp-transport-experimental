import { test, expect } from './fixture.js';

test.describe('McpPage driving a real @playwright/mcp server', () => {
  test('navigate, read the initial snapshot, and see the heading', async ({ mcpPage, fixturesUrl }) => {
    await mcpPage.navigate(`${fixturesUrl}/form.html`);
    await expect(mcpPage.getByRole('heading', { name: 'MCP Integration Fixture' })).toBeVisible();
  });

  test('fill + click round-trips through the real DOM', async ({ mcpPage, fixturesUrl }) => {
    await mcpPage.navigate(`${fixturesUrl}/form.html`);
    await mcpPage.getByRole('textbox', { name: 'Your name' }).fill('Ada');
    await mcpPage.getByRole('button', { name: 'Save' }).click();
    await expect(mcpPage.getByText('Saved: Ada')).toBeVisible();
  });

  test('toBeVisible times out for text that never appears', async ({ mcpPage, fixturesUrl }) => {
    await mcpPage.navigate(`${fixturesUrl}/form.html`);
    await expect(expect(mcpPage.getByText('Nonexistent Text XYZ')).toBeVisible({ timeout: 1_000 })).rejects.toThrow();
  });

  test('.not.toBeVisible() passes for text that is absent', async ({ mcpPage, fixturesUrl }) => {
    await mcpPage.navigate(`${fixturesUrl}/form.html`);
    await expect(mcpPage.getByText('Nonexistent Text XYZ')).not.toBeVisible({ timeout: 1_000 });
  });

  test('clicking re-resolves refs instead of reusing a stale one', async ({ mcpPage, fixturesUrl }) => {
    await mcpPage.navigate(`${fixturesUrl}/form.html`);
    const saveButton = mcpPage.getByRole('button', { name: 'Save' });
    await saveButton.click();
    await expect(mcpPage.getByText('Saved:')).toBeVisible();
    // Re-navigating invalidates every previously-resolved ref; the locator must
    // still work because it re-resolves against a fresh snapshot each call.
    await mcpPage.navigate(`${fixturesUrl}/form.html`);
    await saveButton.click();
    await expect(mcpPage.getByText('Saved:')).toBeVisible();
  });
});

