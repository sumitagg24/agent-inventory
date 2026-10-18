/**
 * Agent Inventory Tool — Scanner for Cursor
 *
 * Discovers MCP servers and Skills configured for Cursor.
 *
 * MCP config locations checked:
 *   - ~/.cursor/mcp.json (user)
 *   - project .cursor/mcp.json (project)
 *
 * Skills locations checked:
 *   - ~/.cursor/rules/ (user) - Cursor rules/skills equivalent
 *   - project .cursor/rules/ (project)
 */

import fs from 'fs';
import path from 'path';
import { readJsonFile, readMarkdownFile } from './io.js';
import os from 'os';
import { parseFrontmatter, metadataString } from './frontmatter.js';
import { formatMcpLaunchSummary, redactSensitiveText } from '../security/redaction.js';

import { InstalledItem, encodeCapabilities } from './claude-code.js';

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
}

/**
 * Scan Cursor for MCP servers and Skills.
 */
export function scanCursor(): InstalledItem[] {
  const items: InstalledItem[] = [];

  // Scan for MCP servers
  const mcpItems = scanCursorMCP();
  items.push(...mcpItems);

  // Scan for Skills (Cursor rules)
  const skillItems = scanCursorSkills();
  items.push(...skillItems);

  return items;
}

/**
 * Scan Cursor MCP config files.
 */
function scanCursorMCP(): InstalledItem[] {
  const items: InstalledItem[] = [];

  // User-level config: ~/.cursor/mcp.json
  const userConfigPath = expandUser('~/.cursor/mcp.json');
  if (fs.existsSync(userConfigPath)) {
    try {
      const userConfig = readJsonFile(userConfigPath);
      const userItems = parseCursorMCPConfig(userConfig, 'user');
      items.push(...userItems);
    } catch (err) {
      // Silently skip malformed config
    }
  }

  // Project-level config: .cursor/mcp.json
  const projectMcpPath = path.join(process.cwd(), '.cursor', 'mcp.json');
  if (fs.existsSync(projectMcpPath)) {
    try {
      const projectConfig = readJsonFile(projectMcpPath);
      const projectItems = parseCursorMCPConfig(projectConfig, 'project');
      items.push(...projectItems);
    } catch (err) {
      // Silently skip malformed config
    }
  }

  return items;
}

/**
 * Parse a Cursor MCP config object into InstalledItem[].
 * Cursor uses the same MCP config format as Claude Code.
 */
function parseCursorMCPConfig(config: any, scope: 'user' | 'project'): InstalledItem[] {
  const items: InstalledItem[] = [];

  const mcpServers = config.mcpServers || {};

  for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
    if (!serverConfig || typeof serverConfig !== 'object') continue;

    const typedConfig = serverConfig as MCPServerConfig;
    const launchCmd = formatMcpLaunchSummary(typedConfig);

    items.push({
      id: `${serverName}@cursor@${scope}`,
      kind: 'mcp',
      name: serverName,
      agent: 'cursor',
      scope,
      config_path: scope === 'user' ? '~/.cursor/mcp.json' : path.resolve(process.cwd(), '.cursor', 'mcp.json'),
      launch_command: launchCmd,
      description: typeof typedConfig.description === 'string' ? redactSensitiveText(typedConfig.description) : undefined,
      last_seen: new Date().toISOString(),
    });
  }

  return items;
}

/**
 * Scan Cursor for Skills (rules directory with .mdc files).
 */
function scanCursorSkills(): InstalledItem[] {
  const items: InstalledItem[] = [];

  // User-level rules dir: ~/.cursor/rules/
  const userRulesDir = expandUser('~/.cursor/rules');
  if (fs.existsSync(userRulesDir)) {
    const userItems = parseCursorRulesDir(userRulesDir, 'user');
    items.push(...userItems);
  }

  // Project-level rules dir: project/.cursor/rules/
  const projectRulesDir = path.join(process.cwd(), '.cursor', 'rules');
  if (fs.existsSync(projectRulesDir)) {
    const projectItems = parseCursorRulesDir(projectRulesDir, 'project');
    items.push(...projectItems);
  }

  return items;
}

/**
 * Parse a Cursor rules directory for .mdc files.
 * Cursor rules are markdown files with frontmatter.
 */
function parseCursorRulesDir(rulesDir: string, scope: 'user' | 'project'): InstalledItem[] {
  const items: InstalledItem[] = [];

  function walkDir(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else if (entry.name.endsWith('.mdc')) {
        try {
          const fileContent = readMarkdownFile(fullPath);
          const data = parseFrontmatter(fileContent);
          const description = metadataString(data, 'description');
          const skillName = metadataString(data, 'name') || path.basename(fullPath, '.mdc');
          if (description || data.name) {
            items.push({
              id: `${skillName}@cursor@${scope}@${path.basename(fullPath)}`,
              kind: 'skill',
              name: skillName,
              agent: 'cursor',
              scope,
              config_path: fullPath,
              description: description ? redactSensitiveText(description) : undefined,
              last_seen: new Date().toISOString(),
              capabilities: encodeCapabilities(data),
            });
          }
        } catch (err) {
          // Silently skip unreadable files
        }
      }
    }
  }

  walkDir(rulesDir);
  return items;
}

export default { scanCursor, parseCursorRulesDir };