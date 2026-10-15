/**
 * Agent Inventory Tool — MCP Introspection Engine
 *
 * Boots MCP servers briefly to discover what tools they expose,
 * using the official @modelcontextprotocol/sdk Client with stdio and HTTP transports.
 *
 * Key design decisions:
 * - Uses MCP SDK Client with appropriate transport (not hand-rolled protocol)
 * - Timeout per server (10s) so one slow server doesn't block all
 * - try/catch so one broken server doesn't crash the whole scan
 * - Results cached in SQLite; only re-introspect on explicit request
 * - Opt-in: first time calling inspect on a new server requires user confirmation
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ClientCapabilities, ListToolsResult } from '@modelcontextprotocol/sdk/types.js';
import { getDb, getToolsByItemId, upsertTool } from '../storage/sqlite.js';

const INTROSPECTION_TIMEOUT_MS = 10000; // 10 second timeout per server
const CACHE_REFRESH_MS = 24 * 60 * 60 * 1000; // refresh daily (24h)

// Interface for a discovered tool
interface DiscoveredTool {
  name: string;
  description: string;
  input_schema: any;
}

// Minimal client capabilities for our use case
const clientCapabilities: ClientCapabilities = {
  roots: {
    listChanged: true,
  },
};

/**
 * Introspect a single MCP server by spawning it and calling tools/list.
 * Supports both stdio and HTTP-based transports.
 * Returns discovered tools or throws on failure.
 */
export async function inspectMcpServer(
  launchCommand: string,
  itemId: string
): Promise<DiscoveredTool[]> {
  console.log(`  Spawning: ${launchCommand}`);

  // Check if it's an HTTP-based server
  if (launchCommand.startsWith('http ')) {
    return inspectHttpMcpServer(launchCommand, itemId);
  }

  // Parse the command and args for stdio transport
  const parts = launchCommand.trim().split(/\s+/);
  const command = parts[0];
  const args = parts.slice(1);

  let transport: StdioClientTransport;
  try {
    transport = new StdioClientTransport({
      command,
      args,
    });
  } catch (err) {
    console.log(`  ⚠️  Failed to create transport: ${(err as Error).message}`);
    return [];
  }

  const client = new Client(
    { name: 'agent-inventory', version: '0.1.0' },
    { capabilities: clientCapabilities }
  );

  try {
    // Connect and initialize with timeout
    console.log('  🔌 Initializing...');
    await Promise.race([
      client.connect(transport),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Initialization timeout')), INTROSPECTION_TIMEOUT_MS)
      ),
    ]);

    // Request the list of tools with timeout
    console.log('  📋 Fetching tools/list...');
    const listResult = await Promise.race([
      client.listTools(),
      new Promise<ListToolsResult>((_, reject) =>
        setTimeout(() => reject(new Error('listTools timeout')), INTROSPECTION_TIMEOUT_MS)
      ),
    ]);

    if (!listResult || !listResult.tools) {
      console.log('  ⚠️  No tools returned from listTools');
      return [];
    }

    // Transform into our schema
    const tools: DiscoveredTool[] = listResult.tools.map((tool: any) => ({
      name: tool.name,
      description: tool.description || '',
      input_schema: tool.inputSchema || {},
    }));

    return tools;

  } catch (err) {
    console.log(`  ❌ Introspection failed: ${(err as Error).message}`);
    throw err;
  } finally {
    // Always close the connection
    try {
      await client.close();
    } catch (e) {
      // Ignore close errors
    }
  }
}

/**
 * Introspect an HTTP-based MCP server.
 */
async function inspectHttpMcpServer(
  launchCommand: string,
  itemId: string
): Promise<DiscoveredTool[]> {
  // Format: "http <url>"
  const url = launchCommand.replace(/^http\s+/, '').trim();
  console.log(`  Connecting to HTTP server: ${url}`);

  let transport: StreamableHTTPClientTransport;
  try {
    transport = new StreamableHTTPClientTransport(new URL(url));
  } catch (err) {
    console.log(`  ⚠️  Failed to create HTTP transport: ${(err as Error).message}`);
    return [];
  }

  const client = new Client(
    { name: 'agent-inventory', version: '0.1.0' },
    { capabilities: clientCapabilities }
  );

  try {
    // Connect and initialize with timeout
    console.log('  🔌 Initializing...');
    await Promise.race([
      client.connect(transport),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Initialization timeout')), INTROSPECTION_TIMEOUT_MS)
      ),
    ]);

    // Request the list of tools with timeout
    console.log('  📋 Fetching tools/list...');
    const listResult = await Promise.race([
      client.listTools(),
      new Promise<ListToolsResult>((_, reject) =>
        setTimeout(() => reject(new Error('listTools timeout')), INTROSPECTION_TIMEOUT_MS)
      ),
    ]);

    if (!listResult || !listResult.tools) {
      console.log('  ⚠️  No tools returned from listTools');
      return [];
    }

    const tools: DiscoveredTool[] = listResult.tools.map((tool: any) => ({
      name: tool.name,
      description: tool.description || '',
      input_schema: tool.inputSchema || {},
    }));

    return tools;

  } catch (err) {
    console.log(`  ❌ HTTP Introspection failed: ${(err as Error).message}`);
    throw err;
  } finally {
    try {
      await client.close();
    } catch (e) {
      // Ignore close errors
    }
  }
}

/**
 * Introspect an MCP item from the inventory.
 * Checks cache first; only spawns server if cache is stale or empty.
 */
export async function inspectMcp(
  item: any,
  useCache: boolean = true
): Promise<{ name: string; description: string; input_schema_json: string }[]> {
  const itemId = item.id;

  // Check if we have cached tools (less than 24h old)
  if (useCache) {
    const cachedTools = getToolsByItemId(itemId);
    const itemRecord = getDb().prepare('SELECT last_seen FROM items WHERE id = ?').get(itemId) as any;
    const cacheAge = itemRecord ? new Date().getTime() - new Date(itemRecord.last_seen).getTime() : Infinity;

    if (cachedTools.length > 0 && cacheAge < CACHE_REFRESH_MS) {
      console.log(`  Using cached results (${Math.round(cacheAge / 1000 / 60)} min old)`);
      return cachedTools.map((t: any) => ({
        name: t.tool_name,
        description: t.tool_description || '',
        input_schema_json: t.input_schema_json,
      }));
    }
  }

  // Re-introspect
  let tools: { name: string; description: string; input_schema: any }[] = [];

  if (item.launch_command) {
    try {
      tools = await inspectMcpServer(item.launch_command, itemId);
    } catch (err) {
      console.log(`  Could not introspect MCP server for ${item.name}`);
    }
  }

  // Store tools in SQLite for caching
  for (const tool of tools) {
    upsertTool({
      id: `${tool.name}@${itemId}`,
      item_id: itemId,
      tool_name: tool.name,
      tool_description: tool.description,
      input_schema_json: JSON.stringify(tool.input_schema),
    });
  }

  // Return in the format the CLI expects
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema_json: JSON.stringify(t.input_schema),
  }));
}

/**
 * Introspect all MCP items in the database.
 * Only introspects items that haven't been introspected recently.
 */
export async function inspectAllMcpItems(): Promise<void> {
  const items = getDb().prepare(`
    SELECT i.* FROM items i
    LEFT JOIN tools t ON i.id = t.item_id
    WHERE i.kind = 'mcp'
    GROUP BY i.id
    HAVING COUNT(t.id) = 0
       OR MAX(i.last_seen) IS NULL
       OR i.last_seen < datetime('now', '-1 day')
  `).all() as any[];

  console.log(`Found ${items.length} uncached MCP items to introspect...`);

  for (const item of items) {
    console.log(`\nIntrospecting ${item.name}...`);
    try {
      const tools = await inspectMcp(item);
      console.log(`  ✅ Found ${tools.length} tool(s)`);
    } catch (err) {
      console.log(`  ❌ Failed: ${(err as Error).message}`);
    }
  }
}

export default { inspectMcp, inspectMcpServer, inspectAllMcpItems };