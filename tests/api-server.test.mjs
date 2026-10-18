import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// The server reads HOME/AGENT_INVENTORY_DATA_DIR at request time; the test
// process imports the compiled modules after the environment is isolated.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-inv-api-'));
process.env.HOME = root;
process.env.USERPROFILE = root;
const dataDir = path.join(root, 'data');
const fixtureContent = '{"note": "api fixture", "api_key": "sk-apiINTEGRATIONfixture0123456789"}';
process.env.AGENT_INVENTORY_DATA_DIR = dataDir;

const storage = await import('../dist/storage/sqlite.js');
const serverModule = await import('../dist/server/index.js');

const now = new Date().toISOString();
storage.upsertItem({
  id: 'legacy-row@codex@user',
  kind: 'mcp',
  name: 'legacy-row',
  agent: 'codex',
  scope: 'user',
  config_path: path.join(root, 'codex-config.toml'),
  launch_command: 'node server.js --api-key sk-apiINTEGRATIONfixture0123456789',
  launch_command_raw: 'raw-args-not-allowed top-secret-RAW-VALUE',
  description: 'upgrade notes token=ghp_INTEGRATIONRAWDESCVALUE0123456789',
  last_seen: now,
  introspection_error: 'failed before start: header x-api-key leaked-value',
});
storage.upsertItem({
  id: 'toolful@claude-code@user',
  kind: 'mcp',
  name: 'toolful',
  agent: 'claude-code',
  scope: 'user',
  config_path: path.join(root, '.claude.json'),
  launch_command: 'node tool-server.js',
  last_seen: now,
});
storage.upsertTool({
  id: 'toolful-read-file',
  item_id: 'toolful@claude-code@user',
  tool_name: 'read_file',
  tool_description: 'Reads a file from disk',
  input_schema_json: JSON.stringify({ type: 'object', properties: { path: { type: 'string' } }, api_key: 'sk-schemaSECRETfixtured0123456789' }),
});

test('dashboard API is loopback-only, allowlisted, and exports redacted payloads', async (t) => {
  const app = serverModule.createServer();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => {
    server.close();
    storage.closeDb();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  // Wildcard CORS must be absent: a hostile web page must not be able to read
  // the response of a cross-origin fetch against the local API.
  const itemsRes = await fetch(`${base}/api/items`);
  assert.equal(itemsRes.status, 200);
  assert.equal(itemsRes.headers.get('access-control-allow-origin'), null);
  const optionsRes = await fetch(`${base}/api/items`, { method: 'OPTIONS' });
  assert.equal(optionsRes.headers.get('access-control-allow-origin'), null);

  const items = await itemsRes.json();
  assert.ok(Array.isArray(items));
  for (const item of items) {
    assert.ok(!('launch_command_raw' in item), 'raw launch details must never be returned');
    assert.ok(!('introspection_error' in item), 'free-form error text must never be returned');
  }
  const legacy = items.find((i) => i.id === 'legacy-row@codex@user');
  assert.ok(legacy, 'legacy seeded row should exist');
  assert.match(legacy.launch_command, /\[REDACTED\]/);
  assert.doesNotMatch(legacy.launch_command, /sk-apiINTEGRATIONfixture0123456789/);
  const itemsText = JSON.stringify(items);
  assert.ok(!itemsText.includes('top-secret-RAW-VALUE'), 'raw column value leaked');
  assert.ok(!itemsText.includes('ghp_INTEGRATIONRAWDESCVALUE0123456789'), 'raw description leaked');
  assert.ok(!itemsText.includes('leaked-value'), 'introspection error text leaked');

  const detailRes = await fetch(`${base}/api/items/toolful@claude-code@user`);
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json();
  assert.equal(detail.tools.length, 1);
  assert.equal(detail.tools[0].tool_name, 'read_file');
  const missingRes = await fetch(`${base}/api/items/does-not-exist`);
  assert.equal(missingRes.status, 404);

  const tools = await (await fetch(`${base}/api/tools`)).json();
  assert.ok(tools.some((tool) => tool.tool_name === 'read_file' && tool.item_name === 'toolful'));

  const search = await (await fetch(`${base}/api/search?q=toolful`)).json();
  assert.ok(search.some((item) => item.id === 'toolful@claude-code@user'));

  const stats = await (await fetch(`${base}/api/stats`)).json();
  assert.equal(stats.totalItems, 2);
  assert.equal(stats.totalTools, 1);

  const doctor = await (await fetch(`${base}/api/doctor`)).json();
  assert.ok(Array.isArray(doctor.issues));

  const usage = await (await fetch(`${base}/api/usage`)).json();
  assert.ok(Array.isArray(usage) && usage.length === 2);

  const exportBody = await (await fetch(`${base}/api/export`)).json();
  assert.ok(exportBody.exportedAt);
  assert.equal(exportBody.version, '0.1.0');
  const exportedText = JSON.stringify(exportBody);
  assert.doesNotMatch(exportedText, /sk-apiINTEGRATIONfixture0123456789/);
  assert.doesNotMatch(exportedText, /sk-schemaSECRETfixtured0123456789/);
  assert.doesNotMatch(exportedText, /top-secret-RAW-VALUE/);
  assert.doesNotMatch(exportedText, /ghp_INTEGRATIONRAWDESCVALUE0123456789/);
  assert.match(exportedText, /REDACTED/);
  const exportedLegacy = exportBody.items.find((i) => i.id === 'legacy-row@codex@user');
  assert.ok(exportedLegacy, 'export includes items');
  assert.ok(!('launch_command_raw' in exportedLegacy));
});
