import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Isolate the scanner: HOME/USERPROFILE and cwd are redirected to temporary
// fixtures, so real agent configs are never read and MCP processes are never
// started — this scanner only parses static files.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-inv-codex-'));
const home = path.join(root, 'home');
const proj = path.join(root, 'proj');
fs.mkdirSync(path.join(home, '.codex', 'skills', 'howto'), { recursive: true });
fs.mkdirSync(path.join(home, '.kiro', 'settings'), { recursive: true });
fs.mkdirSync(path.join(proj, '.kiro'), { recursive: true });
fs.mkdirSync(path.join(proj, '.codex'), { recursive: true });

fs.writeFileSync(
  path.join(home, '.codex', 'config.toml'),
  [
    '[mcp_servers.filesafe]',
    'command = "node"',
    'args = ["--api-key", "sk-codexTESTfixture0123456789abcdef"]',
    '',
    '[mcp_servers."remote"]',
    'type = "http"',
    'url = "https://example.invalid/sse?key=AIzaCodexTESTfixture01234567890abcdefghijklmno"',
    'description = "Reports token=ghp_CodexTESTfixture0123456789abcdef"',
    '',
  ].join('\n'),
);
fs.writeFileSync(
  path.join(home, '.codex', 'skills', 'howto', 'SKILL.md'),
  [
    '---',
    'name: howto',
    'description: Sends reports to ghp_CodexSKILLfixture0123456789abcdef',
    'allowed-tools: read_file, write_file',
    '---',
    '# Howto body',
    '',
  ].join('\n'),
);
fs.writeFileSync(
  path.join(home, '.kiro', 'settings', 'mcp.json'),
  JSON.stringify({
    mcpServers: {
      kirosafe: { command: 'node', args: ['server.js', '--token', 'xoxb-KiroUSERfixture0123-abcdefghijklmnop'] },
    },
  }),
);
// Project-shaped config placed under HOME: with correct scope/root pairing it
// must NOT be discovered as a user-scope item.
fs.writeFileSync(
  path.join(home, '.kiro', 'mcp.json'),
  JSON.stringify({ mcpServers: { homebackend: { command: 'node', args: ['x.js'] } } }),
);
fs.writeFileSync(
  path.join(proj, '.kiro', 'mcp.json'),
  JSON.stringify({
    mcpServers: {
      kiroproj: { command: 'node', args: ['server.js', '--api-key', 'sk-KiroPROJfixture0123456789abcdef'] },
    },
  }),
);
fs.writeFileSync(
  path.join(proj, '.codex', 'mcp.json'),
  JSON.stringify({
    mcpServers: {
      codexproj: { command: 'node', args: ['server.js', '--api-key', 'sk-CodexPROJfixture0123456789abcdef'] },
    },
  }),
);

const prevHome = process.env.HOME;
const prevUserProfile = process.env.USERPROFILE;
const prevCwd = process.cwd();
process.env.HOME = home;
process.env.USERPROFILE = home;
process.chdir(proj);
const { scanCodex, parseCodexToml } = await import('../dist/scanners/codex.js');

test.after(() => {
  process.chdir(prevCwd);
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  fs.rmSync(root, { recursive: true, force: true });
});

test('parseCodexToml reads stdio and http server tables with arrays', () => {
  const raw = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf-8');
  const parsed = parseCodexToml(raw);
  assert.equal(Object.keys(parsed).length, 2);
  assert.deepEqual(parsed.filesafe.args, ['--api-key', 'sk-codexTESTfixture0123456789abcdef']);
  assert.equal(parsed.filesafe.command, 'node');
  assert.equal(parsed.remote.type, 'http');
});

test('scanCodex redacts secrets and pairs scopes with the right roots', () => {
  const items = scanCodex();
  const ids = items.map((item) => item.id);
  const mcpItems = items.filter((item) => item.kind === 'mcp');
  assert.equal(mcpItems.length, 5, `mcp ids: ${ids.join(', ')}`);
  const skills = items.filter((item) => item.kind === 'skill');
  assert.equal(skills.length, 1);

  const filesafe = items.find((item) => item.id === 'filesafe@codex@user');
  assert.ok(filesafe, 'user-scope codex TOML item present');
  assert.equal(filesafe.scope, 'user');
  assert.equal(filesafe.config_path, path.join(home, '.codex', 'config.toml'));
  assert.match(filesafe.launch_command, /\[REDACTED\]/);
  assert.ok(!filesafe.launch_command.includes('sk-codexTESTfixture0123456789abcdef'), 'secret leaked into launch summary');

  const remote = items.find((item) => item.id === 'remote@codex@user');
  assert.ok(remote, 'http codex item present');
  const remoteText = JSON.stringify(remote);
  assert.ok(!remoteText.includes('AIzaCodexTESTfixture01234567890abcdefghijklmno'), 'url token leaked');
  assert.ok(!remoteText.includes('ghp_CodexTESTfixture0123456789abcdef'), 'description token leaked');
  assert.match(remoteText, /REDACTED/);

  const howto = items.find((item) => item.id === 'howto@codex@user@SKILL.md');
  assert.ok(howto, 'codex skill present');
  assert.ok(!JSON.stringify(howto).includes('ghp_CodexSKILLfixture0123456789abcdef'), 'skill description token leaked');
  assert.match(howto.description, /REDACTED/);
  assert.match(howto.capabilities, /read_file/);

  const kiroUser = items.find((item) => item.id.startsWith('kirosafe@kiro@user@'));
  assert.ok(kiroUser, 'user-scope kiro item present');
  assert.equal(kiroUser.scope, 'user');
  assert.equal(kiroUser.config_path, path.join(home, '.kiro', 'settings', 'mcp.json'));
  assert.ok(!kiroUser.launch_command.includes('xoxb-KiroUSERfixture0123-abcdefghijklmnop'), 'kiro user token leaked');
  assert.match(kiroUser.launch_command, /\[REDACTED\]/);

  // Scope/root pairing: a project-shaped file under HOME is never scanned.
  assert.ok(!ids.some((id) => id.includes('homebackend')), 'home .kiro/mcp.json was mislabeled as user scope');
  assert.ok(!items.some((item) => item.config_path === path.join(home, '.kiro', 'mcp.json')));

  const kiroProj = items.find((item) => item.id.startsWith('kiroproj@kiro@project@'));
  assert.ok(kiroProj, 'project-scope kiro item present');
  assert.equal(kiroProj.scope, 'project');
  assert.equal(kiroProj.config_path, path.join(proj, '.kiro', 'mcp.json'));
  assert.ok(!kiroProj.launch_command.includes('sk-KiroPROJfixture0123456789abcdef'), 'kiro project token leaked');

  const codexProj = items.find((item) => item.id.startsWith('codexproj@codex@project@'));
  assert.ok(codexProj, 'project-scope codex item present');
  assert.equal(codexProj.agent, 'codex');
  assert.equal(codexProj.config_path, path.join(proj, '.codex', 'mcp.json'));
  assert.ok(!codexProj.launch_command.includes('sk-CodexPROJfixture0123456789abcdef'), 'codex project token leaked');
});
