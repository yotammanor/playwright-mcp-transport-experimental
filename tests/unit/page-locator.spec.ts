import { test, expect } from '@playwright/test';
import { McpPage } from '../../src/page.js';
import { LocatorResolutionError, McpToolCallError, NoMcpToolClientError } from '../../src/errors.js';
import { FakeMcpToolClient, toolDef, textResult } from './helpers/fake-client.js';

const FULL_TOOLS = [
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_verify_text_visible',
  'browser_verify_element_visible',
].map(toolDef);

const FULL_REGISTRY = {
  navigate: 'browser_navigate',
  snapshot: 'browser_snapshot',
  click: 'browser_click',
  type: 'browser_type',
  verifyTextVisible: 'browser_verify_text_visible',
  verifyElementVisible: 'browser_verify_element_visible',
} as const;

const SNAPSHOT_BEFORE_SAVE = `### Snapshot
\`\`\`yaml
- generic [ref=e1]:
  - heading "Hello from MCP" [level=1] [ref=e2]
  - button "Save" [ref=e4]
  - textbox "Your name" [ref=e5]
\`\`\``;

const SNAPSHOT_AFTER_SAVE = `### Snapshot
\`\`\`yaml
- generic [ref=e1]:
  - heading "Hello from MCP" [level=1] [ref=e2]
  - button "Save" [ref=e4]
  - paragraph [ref=e6]: Saved
  - textbox "Your name" [ref=e5]: Ada
\`\`\``;

const AMBIGUOUS_SNAPSHOT = `### Snapshot
\`\`\`yaml
- generic [ref=e1]:
  - button "Save" [ref=e4]
  - button "Save" [ref=e7]
\`\`\``;

function makeClient(tools = FULL_TOOLS) {
  let currentSnapshot = SNAPSHOT_BEFORE_SAVE;
  const client = new FakeMcpToolClient(tools, {
    browser_navigate: () => textResult('navigated'),
    browser_snapshot: () => textResult(currentSnapshot),
    browser_click: (args) => {
      if (args.target === 'e4') currentSnapshot = SNAPSHOT_AFTER_SAVE;
      return textResult('clicked');
    },
    browser_type: () => {
      currentSnapshot = SNAPSHOT_AFTER_SAVE;
      return textResult('typed');
    },
    browser_verify_text_visible: (args) => {
      if (currentSnapshot === SNAPSHOT_AFTER_SAVE && args.text === 'Saved') return textResult('Done');
      throw new McpToolCallError('browser_verify_text_visible', 'Text not found');
    },
    browser_verify_element_visible: (args) => {
      if (args.role === 'button' && args.accessibleName === 'Save') return textResult('Done');
      throw new McpToolCallError('browser_verify_element_visible', 'Element not found');
    },
  });
  return { client, setSnapshot: (s: string) => (currentSnapshot = s) };
}

test.describe('McpPage snapshot caching', () => {
  test('caches the snapshot until refresh is requested', async () => {
    const { client } = makeClient();
    const page = new McpPage(client, FULL_REGISTRY);
    await page.snapshot();
    await page.snapshot();
    expect(client.calls.filter((c) => c.name === 'browser_snapshot')).toHaveLength(1);

    await page.snapshot({ refresh: true });
    expect(client.calls.filter((c) => c.name === 'browser_snapshot')).toHaveLength(2);
  });

  test('navigate invalidates the cached snapshot', async () => {
    const { client } = makeClient();
    const page = new McpPage(client, FULL_REGISTRY);
    await page.snapshot();
    await page.navigate('http://localhost:4123');
    await page.snapshot();
    expect(client.calls.filter((c) => c.name === 'browser_snapshot')).toHaveLength(2);
    expect(client.calls[0]).toEqual({ name: 'browser_snapshot', args: {} });
    expect(client.calls[1]).toEqual({ name: 'browser_navigate', args: { url: 'http://localhost:4123' } });
  });
});

test.describe('McpLocator resolution', () => {
  test('click() resolves the ref by role+name and passes it as target', async () => {
    const { client } = makeClient();
    const page = new McpPage(client, FULL_REGISTRY);
    await page.getByRole('button', { name: 'Save' }).click();
    const click = client.calls.find((c) => c.name === 'browser_click');
    expect(click?.args).toEqual({ element: 'role=button name="Save"', target: 'e4' });
  });

  test('fill() resolves by role and calls the type tool', async () => {
    const { client } = makeClient();
    const page = new McpPage(client, FULL_REGISTRY);
    await page.getByRole('textbox', { name: 'Your name' }).fill('Ada');
    const typeCall = client.calls.find((c) => c.name === 'browser_type');
    expect(typeCall?.args).toEqual({ element: 'role=textbox name="Your name"', target: 'e5', text: 'Ada' });
  });

  test('getByText resolves against value or accessible name', async () => {
    const { client, setSnapshot } = makeClient();
    setSnapshot(SNAPSHOT_AFTER_SAVE);
    const page = new McpPage(client, FULL_REGISTRY);
    const ref = await page.getByText('Saved').tryResolveRef();
    expect(ref).toBe('e6');
  });

  test('throws LocatorResolutionError when nothing matches', async () => {
    const { client } = makeClient();
    const page = new McpPage(client, FULL_REGISTRY);
    await expect(page.getByText('Does not exist').click()).rejects.toThrow(LocatorResolutionError);
  });

  test('throws LocatorResolutionError (ambiguous) when more than one node matches', async () => {
    const { client, setSnapshot } = makeClient();
    setSnapshot(AMBIGUOUS_SNAPSHOT);
    const page = new McpPage(client, FULL_REGISTRY);
    await expect(page.getByRole('button', { name: 'Save' }).click()).rejects.toThrow(/ambiguous/);
  });
});

test.describe('McpLocator.isVisible', () => {
  test('uses verifyTextVisible when the op is resolved', async () => {
    const { client, setSnapshot } = makeClient();
    setSnapshot(SNAPSHOT_AFTER_SAVE);
    const page = new McpPage(client, FULL_REGISTRY);
    expect(await page.getByText('Saved').isVisible()).toBe(true);
    expect(await page.getByText('Nope').isVisible()).toBe(false);
    expect(client.calls.some((c) => c.name === 'browser_verify_text_visible')).toBe(true);
  });

  test('uses verifyElementVisible for role locators when resolved', async () => {
    const { client } = makeClient();
    const page = new McpPage(client, FULL_REGISTRY);
    expect(await page.getByRole('button', { name: 'Save' }).isVisible()).toBe(true);
    expect(await page.getByRole('button', { name: 'Nonexistent' }).isVisible()).toBe(false);
  });

  test('falls back to snapshot presence when verify tools are unresolved', async () => {
    const minimalTools = ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type'].map(toolDef);
    const { client } = makeClient(minimalTools);
    const registry = { navigate: 'browser_navigate', snapshot: 'browser_snapshot', click: 'browser_click', type: 'browser_type' };
    const page = new McpPage(client, registry);
    expect(await page.getByRole('button', { name: 'Save' }).isVisible()).toBe(true);
    expect(await page.getByText('Nope').isVisible()).toBe(false);
    expect(client.calls.some((c) => c.name.startsWith('browser_verify'))).toBe(false);
  });
});

test.describe('McpPage.callTool', () => {
  test('throws NoMcpToolClientError for an unresolved op', async () => {
    const { client } = makeClient();
    const page = new McpPage(client, { navigate: 'browser_navigate' });
    await expect(page.callTool('click', {})).rejects.toThrow(NoMcpToolClientError);
  });
});
