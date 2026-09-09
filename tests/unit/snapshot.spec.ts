import { test, expect } from '@playwright/test';
import { parseSnapshot, findByRole, findByText } from '../../src/snapshot.js';

// Captured verbatim from a real `browser_snapshot` call against @playwright/mcp.
const SAMPLE_SNAPSHOT = `### Page
- Page URL: http://localhost:4123/
- Page Title: MCP Smoke Test
### Snapshot
\`\`\`yaml
- generic [ref=e1]:
  - heading "Hello from MCP" [level=1] [ref=e2]
  - link "More information" [ref=e3] [cursor=pointer]:
    - /url: https://example.com
  - button "Save" [active] [ref=e4]
  - paragraph [ref=e6]: Saved
  - textbox "Your name" [ref=e5]: Ada
\`\`\`
`;

test.describe('parseSnapshot', () => {
  test('extracts role, name, ref and value for every node', () => {
    const nodes = parseSnapshot(SAMPLE_SNAPSHOT);
    expect(nodes.map((n) => [n.role, n.name, n.ref, n.value])).toEqual([
      ['generic', null, 'e1', null],
      ['heading', 'Hello from MCP', 'e2', null],
      ['link', 'More information', 'e3', null],
      ['button', 'Save', 'e4', null],
      ['paragraph', null, 'e6', 'Saved'],
      ['textbox', 'Your name', 'e5', 'Ada'],
    ]);
  });

  test('does not surface the /url child as a node (no ref)', () => {
    const nodes = parseSnapshot(SAMPLE_SNAPSHOT);
    expect(nodes.find((n) => n.role === '/url')).toBeUndefined();
  });

  test('returns an empty list for a page with no snapshot yet', () => {
    expect(parseSnapshot('### Page\n- Page URL: about:blank\n### Snapshot\n```yaml\n\n```')).toEqual([]);
  });
});

test.describe('findByRole', () => {
  const nodes = parseSnapshot(SAMPLE_SNAPSHOT);

  test('matches role + substring name by default', () => {
    expect(findByRole(nodes, 'button', { name: 'save' }).map((n) => n.ref)).toEqual(['e4']);
  });

  test('exact: true requires a full match', () => {
    expect(findByRole(nodes, 'button', { name: 'Sav', exact: true })).toEqual([]);
    expect(findByRole(nodes, 'button', { name: 'Save', exact: true }).map((n) => n.ref)).toEqual(['e4']);
  });

  test('role with no name filter matches every node of that role', () => {
    expect(findByRole(nodes, 'link').map((n) => n.ref)).toEqual(['e3']);
  });

  test('returns nothing for an unknown role', () => {
    expect(findByRole(nodes, 'checkbox')).toEqual([]);
  });
});

test.describe('findByText', () => {
  const nodes = parseSnapshot(SAMPLE_SNAPSHOT);

  test('matches against value for value-bearing nodes', () => {
    expect(findByText(nodes, 'Saved').map((n) => n.ref)).toEqual(['e6']);
  });

  test('matches against accessible name when there is no value', () => {
    expect(findByText(nodes, 'Hello from MCP').map((n) => n.ref)).toEqual(['e2']);
  });

  test('is case-insensitive and substring-based by default', () => {
    expect(findByText(nodes, 'HELLO from').map((n) => n.ref)).toEqual(['e2']);
  });

  test('a broad substring can match more than one node', () => {
    // "Save" is a substring of both the button's name and the "Saved" paragraph's value.
    expect(findByText(nodes, 'save').map((n) => n.ref).sort()).toEqual(['e4', 'e6']);
  });
});
