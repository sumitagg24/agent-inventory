/**
 * Agent Inventory Tool — Scanner for Windsurf (Codeium)
 *
 * Discovers MCP servers configured for Windsurf.
 *
 * MCP config locations checked:
 *   - ~/.codeium/windsurf/mcp_config.json (user)
 *   - project .windsurf/mcp_config.json (project - if exists)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

import { InstalledItem } from './claude-code.js';

function expandUser(p: string): string {
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

interface MCPServerConfig {
  type?: string;
  url?: string;
  command?: string;
  args?: string[];
  description?: string;
  env?: Record<string, string>;
  name?: string;
}

/**
 * Scan Windsurf for MCP servers.
 */
export function scanWindsurf(): InstalledItem[] {
  const items: InstalledItem[] = [];

  // Scan for MCP servers
  const mcpItems = scanWindsurfMCP();
  items.push(...mcpItems);

  return items;
}

/**
 * Scan Windsurf MCP config files.
 */
function scanWindsurfMCP(): InstalledItem[] {
  const items: InstalledItem[] = [];

  // User-level config: ~/.codeium/windsurf/mcp_config.json
  const userConfigPath = expandUser('~/.codeium/windsurf/mcp_config.json');
  if (fs.existsSync(userConfigPath)) {
    try {
      const userConfig = JSON.parse(fs.readFileSync(userConfigPath, 'utf-8'));
      const userItems = parseWindsurfMCPConfig(userConfig, 'user');
      items.push(...userItems);
    } catch (err) {
      // Silently skip malformed config
    }
  }

  // Project-level config: .windsurf/mcp_config.json (if it exists)
  const projectMcpPath = path.join(process.cwd(), '.windsurf', 'mcp_config.json');
  if (fs.existsSync(projectMcpPath)) {
    try {
      const projectConfig = JSON.parse(fs.readFileSync(projectMcpPath, 'utf-8'));
      const projectItems = parseWindsurfMCPConfig(projectConfig, 'project');
      items.push(...projectItems);
    } catch (err) {
      // Silently skip malformed config
    }
  }

  return items;
}

/**
 * Parse a Windsurf MCP config object into InstalledItem[].
 * Windsurf uses a slightly different format: mcpServers array or object.
 */
function parseWindsurfMCPConfig(config: any, scope: 'user' | 'project'): InstalledItem[] {
  const items: InstalledItem[] = [];

  // Windsurf can have mcpServers as array or object
  let mcpServers: Record<string, MCPServerConfig> = {};

  if (Array.isArray(config.mcpServers)) {
    // Array format: [{"name": "...", "command": "...", ...}]
    for (const server of config.mcpServers) {
      if (server.name) {
        mcpServers[server.name] = server as MCPServerConfig;
      }
    }
  } else if (config.mcpServers && typeof config.mcpServers === 'object') {
    // Object format: {"server-name": {...}}
    mcpServers = config.mcpServers as Record<string, MCPServerConfig>;
  }

  for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
    if (!serverConfig || typeof serverConfig !== 'object') continue;

    const typedConfig = serverConfig as MCPServerConfig;
    let launchCmd: string | undefined;

    if (typedConfig.type === 'http' && typedConfig.url) {
      launchCmd = `${typedConfig.type} ${typedConfig.url}`;
    } else if (typedConfig.command) {
      launchCmd = `${typedConfig.command} ${(typedConfig.args || []).join(' ')}`;
    }

    const configPath = scope === 'user'
      ? '~/.codeium/windsurf/mcp_config.json'
      : path.resolve(process.cwd(), '.windsurf', 'mcp_config.json');

    items.push({
      id: `${serverName}@windsurf@${scope}`,
      kind: 'mcp',
      name: serverName,
      agent: 'windsurf',
      scope,
      config_path: configPath,
      launch_command: launchCmd,
      description: typedConfig.description,
      last_seen: new Date().toISOString(),
    });
  }

  return items;
}

export default { scanWindsurf };