import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scanProjects } from '../dist/scanners/project.js';

test('project scans are read-only and redact secrets from inventory summaries', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-inventory-project-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, '.mcp.json');
  const original = JSON.stringify({
    mcpServers: {
      sample: { command: 'node', args: ['server.js', '--api-key', 'not-for-storage'] },
    },
  });
  fs.writeFileSync(configPath, original);

  const items = scanProjects({ rootDir: root, maxDepth: 1 });
  assert.equal(items.length, 1);
  assert.match(items[0].launch_command, /--api-key \[REDACTED\]/);
  assert.doesNotMatch(items[0].launch_command, /not-for-storage/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
});

test('project scans skip node_modules on the traversal path', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-inventory-excludes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nested = path.join(root, 'node_modules', 'untrusted-package');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, '.mcp.json'), JSON.stringify({
    mcpServers: { ignored: { command: 'node', args: ['server.js'] } },
  }));

  assert.deepEqual(scanProjects({ rootDir: root, maxDepth: 5 }), []);
});

test('project scan depth is bounded and validated', () => {
  assert.throws(() => scanProjects({ rootDir: os.tmpdir(), maxDepth: Number.NaN }), /maxDepth/);
  assert.throws(() => scanProjects({ rootDir: os.tmpdir(), maxDepth: 21 }), /maxDepth/);
});
