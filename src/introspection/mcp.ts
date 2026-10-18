/**
 * Explicit, opt-in MCP metadata inspection.
 *
 * `scan` never calls this module. Inspection may start the configured local process or
 * contact a configured HTTP endpoint, so the CLI asks for consent before invoking it.
 * Only the MCP initialize/tools/list handshake is made; no MCP tool is called.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ClientCapabilities, ListToolsResult } from '@modelcontextprotocol/sdk/types.js';
import { getLastIntrospected, getToolsByItemId, replaceToolsForItem } from '../storage/sqlite.js';
import { redactSensitiveObject, redactSensitiveText } from '../security/redaction.js';
import { readMcpLaunchSpec, type InventoryMcpItem, type McpLaunchSpec } from './launch-spec.js';

const INTROSPECTION_TIMEOUT_MS = 10_000;
const CACHE_REFRESH_MS = 24 * 60 * 60 * 1000;
const clientCapabilities: ClientCapabilities = {};

interface DiscoveredTool {
  name: string;
  description: string;
  input_schema: unknown;
}

export function hasFreshMcpCache(itemId: string): boolean {
  const inspectedAt = getLastIntrospected(itemId);
  if (!inspectedAt) return false;
  const age = Date.now() - Date.parse(inspectedAt);
  return Number.isFinite(age) && age >= 0 && age < CACHE_REFRESH_MS;
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), INTROSPECTION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Run only the MCP handshake and tools/list operation against a configured server. */
async function inspectMcpServer(
  spec: McpLaunchSpec,
  displayName = 'configured server',
): Promise<DiscoveredTool[]> {
  let transport: StdioClientTransport | StreamableHTTPClientTransport;
  let client: Client;

  try {
    if (spec.url) {
      const headers = spec.headers ? new Headers(spec.headers) : undefined;
      transport = new StreamableHTTPClientTransport(new URL(spec.url), {
        requestInit: headers ? { headers } : undefined,
      });
    } else if (spec.command) {
      transport = new StdioClientTransport({
        command: spec.command,
        args: spec.args ?? [],
        env: spec.env,
        cwd: spec.cwd,
        // Keep an MCP server's stderr (which may contain credentials) out of the user's terminal.
        stderr: 'ignore',
      });
    } else {
      throw new Error('No supported MCP launch configuration was found.');
    }

    client = new Client(
      { name: 'agent-inventory', version: '0.1.0' },
      { capabilities: clientCapabilities },
    );
  } catch {
    throw new Error(`Could not prepare MCP inspection for ${redactSensitiveText(displayName)}.`);
  }

  try {
    await withTimeout(client.connect(transport), 'MCP initialization');
    const result: ListToolsResult = await withTimeout(client.listTools(), 'MCP tools/list');
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description || '',
      input_schema: tool.inputSchema || {},
    }));
  } catch {
    // Do not print third-party process/network errors: they can echo secrets from config.
    throw new Error(`MCP inspection failed for ${redactSensitiveText(displayName)}. No server output was logged.`);
  } finally {
    try {
      await client.close();
    } catch {
      // Cleanup is best-effort; the SDK also terminates stdio children when closing its transport.
    }
  }
}

/**
 * Inspect an inventory item, using a successful result from the last 24 hours when available.
 * The raw command, args, environment, URL and headers are re-read from the source config and
 * are never persisted to the inventory database or printed to the terminal.
 */
export async function inspectMcp(
  item: InventoryMcpItem & { id: string },
  useCache = true,
  executionApproved = false,
): Promise<{ name: string; description: string; input_schema_json: string }[]> {
  if (useCache && hasFreshMcpCache(item.id)) {
    return getToolsByItemId(item.id).map((tool: any) => ({
      name: tool.tool_name,
      description: tool.tool_description || '',
      input_schema_json: tool.input_schema_json || '{}',
    }));
  }

  if (!executionApproved) {
    throw new Error('Explicit approval is required before starting or contacting an MCP server.');
  }

  const launchSpec = readMcpLaunchSpec(item);
  const discovered = await inspectMcpServer(launchSpec, item.name);
  const safeTools = discovered.map((tool) => {
    const name = redactSensitiveText(tool.name);
    const description = redactSensitiveText(tool.description);
    const inputSchema = redactSensitiveObject(tool.input_schema);
    const inputSchemaJson = JSON.stringify(inputSchema);
    return {
      id: `${name}@${item.id}`,
      tool_name: name,
      tool_description: description,
      input_schema_json: inputSchemaJson,
      result: { name, description, input_schema_json: inputSchemaJson },
    };
  });

  replaceToolsForItem(item.id, safeTools);
  return safeTools.map(({ result }) => result);
}

export default { inspectMcp, hasFreshMcpCache };
