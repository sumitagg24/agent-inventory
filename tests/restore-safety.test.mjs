import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// Restore safety: exercises snapshots/restore exclusively against temporary
// fixture files — real agent configs are never touched.
const cliPath = path.resolve('dist/cli/index.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-inv-restore-'));
const home = path.join(root, 'home');
const dataDir = path.join(root, 'data');
const fixtureDir = path.join(root, 'fixture');
fs.mkdirSync(fixtureDir, { recursive: true });
const secretConfigPath = path.join(fixtureDir, 'config.json');
const plainConfigPath = path.join(fixtureDir, 'other.json');
fs.writeFileSync(
  secretConfigPath,
  JSON.stringify({ note: 'restore-safety fixture', token: 'ghp_RESTOREDEMOfixture0123456789abcdef' }, null, 2) + '\n',
);
fs.writeFileSync(plainConfigPath, JSON.stringify({ note: 'plain fixture stays restorable too' }) + '\n');

process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.AGENT_INVENTORY_DATA_DIR = dataDir;

const storage = await import('../dist/storage/sqlite.js');
const snapshots = await import('../dist/snapshots/index.js');

const now = new Date().toISOString();
const seedItem = (id, configPath) => storage.upsertItem({
  id,
  kind: 'mcp',
  name: id.split('@')[0],
  agent: 'claude-code',
  scope: 'user',
  config_path: configPath,
  launch_command: 'node demo-server.js',
  last_seen: now,
});
seedItem('restore-demo@claude-code@user', secretConfigPath);
seedItem('restore-other@claude-code@user', plainConfigPath);

const snap = snapshots.takeSnapshot('restore-safety');
assert.ok(snap.id, 'snapshot id available');
const bundled = snap.files.filter((f) => f.included);
assert.equal(bundled.length, 2);

test.after(() => {
  storage.closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test('restore --apply refuses to write from a non-interactive shell without --yes', () => {
  const before = fs.readFileSync(secretConfigPath, 'utf-8');
  const result = spawnSync(process.execPath, [cliPath, 'restore', snap.id, '--apply'], {
    encoding: 'utf8',
    env: { ...process.env },
  });
  assert.equal(result.status, 2, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stderr, /Refusing to write files from a non-interactive shell without explicit consent/);
  assert.equal(fs.readFileSync(secretConfigPath, 'utf-8'), before, 'fixture was modified during refusal');
});

test('restore --apply --yes writes redacted bundled contents back', () => {
  const result = spawnSync(process.execPath, [cliPath, 'restore', snap.id, '--apply', '--yes'], {
    encoding: 'utf8',
    env: { ...process.env },
  });
  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const restored = fs.readFileSync(secretConfigPath, 'utf-8');
  assert.ok(!restored.includes('ghp_RESTOREDEMOfixture0123456789abcdef'), 'restore must never re-introduce the secret');
  assert.match(restored, /REDACTED/);
  assert.match(restored, /'restore-safety fixture'|\"restore-safety fixture\"/);
  const other = fs.readFileSync(plainConfigPath, 'utf-8');
  assert.match(other, /plain fixture stays restorable too/, 'non-symlink plain file restores normally');
});

test('restore refuses destinations that are or traverse symlinks', (t) => {
  // Clean up tests 1-2 state so the symlink snapshot bundles this item only.
  storage.deleteSnapshot(snap.id);
  storage.deleteInventoryItem('restore-demo@claude-code@user');
  storage.deleteInventoryItem('restore-other@claude-code@user');

  const realDir = path.join(root, 'real');
  const junctionPath = path.join(root, 'junction');
  fs.mkdirSync(realDir, { recursive: true });
  const realFile = path.join(realDir, 'content.json');
  const original = '{"note":"symlink target must stay untouched","marker":"SENTINEL-ORIGINAL"}';
  try {
    fs.writeFileSync(realFile, original);
    fs.symlinkSync(realDir, junctionPath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    fs.rmSync(junctionPath, { recursive: true, force: true });
    t.skip('symlink/junction creation is unavailable in this environment');
    return;
  }

  seedItem('symlink-demo@claude-code@user', path.join(junctionPath, 'content.json'));
  const snapSymlink = snapshots.takeSnapshot('restore-symlink');

  const result = spawnSync(process.execPath, [cliPath, 'restore', snapSymlink.id, '--apply', '--yes'], {
    encoding: 'utf8',
    env: { ...process.env },
  });
  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stdout, /refused: destination is or traverses a symlink/);
  assert.equal(fs.readFileSync(realFile, 'utf-8'), original, 'symlink target was modified');
});
