/**
 * Agent Inventory Tool — Scanner for VS Code (GitHub Copilot / MCP)
 *
 * Discovers MCP servers configured for VS Code.
 *
 * MCP config locations checked:
 *   - User settings: .vscode/mcp.json (workspace) or user settings
 *   - Project: .vscode/mcp.json
 *
 * Note: VS Code stores MCP config in workspace/user settings primarily,
 * but we also check for .vscode/mcp.json in the project.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

import { InstalledItem } from './claude-code.js';

interface MCPServerConfig {
  type?: string;
  url?: string;
  command?: string;
  args?: string[];
  description?: string;
  env?: Record<string, string>;
}

/**
 * Get the VS Code user settings path for the current platform.
 */
function getVSCodeUserSettingsPath(): string | null {
  const platform = os.platform();
  const homeDir = os.homedir();

  switch (platform) {
    case 'darwin': // macOS
      return path.join(homeDir, 'Library', 'Application Support', 'Code', 'User', 'settings.json');
    case 'win32': // Windows
      return path.join(process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'Code', 'User', 'settings.json');
    case 'linux': // Linux
      return path.join(homeDir, '.config', 'Code', 'User', 'settings.json');
    default:
      return null;
  }
}

/**
 * Scan VS Code for MCP servers.
 */
export function scanVSCode(): InstalledItem[] {
  const items: InstalledItem[] = [];

  // 1. Check project-level .vscode/mcp.json
  const projectMcpPath = path.join(process.cwd(), '.vscode', 'mcp.json');
  if (fs.existsSync(projectMcpPath)) {
    try {
      const projectConfig = JSON.parse(fs.readFileSync(projectMcpPath, 'utf-8'));
      const projectItems = parseVSCodeMCPConfig(projectConfig, 'project', projectMcpPath);
      items.push(...projectItems);
    } catch (err) {
      // Silently skip malformed config
    }
  }

  // 2. Check user settings for mcp configuration
  const userSettingsPath = getVSCodeUserSettingsPath();
  if (userSettingsPath && fs.existsSync(userSettingsPath)) {
    try {
      const userSettings = JSON.parse(fs.readFileSync(userSettingsPath, 'utf-8'));
      // VS Code stores MCP config under "mcp" or "mcp.servers" in settings
      const mcpConfig = userSettings.mcp || userSettings['mcp.servers'];
      if (mcpConfig) {
        const userItems = parseVSCodeMCPConfig(mcpConfig, 'user', userSettingsPath);
        items.push(...userItems);
      }
    } catch (err) {
      // Silently skip malformed config
    }
  }

  return items;
}

/**
 * Parse a VS Code MCP config object into InstalledItem[].
 * VS Code uses the standard MCP config format.
 */
function parseVSCodeMCPConfig(config: any, scope: 'user' | 'project', configPath: string): InstalledItem[] {
  const items: InstalledItem[] = [];

  const mcpServers = config.mcpServers || config.servers || config || {};

  for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
    if (!serverConfig || typeof serverConfig !== 'object') continue;

    const typedConfig = serverConfig as MCPServerConfig;
    let launchCmd: string | undefined;

    if (typedConfig.type === 'http' && typedConfig.url) {
      launchCmd = `${typedConfig.type} ${typedConfig.url}`;
    } else if (typedConfig.command) {
      launchCmd = `${typedConfig.command} ${(typedConfig.args || []).join(' ')}`;
    }

    items.push({
      id: `${serverName}@vscode@${scope}`,
      kind: 'mcp',
      name: serverName,
      agent: 'vscode',
      scope,
      config_path: configPath,
      launch_command: launchCmd,
      description: typedConfig.description,
      last_seen: new Date().toISOString(),
    });
  }

  return items;
}

export default { scanVSCode };