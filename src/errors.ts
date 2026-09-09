export class McpTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class NoMcpToolClientError extends McpTransportError {
  constructor() {
    super(
      [
        'No MCP tool client is available.',
        'Set mcp.mode to "managed" (to spawn @playwright/mcp) or "existing" with an injected mcp.client / mcpToolClient fixture override.',
      ].join(' '),
    );
  }
}

export class McpServerStartupError extends McpTransportError {
  constructor(command: string, args: string[], cause: string, stderr: string) {
    super(
      [
        `Failed to start managed MCP server: "${command} ${args.join(' ')}".`,
        `Cause: ${cause}`,
        stderr.trim() ? `\n--- server stderr ---\n${stderr.trim()}` : '',
      ].join(' '),
    );
  }
}

export class MissingMcpToolError extends McpTransportError {
  constructor(missing: string[], available: string[]) {
    super(
      [
        `Required MCP tool(s) not found on the connected server: ${missing.join(', ')}.`,
        `Available tools: ${available.length ? available.join(', ') : '(none)'}.`,
        'Override tool names via mcp.tools, or start the MCP server with the capability flag that exposes them (e.g. --caps=testing).',
      ].join(' '),
    );
  }
}

export class McpToolCallTimeoutError extends McpTransportError {
  constructor(toolName: string, timeoutMs: number) {
    super(`MCP tool call "${toolName}" timed out after ${timeoutMs}ms.`);
  }
}

export class McpToolCallError extends McpTransportError {
  constructor(toolName: string, detail: string) {
    super(`MCP tool call "${toolName}" failed: ${detail}`);
  }
}

export class LocatorResolutionError extends McpTransportError {
  constructor(intentDescription: string, snapshotText: string | null) {
    super(
      [
        `Could not resolve locator (${intentDescription}) from the latest MCP snapshot.`,
        snapshotText ? `\n--- last snapshot ---\n${snapshotText}` : '(no snapshot captured yet)',
      ].join(' '),
    );
  }
}

export class AssertionTimeoutError extends McpTransportError {
  constructor(matcherName: string, intentDescription: string, timeoutMs: number, lastError: string, lastSnapshot: string | null) {
    super(
      [
        `${matcherName} timed out after ${timeoutMs}ms for locator (${intentDescription}).`,
        `Last error: ${lastError}`,
        lastSnapshot ? `\n--- last snapshot ---\n${lastSnapshot}` : '(no snapshot captured)',
      ].join(' '),
    );
  }
}
