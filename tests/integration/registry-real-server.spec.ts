import { test, expect } from '@playwright/test';
import { createMcpToolClient } from '../../src/tool-client.js';
import { resolveRegistry } from '../../src/registry.js';
import { resolveManagedCommand } from '../../src/options.js';
import { MissingMcpToolError } from '../../src/errors.js';

// Exercises resolveRegistry against a real, freshly-spawned @playwright/mcp
// process (not a fake), to catch drift if a future server release renames or
// drops one of the tools DEFAULT_TOOL_CANDIDATES relies on.
test.describe('tool registry against a real @playwright/mcp process', () => {
  test('resolves every required and optional op from the real tool list', async () => {
    // Verify tools (verifyTextVisible/verifyElementVisible) are gated behind
    // the "testing" capability; without it they're absent and stay unresolved.
    const { command, args } = resolveManagedCommand({ capabilities: ['testing'] });
    const client = await createMcpToolClient({ transport: 'stdio', command, args });
    try {
      const tools = await client.listTools();
      const registry = resolveRegistry(tools, undefined);
      expect(registry).toEqual({
        navigate: 'browser_navigate',
        snapshot: 'browser_snapshot',
        click: 'browser_click',
        type: 'browser_type',
        screenshot: 'browser_take_screenshot',
        verifyTextVisible: 'browser_verify_text_visible',
        verifyElementVisible: 'browser_verify_element_visible',
      });
    } finally {
      await client.close?.();
    }
  });

  test('an override naming a tool the server does not expose fails fast', async () => {
    const { command, args } = resolveManagedCommand({});
    const client = await createMcpToolClient({ transport: 'stdio', command, args });
    try {
      const tools = await client.listTools();
      expect(() => resolveRegistry(tools, { click: 'nonexistent_click_tool' })).toThrow(MissingMcpToolError);
    } finally {
      await client.close?.();
    }
  });
});
