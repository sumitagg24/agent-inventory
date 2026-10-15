/**
 * Unit tests for pure modules (no DB, no processes).
 * Run: npm run build && npm test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { diffItemLists } from '../drift/index.js';
import { redactLaunchCommand, redactSecretsInText, scanItemForSecrets } from '../secrets/scan.js';
import { inferNpmPackage, inferPyPackage } from '../license/index.js';
import { checkAgainstProfile, parseTeamFile, renderOnboardingDoc, sampleTeamFile } from '../team/index.js';
import { buildAuditExport, buildExportPayload } from '../exporter/index.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('drift', () => {
  it('detects added/removed/changed', () => {
    const before = [
      { id: 'a', name: 'a', kind: 'mcp', agent: 'cursor', scope: 'user', config_path: 'x', launch_command: 'npx a' },
      { id: 'b', name: 'b', kind: 'skill', agent: 'claude-code', scope: 'user', config_path: 'y' },
    ];
    const after = [
      { id: 'a', name: 'a', kind: 'mcp', agent: 'cursor', scope: 'user', config_path: 'x', launch_command: 'npx a2' },
      { id: 'c', name: 'c', kind: 'mcp', agent: 'cursor', scope: 'user', config_path: 'z' },
    ];
    const d = diffItemLists(before, after);
    assert.equal(d.added.length, 1);
    assert.equal(d.removed.length, 1);
    assert.equal(d.changed.length, 1);
    assert.deepEqual(d.changed[0].fields, ['launch_command']);
  });
});

describe('secrets', () => {
  it('redacts launch commands without leaking values', () => {
    const out = redactLaunchCommand('npx srv --key sk-proj-abcdefghijklmnop123456');
    assert.ok(!out!.includes('abcdefghijklmnop'));
    assert.ok(out!.includes('REDACTED'));
  });
  it('flags github tokens by pattern only', () => {
    const findings = scanItemForSecrets({
      id: 'x', name: 'x', config_path: '/nonexistent.json',
      launch_command: 'run ghp_abcdefghijklmnopqrstuvwx server',
    });
    assert.ok(findings.some((f) => f.pattern === 'github_token'));
    assert.ok(!JSON.stringify(findings).includes('ghp_abcdef'));
  });
  it('redacts secrets in config text while keeping JSON valid (bundle capture)', () => {
    const raw = JSON.stringify({ mcpServers: { a: { env: { API_KEY: 'sk-proj-abcdefghijklmnop123456' } } } }, null, 2);
    const [out, didRedact] = redactSecretsInText(raw);
    assert.equal(didRedact, true);
    assert.ok(!out.includes('abcdefghijklmnop'));
    assert.doesNotThrow(() => JSON.parse(out));
  });
  it('leaves clean text untouched', () => {
    const [out, didRedact] = redactSecretsInText('name: my-skill\nallowed-tools: Read, Bash');
    assert.equal(didRedact, false);
    assert.equal(out, 'name: my-skill\nallowed-tools: Read, Bash');
  });
});

describe('license', () => {
  it('infers npm packages from npx and node_modules paths', () => {
    assert.equal(inferNpmPackage('npx -y @modelcontextprotocol/server-filesystem /tmp'), '@modelcontextprotocol/server-filesystem');
    assert.equal(inferNpmPackage('node /home/u/node_modules/mcp-remote/dist/index.js https://x'), 'mcp-remote');
    assert.equal(inferNpmPackage('npx -y mcp-remote https://x --header auth:$API_KEY'), 'mcp-remote');
    assert.equal(inferNpmPackage('/usr/bin/claude'), null);
    assert.equal(inferNpmPackage(undefined), null);
  });
  it('infers PyPI packages from pip install commands', () => {
    assert.equal(inferPyPackage('python -m pip install mcp-server-git'), 'mcp-server-git');
    assert.equal(inferPyPackage('npx -y something'), null);
  });
});

describe('team', () => {
  it('round-trips sample profile and checks inventory', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agentinv-')), 'team.yaml');
    fs.writeFileSync(f, sampleTeamFile());
    const profile = parseTeamFile(f);
    assert.ok(profile.required.length >= 2);
    const res = checkAgainstProfile(
      [{ kind: 'mcp', name: 'postgres', agent: 'cursor' }],
      profile,
    );
    assert.equal(res.matched.length, 1);
    assert.ok(res.missing.length >= 1);
    const doc = renderOnboardingDoc(profile, [{ kind: 'mcp', name: 'postgres', agent: 'cursor', launch_command: 'npx pg' }]);
    assert.ok(doc.includes('postgres'));
  });
});

describe('exporter', () => {
  it('redacts secrets and builds audit csv', () => {
    const payload = buildExportPayload(
      [{ id: 'i1', kind: 'mcp', name: 's', agent: 'a', scope: 'user', config_path: 'c', launch_command: 'run sk-proj-abcdefghijklmnop123456', description: 'd', last_seen: 't' }],
      new Map([['i1', []]]),
    );
    assert.ok(!JSON.stringify(payload).includes('abcdefghijklmnop'));
    const csv = buildAuditExport([{ timestamp: 't', action: 'scan', item_name: 'n', agent: 'a', details: 'd', user: 'u' }], 'csv');
    assert.ok(csv.startsWith('timestamp,action'));
  });
});
