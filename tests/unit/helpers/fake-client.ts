import type { McpToolClient, McpToolDefinition } from '../../../src/tool-client.js';

export type FakeCall = { name: string; args: Record<string, unknown>; options?: { timeoutMs?: number } };

export type FakeToolHandler = (args: Record<string, unknown>) => unknown;

/**
 * A scripted stand-in for a real MCP server: tests register a handler per
 * tool name and assert against `client.calls` afterward, instead of spawning
 * `@playwright/mcp` and a real browser for every unit test.
 */
export class FakeMcpToolClient implements McpToolClient {
  readonly calls: FakeCall[] = [];

  constructor(
    private readonly tools: McpToolDefinition[],
    private readonly handlers: Record<string, FakeToolHandler>,
  ) {}

  async listTools(): Promise<McpToolDefinition[]> {
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<unknown> {
    this.calls.push({ name, args, options });
    const handler = this.handlers[name];
    if (!handler) throw new Error(`FakeMcpToolClient: no handler registered for tool "${name}"`);
    return handler(args);
  }

  async close(): Promise<void> {}
}

export function toolDef(name: string): McpToolDefinition {
  return { name };
}

export function textResult(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] };
}
