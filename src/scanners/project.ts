/**
 * Agent Inventory Tool — Project Scanner
 *
 * Recursively scans a directory tree for project-level MCP configs
 * and Skills directories across all supported agents.
 *
 * Useful for monorepos or when you want to scan all projects in a folder.
 */

import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';

import { InstalledItem } from './claude-code.js';

interface ProjectScanOptions {
  rootDir: string;
  maxDepth?: number;
  includePatterns?: string[];
  excludePatterns?: string[];
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
 * Recursively scan a directory for project-level configs.
 * Returns all found items from all agents.
 */
export function scanProjects(options: ProjectScanOptions): InstalledItem[] {
  const {
    rootDir,
    maxDepth = 3,
    includePatterns = ['**'],
    excludePatterns = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.next/**'],
  } = options;

  const items: InstalledItem[] = [];
  const visited = new Set<string>();

  function shouldExclude(dir: string): boolean {
    for (const pattern of excludePatterns) {
      const regex = new RegExp(pattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*'));
      if (regex.test(dir)) return true;
    }
    return false;
  }

  function walkDir(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    if (shouldExclude(dir)) return;
    if (visited.has(dir)) return;
    visited.add(dir);

    // Check for project-level configs in this directory
    const projectItems = scanProjectDir(dir);
    items.push(...projectItems);

    // Recurse into subdirectories
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          walkDir(path.join(dir, entry.name), depth + 1);
        }
      }
    } catch (err) {
      // Skip unreadable directories
    }
  }

  walkDir(path.resolve(rootDir), 0);
  return items;
}

/**
 * Scan a single directory for all known project-level configs.
 */
function scanProjectDir(dir: string): InstalledItem[] {
  const items: InstalledItem[] = [];

  // Claude Code: .mcp.json
  const claudeMcpPath = path.join(dir, '.mcp.json');
  if (fs.existsSync(claudeMcpPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(claudeMcpPath, 'utf-8'));
      items.push(...parseClaudeCodeMCPConfig(config, 'project', claudeMcpPath));
    } catch (err) {
      // Skip malformed
    }
  }

  // Claude Code: .claude/skills/
  const claudeSkillsDir = path.join(dir, '.claude', 'skills');
  if (fs.existsSync(claudeSkillsDir)) {
    items.push(...parseClaudeCodeSkillsDir(claudeSkillsDir, 'project', claudeSkillsDir));
  }

  // Cursor: .cursor/mcp.json
  const cursorMcpPath = path.join(dir, '.cursor', 'mcp.json');
  if (fs.existsSync(cursorMcpPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(cursorMcpPath, 'utf-8'));
      items.push(...parseCursorMCPConfig(config, 'project', cursorMcpPath));
    } catch (err) {
      // Skip malformed
    }
  }

  // Cursor: .cursor/rules/
  const cursorRulesDir = path.join(dir, '.cursor', 'rules');
  if (fs.existsSync(cursorRulesDir)) {
    items.push(...parseCursorRulesDir(cursorRulesDir, 'project', cursorRulesDir));
  }

  // Windsurf: .windsurf/mcp_config.json
  const windsurfMcpPath = path.join(dir, '.windsurf', 'mcp_config.json');
  if (fs.existsSync(windsurfMcpPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(windsurfMcpPath, 'utf-8'));
      items.push(...parseWindsurfMCPConfig(config, 'project', windsurfMcpPath));
    } catch (err) {
      // Skip malformed
    }
  }

  // VS Code: .vscode/mcp.json
  const vscodeMcpPath = path.join(dir, '.vscode', 'mcp.json');
  if (fs.existsSync(vscodeMcpPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(vscodeMcpPath, 'utf-8'));
      items.push(...parseVSCodeMCPConfig(config, 'project', vscodeMcpPath));
    } catch (err) {
      // Skip malformed
    }
  }

  return items;
}

// Inline parsing functions with proper types

function parseClaudeCodeMCPConfig(config: any, scope: 'user' | 'project', configPath: string): InstalledItem[] {
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
      id: `${serverName}@claude-code@${scope}@${configPath}`,
      kind: 'mcp',
      name: serverName,
      agent: 'claude-code',
      scope,
      config_path: configPath,
      launch_command: launchCmd,
      description: typedConfig.description,
      last_seen: new Date().toISOString(),
    });
  }
  return items;
}

function parseClaudeCodeSkillsDir(skillsDir: string, scope: 'user' | 'project', configPath: string): InstalledItem[] {
  const items: InstalledItem[] = [];

  function walkDir(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else if (entry.name === 'SKILL.md') {
        try {
          const fileContent = fs.readFileSync(fullPath, 'utf-8');
          const { data } = matter(fileContent);
          if (data && data.name) {
            items.push({
              id: `${data.name}@claude-code@${scope}@${path.basename(fullPath)}`,
              kind: 'skill',
              name: data.name as string,
              agent: 'claude-code',
              scope,
              config_path: fullPath,
              description: data.description as string | undefined,
              last_seen: new Date().toISOString(),
            });
          }
        } catch (err) {
          // Skip unreadable
        }
      }
    }
  }

  walkDir(skillsDir);
  return items;
}

function parseCursorMCPConfig(config: any, scope: 'user' | 'project', configPath: string): InstalledItem[] {
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
      id: `${serverName}@cursor@${scope}@${configPath}`,
      kind: 'mcp',
      name: serverName,
      agent: 'cursor',
      scope,
      config_path: configPath,
      launch_command: launchCmd,
      description: typedConfig.description,
      last_seen: new Date().toISOString(),
    });
  }
  return items;
}

function parseCursorRulesDir(rulesDir: string, scope: 'user' | 'project', configPath: string): InstalledItem[] {
  const items: InstalledItem[] = [];

  function walkDir(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else if (entry.name.endsWith('.mdc')) {
        try {
          const fileContent = fs.readFileSync(fullPath, 'utf-8');
          const { data } = matter(fileContent);
          if (data && (data.name || data.description)) {
            const skillName = data.name as string || path.basename(fullPath, '.mdc');
            items.push({
              id: `${skillName}@cursor@${scope}@${path.basename(fullPath)}`,
              kind: 'skill',
              name: skillName,
              agent: 'cursor',
              scope,
              config_path: fullPath,
              description: data.description as string | undefined,
              last_seen: new Date().toISOString(),
            });
          }
        } catch (err) {
          // Skip unreadable
        }
      }
    }
  }

  walkDir(rulesDir);
  return items;
}

function parseWindsurfMCPConfig(config: any, scope: 'user' | 'project', configPath: string): InstalledItem[] {
  const items: InstalledItem[] = [];
  let mcpServers: Record<string, MCPServerConfig> = {};

  if (Array.isArray(config.mcpServers)) {
    for (const server of config.mcpServers) {
      if (server.name) mcpServers[server.name] = server as MCPServerConfig;
    }
  } else if (config.mcpServers && typeof config.mcpServers === 'object') {
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

    items.push({
      id: `${serverName}@windsurf@${scope}@${configPath}`,
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
      id: `${serverName}@vscode@${scope}@${configPath}`,
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

export default { scanProjects };