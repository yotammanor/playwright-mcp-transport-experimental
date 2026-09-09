import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { resolveManagedCommand, resolveToolNames } from '../../src/options.js';

test.describe('resolveManagedCommand', () => {
  test('defaults to invoking the locally-installed MCP server with headless mode and isolation', () => {
    // Avoids `npx @playwright/mcp@latest` re-resolving against the npm registry on every spawn.
    const { command, args } = resolveManagedCommand({});
    expect(command).toBe(process.execPath);
    expect(args[0]).toMatch(/@playwright[\\/]mcp[\\/]cli\.js$/);
    expect(args.slice(1)).toEqual(['--headless', '--snapshot-mode=none', '--isolated']);
  });

  test('omits --headless when headless: false', () => {
    const { args } = resolveManagedCommand({ headless: false });
    expect(args).not.toContain('--headless');
  });

  test('omits --isolated when isolated: false', () => {
    const { args } = resolveManagedCommand({ isolated: false });
    expect(args).not.toContain('--isolated');
  });

  test('adds --browser and --caps flags', () => {
    const { args } = resolveManagedCommand({ browser: 'firefox', capabilities: ['testing', 'pdf'] });
    expect(args.slice(1)).toEqual(['--headless', '--snapshot-mode=none', '--browser=firefox', '--caps=testing,pdf', '--isolated']);
  });

  test('explicit args wins over convenience options', () => {
    const { args } = resolveManagedCommand({ args: ['@playwright/mcp@latest', '--port=1234'], headless: false, browser: 'firefox' });
    expect(args).toEqual(['@playwright/mcp@latest', '--port=1234']);
  });

  test('respects a custom command binary, and skips the local-script shortcut', () => {
    const { command, args } = resolveManagedCommand({ command: 'pnpm' });
    expect(command).toBe('pnpm');
    expect(args[0]).toBe('@playwright/mcp@latest');
  });

  test('materializes context options and exposes cleanup for the temporary config', () => {
    const resolved = resolveManagedCommand({
      contextOptions: { locale: 'fr-FR', viewport: { width: 900, height: 600 } },
    });
    const configPath = resolved.args.find((arg) => arg.startsWith('--config='))?.slice('--config='.length);
    expect(configPath).toBeTruthy();
    expect(JSON.parse(readFileSync(configPath!, 'utf-8'))).toEqual({
      browser: {
        contextOptions: { locale: 'fr-FR', viewport: { width: 900, height: 600 } },
      },
    });

    resolved.cleanup?.();
    expect(existsSync(configPath!)).toBe(false);
  });
});

test.describe('resolveToolNames', () => {
  test('passes overrides through unchanged', () => {
    expect(resolveToolNames({ click: 'custom_click' })).toEqual({ click: 'custom_click' });
  });

  test('defaults to an empty object', () => {
    expect(resolveToolNames(undefined)).toEqual({});
  });
});
