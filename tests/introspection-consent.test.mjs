import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-inventory-consent-'));
process.env.AGENT_INVENTORY_DATA_DIR = path.join(temp, 'database');
const { inspectMcp } = await import('../dist/introspection/mcp.js');

test('programmatic introspection refuses to execute without explicit approval', async (t) => {
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

  await assert.rejects(
    inspectMcp({
      id: 'unapproved',
      name: 'unapproved-server',
      agent: 'cursor',
      config_path: path.join(temp, 'must-not-be-read.json'),
    }, false),
    /Explicit approval is required/,
  );
  assert.equal(fs.existsSync(path.join(temp, 'must-not-be-read.json')), false);
});
