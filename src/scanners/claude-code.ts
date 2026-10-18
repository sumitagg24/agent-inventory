/**
 * Agent Inventory Tool — Scanner for Claude Code
 *
 * Discovers MCP servers and Skills configured for Claude Code.
 *
 * MCP config locations checked:
 *   - ~/.claude.json (global)
 *   - project .mcp.json (project scope)
 *
 * Skill locations checked:
 *   - ~/.claude/skills/ (global)
 *   - project .claude/skills/ (project scope)
 */

import fs from 'fs';
import path from 'path';
import { readJsonFile, readMarkdownFile } from './io.js';
import os from 'os';
import { parseFrontmatter, metadataString } from './frontmatter.js';
import { formatMcpLaunchSummary, redactSensitiveText } from '../security/redaction.js';

function expandUser(p: string): string {
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/** JSON-encode declared capabilities from SKILL.md frontmatter (plan §3.2.3). */
export function encodeCapabilities(data: Record<string, any>): string | undefined {
  const raw = data['allowed-tools'] ?? data.allowedTools ?? data.capabilities;
  if (!raw) return undefined;
  const list = Array.isArray(raw)
    ? raw.map(String)
    : typeof raw === 'string'
      ? raw.split(/[,\s]+/).filter(Boolean)
      : null;
  return list && list.length > 0 ? JSON.stringify(list) : undefined;
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
 * Represents a normalized installed item (MCP or Skill).
 * Note: Uses snake_case to match database column names.
 */
export interface InstalledItem {
  id: string;
  kind: "mcp" | "skill";
  name: string;
  agent: string;
  scope: "user" | "project";
  config_path: string;
  launch_command?: string;
  description?: string;
  last_seen: string;
  /** Declared capabilities (e.g. SKILL.md allowed-tools), JSON array string. */
  capabilities?: string;
}

/**
 * Scan Claude Code for MCP servers and Skills.
 * Returns array of InstalledItem.
 */
export function scanClaudeCode(): InstalledItem[] {
  const items: InstalledItem[] = [];

  // Scan for MCP servers
  const mcpItems = scanClaudeCodeMCP();
  items.push(...mcpItems);

  // Scan for Skills
  const skillItems = scanClaudeCodeSkills();
  items.push(...skillItems);

  return items;
}

/**
 * Scan Claude Code MCP config files.
 */
function scanClaudeCodeMCP(): InstalledItem[] {
  const items: InstalledItem[] = [];

  // User-level config: ~/.claude.json
  const userConfigPath = expandUser('~/.claude.json');
  if (fs.existsSync(userConfigPath)) {
    try {
      const userConfig = readJsonFile(userConfigPath);
      const userItems = parseClaudeCodeMCPConfig(userConfig, 'user');
      items.push(...userItems);
    } catch (err) {
      // Silently skip malformed config
    }
  }

  // Project-level config: .mcp.json
  const projectMcpPath = path.join(process.cwd(), '.mcp.json');
  if (fs.existsSync(projectMcpPath)) {
    try {
      const projectConfig = readJsonFile(projectMcpPath);
      const projectItems = parseClaudeCodeMCPConfig(projectConfig, 'project');
      items.push(...projectItems);
    } catch (err) {
      // Silently skip malformed config
    }
  }

  return items;
}

/**
 * Parse a Claude Code MCP config object into InstalledItem[].
 */
function parseClaudeCodeMCPConfig(config: any, scope: 'user' | 'project'): InstalledItem[] {
  const items: InstalledItem[] = [];

  const mcpServers = config.mcpServers || {};

  for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
    if (!serverConfig || typeof serverConfig !== 'object') continue;

    const typedConfig = serverConfig as MCPServerConfig;
    const launchCmd = formatMcpLaunchSummary(typedConfig);

    items.push({
      id: `${serverName}@claude-code@${scope}`,
      kind: 'mcp',
      name: serverName,
      agent: 'claude-code',
      scope,
      config_path: scope === 'user' ? '~/.claude.json' : path.resolve(process.cwd(), '.mcp.json'),
      launch_command: launchCmd,
      description: typeof typedConfig.description === 'string' ? redactSensitiveText(typedConfig.description) : undefined,
      last_seen: new Date().toISOString(),
    });
  }

  return items;
}

/**
 * Scan Claude Code for Skills (SKILL.md files).
 */
function scanClaudeCodeSkills(): InstalledItem[] {
  const items: InstalledItem[] = [];

  // User-level skills dir: ~/.claude/skills/
  const userSkillsDir = path.join(os.homedir(), '.claude', 'skills');
  if (fs.existsSync(userSkillsDir)) {
    const userItems = parseClaudeCodeSkillsDir(userSkillsDir, 'user');
    items.push(...userItems);
  }

  // Project-level skills dir: project/.claude/skills/
  const projectSkillsDir = path.join(process.cwd(), '.claude', 'skills');
  if (fs.existsSync(projectSkillsDir)) {
    const projectItems = parseClaudeCodeSkillsDir(projectSkillsDir, 'project');
    items.push(...projectItems);
  }

  return items;
}

/**
 * Parse a skills directory for SKILL.md files.
 */
function parseClaudeCodeSkillsDir(skillsDir: string, scope: 'user' | 'project'): InstalledItem[] {
  const items: InstalledItem[] = [];

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(skillsDir, entry.name);
    if (entry.isDirectory()) {
      // Recursively scan subdirectories
      const subItems = parseClaudeCodeSkillsDir(fullPath, scope);
      items.push(...subItems);
    } else if (entry.name === 'SKILL.md') {
      try {
        const fileContent = readMarkdownFile(fullPath);
        const data = parseFrontmatter(fileContent);
        const name = metadataString(data, 'name');
        if (name) {
          const description = metadataString(data, 'description');
          items.push({
            id: `${name}@claude-code@${scope}@${path.basename(fullPath)}`,
            kind: 'skill',
            name,
            agent: 'claude-code',
            scope,
            config_path: fullPath,
            description: description ? redactSensitiveText(description) : undefined,
            last_seen: new Date().toISOString(),
            capabilities: encodeCapabilities(data),
          });
        }
      } catch (err) {
        // Silently skip unreadable SKILL.md files
      }
    }
  }

  return items;
}

export default { scanClaudeCode };