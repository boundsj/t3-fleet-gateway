import type { McpServer } from '@modelcontextprotocol/server';
import type * as z from 'zod';
import { describeError } from '../errors.ts';
import type { Logger } from '../log.ts';
import type { Scope } from '../oauth/scopes.ts';

export interface ToolContext {
  clientId: string;
  scopes: readonly Scope[];
}

export interface ToolOutcome<O> {
  structured: O;
  /** Short human-readable summary, sent as the text content. */
  summary: string;
}

/** A gateway tool: schemas, the scope it requires, and its implementation. */
export interface GatewayTool<I extends z.ZodObject = z.ZodObject, O extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  /** Written for an LLM: what it does, when to use it, and what the result means. */
  description: string;
  scope: Scope;
  readOnly: boolean;
  inputSchema: I;
  outputSchema: O;
  run(input: z.output<I>, context: ToolContext): Promise<ToolOutcome<z.output<O>>>;
}

export function defineTool<I extends z.ZodObject, O extends z.ZodObject>(tool: GatewayTool<I, O>): GatewayTool {
  return tool as unknown as GatewayTool;
}

function errorResult(code: string, message: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: `${code}: ${message}` }],
  };
}

/**
 * Register tools on a per-request server. Every tool is listed for every caller; a call without the
 * required scope returns a tool error naming the missing scope instead of running.
 */
export function registerTools(server: McpServer, tools: readonly GatewayTool[], context: ToolContext, logger: Logger): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: { readOnlyHint: tool.readOnly, openWorldHint: true },
      },
      async (input: unknown) => {
        const started = performance.now();
        const done = (outcome: 'ok' | 'error', errorCode?: string) =>
          logger.info('mcp.tool_call', {
            tool: tool.name,
            clientId: context.clientId,
            outcome,
            errorCode,
            durationMs: Math.round(performance.now() - started),
          });
        if (!context.scopes.includes(tool.scope)) {
          done('error', 'insufficient_scope');
          return errorResult(
            'insufficient_scope',
            `${tool.name} requires the ${tool.scope} scope. Reconnect this agent and choose Operate on the approval page.`,
          );
        }
        try {
          const outcome = await tool.run(input as z.output<typeof tool.inputSchema>, context);
          done('ok');
          return { content: [{ type: 'text' as const, text: outcome.summary }], structuredContent: outcome.structured };
        } catch (error) {
          const described = describeError(error);
          done('error', described.code);
          return errorResult(described.code, described.code === 'internal_error' ? 'The gateway hit an unexpected error.' : described.message);
        }
      },
    );
  }
}
