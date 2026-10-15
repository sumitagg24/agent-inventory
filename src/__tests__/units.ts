/**
 * Unit tests for pure modules (no DB, no processes).
 * Run: npm run build && npm test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { diffItemLists } from '../drift/index.js';
import { redactLaunchCommand, scanItemForSecrets } from '../secrets/scan.js';
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
