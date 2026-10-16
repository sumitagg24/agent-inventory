import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-inventory-mcp-'));
process.env.AGENT_INVENTORY_DATA_DIR = path.join(root, 'data');
const { getDb, getToolsByItemId, upsertItem } = await import('../dist/storage/sqlite.js');
const { inspectMcp } = await import('../dist/introspection/mcp.js');
const require = createRequire(import.meta.url);

test('approved inspection lists tools, does not call them, caches results, and cleans up', async (t) => {
  t.after(() => {
    getDb().close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const serverScript = path.join(root, 'mock-server.mjs');
  const configPath = path.join(root, 'mcp.json');
  const toolSentinel = path.join(root, 'tool-was-called');
  const mcpModuleUrl = pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/mcp.js')).href;
  const stdioModuleUrl = pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/stdio.js')).href;
  fs.writeFileSync(serverScript, `
    import { writeFileSync } from 'node:fs';
    import { McpServer } from ${JSON.stringify(mcpModuleUrl)};
    import { StdioServerTransport } from ${JSON.stringify(stdioModuleUrl)};
    const server = new McpServer({ name: 'test-server', version: '1.0.0' });
    server.registerTool('never_called', { description: 'A harmless integration test tool' }, async () => {
      writeFileSync(process.env.AIINV_TOOL_SENTINEL, 'called');
      return { content: [{ type: 'text', text: 'unexpected call' }] };
    });
    await server.connect(new StdioServerTransport());
  `);
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      testServer: {
        command: process.execPath,
        args: [serverScript],
        env: { AIINV_TOOL_SENTINEL: toolSentinel },
      },
    },
  }));

  const item = {
    id: 'test-server-id',
    kind: 'mcp',
    name: 'testServer',
    agent: 'cursor',
    scope: 'user',
    config_path: configPath,
    launch_command: `${process.execPath} [mock-server]`,
    last_seen: new Date().toISOString(),
  };
  upsertItem(item);

  const tools = await inspectMcp(item, false, true);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'never_called');
  assert.match(tools[0].description, /integration test tool/);
  assert.equal(fs.existsSync(toolSentinel), false, 'tools/list must not call the tool handler');
  assert.equal(getToolsByItemId(item.id).length, 1, 'successful tool metadata is cached');

  // An explicitly cached read succeeds without approval and does not reread/start the server.
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));
  const cached = await inspectMcp(item, true, false);
  assert.deepEqual(cached, tools);
  assert.equal(fs.existsSync(toolSentinel), false);
});
