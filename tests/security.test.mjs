import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  formatLaunchCommand,
  formatLaunchUrl,
  redactSensitiveObject,
  redactSensitiveText,
  safeDisplayText,
} from '../dist/security/redaction.js';
import { metadataString, parseFrontmatter } from '../dist/scanners/frontmatter.js';
import { readMcpLaunchSpec } from '../dist/introspection/launch-spec.js';

test('redacts secret-bearing command arguments before storage/display', () => {
  const output = formatLaunchCommand('npx', ['-y', '@example/server', '--api-key', 'super-secret', '--mode=read']);
  assert.match(output, /--api-key \[REDACTED\]/);
  assert.match(output, /--mode=read/);
  assert.doesNotMatch(output, /super-secret/);
});

test('redacts URL credentials and sensitive query parameters', () => {
  const output = formatLaunchUrl('https://alice:password@example.test/mcp?access_token=abc123&mode=read');
  assert.doesNotMatch(output, /alice|password|abc123/);
  assert.match(output, /mode=read/);
  assert.match(output, /access_token=\[REDACTED\]/);
});

test('redacts secret keys recursively and removes terminal control characters', () => {
  const safe = redactSensitiveObject({
    config: { apiKey: 'top-secret', description: 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
  });
  assert.deepEqual(safe, {
    config: { apiKey: '[REDACTED]', description: 'GITHUB_TOKEN=[REDACTED]' },
  });
  assert.equal(safeDisplayText('hello\u001b[31mred\u001b[0m\nworld'), 'hellored world');
  assert.doesNotMatch(redactSensitiveText('Authorization: Bearer secret-value'), /secret-value/);
});

test('parses skill frontmatter as data and validates string metadata', () => {
  const data = parseFrontmatter(`---\nname: sample-skill\ndescription: |\n  A useful skill.\n  It has two lines.\nallowed-tools:\n  - Read\n  - Grep\n---\n# Body\n`);
  assert.equal(metadataString(data, 'name'), 'sample-skill');
  assert.equal(metadataString(data, 'description'), 'A useful skill.\nIt has two lines.');
  assert.deepEqual(data['allowed-tools'], ['Read', 'Grep']);
  assert.deepEqual(parseFrontmatter('# No frontmatter'), {});
  assert.throws(() => parseFrontmatter('---\nname: one\nname: two\n---\n'), /Invalid YAML frontmatter/);
});

test('loads exact MCP launch details only from the config file without executing them', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-inventory-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'mcp.json');
  const configText = JSON.stringify({
    mcpServers: {
      example: {
        command: 'node',
        args: ['server.js', '--token', 'do-not-log'],
        env: { API_TOKEN: 'config-secret' },
        cwd: directory,
      },
    },
  });
  fs.writeFileSync(configPath, configText);

  const spec = readMcpLaunchSpec({
    name: 'example',
    agent: 'cursor',
    config_path: configPath,
  });
  assert.equal(spec.command, 'node');
  assert.deepEqual(spec.args, ['server.js', '--token', 'do-not-log']);
  assert.equal(spec.env.API_TOKEN, 'config-secret');
  assert.equal(spec.cwd, directory);
  assert.equal(fs.readFileSync(configPath, 'utf8'), configText, 'source config is read-only');
});

test('loads remote HTTP MCP URL and headers without persisting or printing them', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-inventory-http-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'mcp.json');
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      remote: {
        type: 'http',
        url: 'https://example.test/mcp?access_token=secret',
        headers: { Authorization: 'Bearer secret-header' },
      },
    },
  }));
  const spec = readMcpLaunchSpec({ name: 'remote', agent: 'cursor', config_path: configPath });
  assert.equal(spec.url, 'https://example.test/mcp?access_token=secret');
  assert.equal(spec.headers.Authorization, 'Bearer secret-header');
  assert.doesNotMatch(formatLaunchUrl(spec.url), /secret/);
});

test('Cursor .mdc rule description containing a token is redacted before storage', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-inventory-cursor-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(directory, 'rule.mdc'),
    '---\nname: test-rule\ndescription: Connect with token ghp_abcdefghijklmnopqrstuvwxyz0123456789\n---\n# body\n',
  );

  const cursorScanner = (await import('../dist/scanners/cursor.js')).default;
  const { parseCursorRulesDir } = cursorScanner;
  const items = parseCursorRulesDir(directory, 'project');

  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'test-rule');
  assert.equal(items[0].kind, 'skill');
  assert.doesNotMatch(items[0].description ?? '', /ghp_/);
  assert.match(items[0].description ?? '', /\[REDACTED]/);
});
