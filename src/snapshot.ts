/**
 * Parses the accessibility-tree text `@playwright/mcp` returns from
 * `browser_snapshot` (and embeds in navigate/click/type results), e.g.:
 *
 *   - generic [active] [ref=e1]:
 *     - heading "Hello from MCP" [level=1] [ref=e2]
 *     - link "More information" [ref=e3] [cursor=pointer]:
 *       - /url: https://example.com
 *     - button "Save" [ref=e4]
 *     - paragraph [ref=e6]: Saved
 *     - textbox "Your name" [ref=e5]: Ada
 */

export type SnapshotNode = {
  role: string;
  name: string | null;
  value: string | null;
  ref: string | null;
  depth: number;
  raw: string;
};

const LINE_PATTERN = /^(\s*)-\s+([A-Za-z_][\w-]*)(?:\s+"((?:[^"\\]|\\.)*)")?((?:\s+\[[^\]]*\])*)\s*(?::\s*(.*))?$/;
// Refs are opaque IDs (typically "e1", but @playwright/mcp prefixes them with a
// frame/generation counter like "f1e1" after a page navigates within a session).
const REF_PATTERN = /\[ref=([^\]]+)\]/;

/** Strips the leading `### Page` / `### Snapshot` framing and ```yaml fences some tool results wrap the tree in. */
export function extractSnapshotYaml(resultText: string): string {
  const fenced = resultText.match(/```yaml\n([\s\S]*?)```/);
  if (fenced) return fenced[1] ?? '';
  const marker = resultText.indexOf('### Snapshot');
  return marker === -1 ? resultText : resultText.slice(marker);
}

export function parseSnapshot(resultText: string): SnapshotNode[] {
  const yaml = extractSnapshotYaml(resultText);
  const nodes: SnapshotNode[] = [];
  for (const line of yaml.split('\n')) {
    if (!line.trim().startsWith('-')) continue;
    const match = line.match(LINE_PATTERN);
    if (!match) continue;
    const [, indent = '', role = '', name, attrs = '', value] = match;
    const refMatch = attrs.match(REF_PATTERN);
    nodes.push({
      role,
      name: name ?? null,
      value: value !== undefined && value !== '' ? value : null,
      ref: refMatch ? (refMatch[1] ?? null) : null,
      depth: indent.length,
      raw: line,
    });
  }
  return nodes;
}

export type TextMatchOptions = { exact?: boolean };

export function textMatches(candidate: string, expected: string, options?: TextMatchOptions): boolean {
  const normalize = (s: string) => s.trim().replace(/\s+/g, ' ');
  const a = normalize(candidate);
  const b = normalize(expected);
  if (options?.exact) return a === b;
  return a.toLowerCase().includes(b.toLowerCase());
}

export function findByRole(nodes: SnapshotNode[], role: string, options?: { name?: string } & TextMatchOptions): SnapshotNode[] {
  return nodes.filter((n) => {
    if (n.role !== role || n.ref === null) return false;
    if (options?.name === undefined) return true;
    return n.name !== null && textMatches(n.name, options.name, options);
  });
}

export function findByText(nodes: SnapshotNode[], text: string, options?: TextMatchOptions): SnapshotNode[] {
  return nodes.filter((n) => {
    if (n.ref === null) return false;
    const candidate = n.value ?? n.name;
    return candidate !== null && textMatches(candidate, text, options);
  });
}
