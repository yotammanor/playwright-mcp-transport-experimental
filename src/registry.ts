import type { McpToolDefinition } from './tool-client.js';
import { DEFAULT_TOOL_CANDIDATES, REQUIRED_OPS, resolveToolNames, type McpBrowserToolNames } from './options.js';
import { MissingMcpToolError } from './errors.js';

export type ToolRegistry = Partial<McpBrowserToolNames>;

/**
 * Picks a concrete tool name per semantic op: an explicit override wins if the
 * server actually exposes it, otherwise the first matching entry from
 * `DEFAULT_TOOL_CANDIDATES` wins. Ops with no match stay unresolved (`undefined`)
 * unless they're in `REQUIRED_OPS`, in which case resolution fails fast.
 */
export function resolveRegistry(available: McpToolDefinition[], overrides: Partial<McpBrowserToolNames> | undefined): ToolRegistry {
  const availableNames = new Set(available.map((t) => t.name));
  const resolvedOverrides = resolveToolNames(overrides);

  const registry: ToolRegistry = {};
  for (const op of Object.keys(DEFAULT_TOOL_CANDIDATES) as Array<keyof McpBrowserToolNames>) {
    const override = resolvedOverrides[op];
    const candidates = override ? [override] : DEFAULT_TOOL_CANDIDATES[op];
    registry[op] = candidates.find((name) => availableNames.has(name));
  }

  const missing = REQUIRED_OPS.filter((op) => registry[op] === undefined);
  if (missing.length > 0) {
    const missingLabels = missing.map((op) => {
      const override = resolvedOverrides[op];
      const candidates = override ? [override] : DEFAULT_TOOL_CANDIDATES[op];
      return `${op} (tried: ${candidates.join(', ')})`;
    });
    throw new MissingMcpToolError(missingLabels, [...availableNames].sort());
  }

  return registry;
}
