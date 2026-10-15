/**
 * Agent Inventory Tool — Scanner for Claude Desktop
 *
 * Discovers MCP servers configured for Claude Desktop.
 *
 * MCP config locations checked:
 *   - macOS: ~/Library/Application Support/Claude/claude_desktop_config.json
 *   - Windows: %APPDATA%\Claude\claude_desktop_config.json
 *   - Linux: ~/.config/Claude/claude_desktop_config.json
 *
 * No project-level config or skills for Claude Desktop.
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
 * Get the Claude Desktop config path for the current platform.
 */
function getClaudeDesktopConfigPath(): string | null {
  const platform = os.platform();
  const homeDir = os.homedir();

  switch (platform) {
    case 'darwin': // macOS
      return path.join(homeDir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    case 'win32': // Windows
      return path.join(process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
    case 'linux': // Linux
      return path.join(process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config'), 'Claude', 'claude_desktop_config.json');
    default:
      return null;
  }
}

/**
 * Scan Claude Desktop for MCP servers.
 */
export function scanClaudeDesktop(): InstalledItem[] {
  const items: InstalledItem[] = [];

  const configPath = getClaudeDesktopConfigPath();
  if (!configPath) {
    return items;
  }

  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const configItems = parseClaudeDesktopMCPConfig(config, configPath);
      items.push(...configItems);
    } catch (err) {
      // Silently skip malformed config
    }
  }

  return items;
}

/**
 * Parse a Claude Desktop MCP config object into InstalledItem[].
 * Uses the same format as Claude Code.
 */
function parseClaudeDesktopMCPConfig(config: any, configPath: string): InstalledItem[] {
  const items: InstalledItem[] = [];

  const mcpServers = config.mcpServers || {};

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
      id: `${serverName}@claude-desktop@user`,
      kind: 'mcp',
      name: serverName,
      agent: 'claude-desktop',
      scope: 'user',
      config_path: configPath,
      launch_command: launchCmd,
      description: typedConfig.description,
      last_seen: new Date().toISOString(),
    });
  }

  return items;
}

export default { scanClaudeDesktop };