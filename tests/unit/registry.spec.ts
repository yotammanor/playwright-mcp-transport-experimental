import { test, expect } from '@playwright/test';
import { resolveRegistry } from '../../src/registry.js';
import { MissingMcpToolError } from '../../src/errors.js';
import { toolDef } from './helpers/fake-client.js';

const FULL_TOOL_SET = [
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_take_screenshot',
  'browser_verify_text_visible',
  'browser_verify_element_visible',
].map(toolDef);

test.describe('resolveRegistry', () => {
  test('resolves every op against a full tool set', () => {
    const registry = resolveRegistry(FULL_TOOL_SET, undefined);
    expect(registry).toEqual({
      navigate: 'browser_navigate',
      snapshot: 'browser_snapshot',
      click: 'browser_click',
      type: 'browser_type',
      screenshot: 'browser_take_screenshot',
      verifyTextVisible: 'browser_verify_text_visible',
      verifyElementVisible: 'browser_verify_element_visible',
    });
  });

  test('leaves optional ops unresolved when the server does not expose them', () => {
    const minimal = ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type'].map(toolDef);
    const registry = resolveRegistry(minimal, undefined);
    expect(registry.screenshot).toBeUndefined();
    expect(registry.verifyTextVisible).toBeUndefined();
  });

  test('falls back to the second candidate for an op (browser_fill for type)', () => {
    const tools = ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_fill'].map(toolDef);
    const registry = resolveRegistry(tools, undefined);
    expect(registry.type).toBe('browser_fill');
  });

  test('an explicit override wins over the default candidates when the server exposes it', () => {
    const tools = [...FULL_TOOL_SET, toolDef('acme_custom_click')];
    const registry = resolveRegistry(tools, { click: 'acme_custom_click' });
    expect(registry.click).toBe('acme_custom_click');
  });

  test('throws MissingMcpToolError naming the missing required op and available tools', () => {
    const tools = ['browser_navigate', 'browser_snapshot'].map(toolDef);
    expect(() => resolveRegistry(tools, undefined)).toThrow(MissingMcpToolError);
    try {
      resolveRegistry(tools, undefined);
      throw new Error('expected resolveRegistry to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingMcpToolError);
      expect((err as Error).message).toContain('click');
      expect((err as Error).message).toContain('type');
      expect((err as Error).message).toContain('browser_navigate');
    }
  });

  test('an override that the server does not expose still fails required-op resolution', () => {
    const tools = ['browser_navigate', 'browser_snapshot', 'browser_type'].map(toolDef);
    expect(() => resolveRegistry(tools, { click: 'nonexistent_click' })).toThrow(MissingMcpToolError);
  });
});
