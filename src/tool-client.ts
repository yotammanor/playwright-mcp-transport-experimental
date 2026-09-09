import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { McpToolCallError, McpToolCallTimeoutError } from './errors.js';
import { createDebug } from './debug.js';

const debug = createDebug('playwright-mcp-transport:tool-client');

export type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export interface McpToolClient {
  listTools(): Promise<McpToolDefinition[]>;
  callTool(name: string, args: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<unknown>;
  close?(): Promise<void>;
}

export type CreateMcpToolClientOptions =
  | {
      transport: 'stdio';
      command: string;
      args: string[];
      env?: Record<string, string>;
      cwd?: string;
      onStderr?: (chunk: string) => void;
      signal?: AbortSignal;
      defaultToolTimeoutMs?: number;
      clientName?: string;
      clientVersion?: string;
    }
  | {
      transport: 'http';
      endpoint: string;
      signal?: AbortSignal;
      defaultToolTimeoutMs?: number;
      clientName?: string;
      clientVersion?: string;
    };

export type McpStdioToolClient = McpToolClient & {
  readonly pid: number | null;
};

export function textFromResult(result: unknown): string {
  const content = (result as { content?: unknown })?.content;
  if (Array.isArray(content)) {
    return content
      .filter((c): c is { type: string; text: string } => (c as { type?: string }).type === 'text')
      .map((c) => c.text)
      .join('\n');
  }
  return JSON.stringify(result);
}

/**
 * Wraps an MCP SDK `Client` connected over stdio or streamable-HTTP into the
 * package's thin `McpToolClient` interface. `callTool` normalizes both
 * failure modes the SDK exposes: a thrown McpError (protocol/timeout) and an
 * in-band `{isError: true}` tool result (tool-level failure) both surface as
 * a single rejected promise here so callers only need one error path.
 */
export async function createMcpToolClient(options: CreateMcpToolClientOptions): Promise<McpStdioToolClient> {
  const transport =
    options.transport === 'stdio'
      ? new StdioClientTransport({
          command: options.command,
          args: options.args,
          env: { ...getDefaultEnvironment(), ...(options.env ?? {}) },
          cwd: options.cwd,
          stderr: 'pipe',
        })
      : new StreamableHTTPClientTransport(new URL(options.endpoint));

  if (options.transport === 'stdio' && options.onStderr) {
    (transport as StdioClientTransport).stderr?.on('data', (chunk: Buffer) => options.onStderr!(chunk.toString('utf8')));
  }

  const client = new Client(
    { name: options.clientName ?? 'playwright-mcp-transport-experimental', version: options.clientVersion ?? '0.1.0' },
    { capabilities: {} },
  );

  debug('connecting', options.transport);
  const connectPromise = client.connect(transport);
  let rejectAborted: ((reason: Error) => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAborted = reject;
  });
  const onAbort = () => {
    void transport.close().catch(() => {});
    rejectAborted?.(new Error('MCP client connection aborted'));
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  try {
    await Promise.race([connectPromise, aborted]);
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }
  debug('connected');

  const defaultTimeout = options.defaultToolTimeoutMs;

  return {
    pid: options.transport === 'stdio' ? (transport as StdioClientTransport).pid : null,

    async listTools() {
      const { tools } = await client.listTools();
      return tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown> | undefined,
      }));
    },

    async callTool(name, args, callOptions) {
      const timeoutMs = callOptions?.timeoutMs ?? defaultTimeout;
      debug('callTool', name, args, { timeoutMs });
      let result: unknown;
      try {
        result = await client.callTool(
          { name, arguments: args },
          undefined,
          timeoutMs !== undefined ? { timeout: timeoutMs } : undefined,
        );
      } catch (err) {
        if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) {
          throw new McpToolCallTimeoutError(name, timeoutMs ?? 0);
        }
        throw err;
      }
      if ((result as { isError?: boolean })?.isError) {
        throw new McpToolCallError(name, textFromResult(result));
      }
      return result;
    },

    async close() {
      await client.close();
    },
  };
}
