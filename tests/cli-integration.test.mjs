import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const cliPath = path.resolve('dist/cli/index.js');

function runCli(args, env) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env,
  });
}

test('user flow scans supported configs, reports health, exports safely, and never runs MCP during scan', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-inventory-e2e-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const home = path.join(root, 'home');
  const dataDir = path.join(root, 'data');
  const project = path.join(root, 'project');
  const sentinel = path.join(root, 'mcp-command-ran');
  const configRoot = path.join(home, '.config');
  const appData = path.join(home, 'AppData', 'Roaming');
  const desktopConfigPath = process.platform === 'win32'
    ? path.join(appData, 'Claude', 'claude_desktop_config.json')
    : process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : path.join(configRoot, 'Claude', 'claude_desktop_config.json');
  const vscodeSettingsPath = process.platform === 'win32'
    ? path.join(appData, 'Code', 'User', 'settings.json')
    : process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json')
      : path.join(configRoot, 'Code', 'User', 'settings.json');
  fs.mkdirSync(path.dirname(path.join(home, '.claude', 'skills', 'demo-skill', 'SKILL.md')), { recursive: true });
  fs.mkdirSync(path.join(home, '.cursor', 'rules'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codeium', 'windsurf'), { recursive: true });
  fs.mkdirSync(path.dirname(desktopConfigPath), { recursive: true });
  fs.mkdirSync(path.dirname(vscodeSettingsPath), { recursive: true });
  fs.mkdirSync(project, { recursive: true });

  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: {
      localDemo: {
        command: 'node',
        args: ['-e', "require('fs').writeFileSync(process.env.AIINV_SENTINEL, 'ran')", '--api-key', 'top-secret-value'],
      },
    },
  }));
  fs.writeFileSync(path.join(home, '.claude', 'skills', 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: A sample skill\n---\n# Instructions\n');
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({
    mcpServers: { cursorDemo: { command: 'node', args: ['server.js'] } },
  }));
  fs.writeFileSync(path.join(home, '.cursor', 'rules', 'demo.mdc'), '---\nname: cursor-rule\ndescription: A sample rule\n---\nRule body.\n');
  fs.writeFileSync(path.join(home, '.codeium', 'windsurf', 'mcp_config.json'), JSON.stringify({
    mcpServers: { windsurfDemo: { command: 'node', args: ['server.js'] } },
  }));
  fs.writeFileSync(desktopConfigPath, JSON.stringify({
    mcpServers: { desktopDemo: { command: 'node', args: ['server.js'] } },
  }));
  fs.writeFileSync(vscodeSettingsPath, JSON.stringify({
    mcp: { servers: { vscodeDemo: { command: 'node', args: ['server.js'] } } },
  }));
  fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({
    mcpServers: { projectDemo: { command: 'node', args: ['server.js'] } },
  }));

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: configRoot,
    APPDATA: appData,
    AGENT_INVENTORY_DATA_DIR: dataDir,
    AIINV_SENTINEL: sentinel,
  };

  const scan = runCli(['scan'], env);
  assert.equal(scan.status, 0, scan.stderr);
  assert.match(scan.stdout, /Found 2 items from Claude Code/);
  assert.match(scan.stdout, /Found 2 items from Cursor/);
  assert.match(scan.stdout, /Found 1 items from Windsurf/);
  assert.match(scan.stdout, /Found 1 items from Claude Desktop/);
  assert.match(scan.stdout, /Found 1 items from VS Code/);

  const list = runCli(['list'], env);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /demo-skill/);
  assert.match(list.stdout, /cursor-rule/);
  assert.match(list.stdout, /--api-key \[REDACTED\]/);
  assert.doesNotMatch(list.stdout, /top-secret-value/);

  const doctor = runCli(['doctor'], env);
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.match(doctor.stdout, /All configs look healthy/);

  const projectScan = runCli(['scan-projects', project], env);
  assert.equal(projectScan.status, 0, projectScan.stderr);
  assert.match(projectScan.stdout, /Found 1 total items/);

  const exportPath = path.join(root, 'inventory.json');
  const exported = runCli(['export', exportPath], env);
  assert.equal(exported.status, 0, exported.stderr);
  const exportContent = fs.readFileSync(exportPath, 'utf8');
  assert.doesNotMatch(exportContent, /top-secret-value/);

  const inspect = runCli(['inspect', 'localDemo'], env);
  assert.equal(inspect.status, 0, inspect.stderr);
  assert.match(inspect.stderr, /Refusing to start MCP servers without interactive confirmation/);
  assert.match(inspect.stdout, /no server was started/);
  assert.equal(fs.existsSync(sentinel), false, 'no configured MCP command should run without approval');
});
