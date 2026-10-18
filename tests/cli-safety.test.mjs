import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const cliPath = path.resolve('dist/cli/index.js');

test('help does not create the local inventory directory or database', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-inventory-help-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dataDir = path.join(directory, 'data');
  const result = spawnSync(process.execPath, [cliPath, '--help'], {
    encoding: 'utf8',
    env: { ...process.env, AGENT_INVENTORY_DATA_DIR: dataDir },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: agentinv/);
  assert.equal(fs.existsSync(dataDir), false);
});

test('export preserves existing files and prints a concise error unless --force is used', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-inventory-export-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dataDir = path.join(directory, 'data');
  const outputPath = path.join(directory, 'existing.json');
  const original = '{"keep": true}';
  fs.writeFileSync(outputPath, original);

  const result = spawnSync(process.execPath, [cliPath, 'export', outputPath], {
    encoding: 'utf8',
    env: { ...process.env, AGENT_INVENTORY_DATA_DIR: dataDir },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to overwrite existing file/);
  assert.doesNotMatch(result.stderr, /Node\.js|at Command/);
  assert.equal(fs.readFileSync(outputPath, 'utf8'), original);
});

test('scan-projects rejects invalid depth without an unhandled stack trace', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-inventory-depth-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [cliPath, 'scan-projects', directory, '--max-depth', 'not-a-number'], {
    encoding: 'utf8',
    env: { ...process.env, AGENT_INVENTORY_DATA_DIR: path.join(directory, 'data') },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Invalid --max-depth value/);
  assert.doesNotMatch(result.stderr, /Node\.js|at Command/);
  assert.equal(fs.existsSync(path.join(directory, 'data')), false);
});
