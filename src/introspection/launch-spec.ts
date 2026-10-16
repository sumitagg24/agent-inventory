import os from 'node:os';
import path from 'node:path';
import { readJsonFile } from '../scanners/io.js';

export interface InventoryMcpItem {
  name: string;
  agent: string;
  config_path: string;
}

/** Values are read only immediately before an explicitly approved inspection. */
export interface McpLaunchSpec {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

export function resolveConfigPath(configPath: string): string {
  if (configPath === '~') return os.homedir();
  if (configPath.startsWith('~/') || configPath.startsWith('~\\')) {
    return path.join(os.homedir(), configPath.slice(2));
  }
  return configPath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function findServerConfig(root: Record<string, unknown>, agent: string, name: string): unknown {
  const possibleRoots: unknown[] = [
    root.mcpServers,
    root.servers,
    isRecord(root.mcp) ? root.mcp.mcpServers : undefined,
    isRecord(root.mcp) ? root.mcp.servers : undefined,
    isRecord(root.mcp) ? root.mcp : undefined,
  ];

  // VS Code settings can use either `mcp.servers` or the older `mcp.servers` setting key.
  if (agent === 'vscode') {
    const settingServers = root['mcp.servers'];
    if (isRecord(settingServers)) possibleRoots.push(settingServers);
  }

  for (const possible of possibleRoots) {
    if (Array.isArray(possible)) {
      const match = possible.find((entry) => isRecord(entry) && entry.name === name);
      if (match) return match;
      continue;
    }
    if (isRecord(possible) && Object.hasOwn(possible, name)) {
      return possible[name];
    }
  }

  return undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (!entries.every(([, entry]) => typeof entry === 'string')) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}

/**
 * Re-read a server's configuration instead of persisting raw args, URLs, or credentials
 * in the local inventory database. This function never executes the config.
 */
export function readMcpLaunchSpec(item: InventoryMcpItem): McpLaunchSpec {
  const configPath = resolveConfigPath(item.config_path);
  let root: unknown;
  try {
    root = readJsonFile(configPath);
  } catch {
    throw new Error('The MCP configuration could not be read or parsed.');
  }

  if (!isRecord(root)) {
    throw new Error('The MCP configuration has an unsupported format.');
  }

  const rawServer = findServerConfig(root, item.agent, item.name);
  if (!isRecord(rawServer)) {
    throw new Error('The server entry was not found in its configuration file.');
  }

  const url = typeof rawServer.url === 'string' ? rawServer.url : undefined;
  const type = typeof rawServer.type === 'string' ? rawServer.type.toLowerCase() : '';
  if (url && (type === 'http' || type === 'streamable-http' || !rawServer.command)) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error('The configured MCP URL is invalid.');
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error('Only HTTP and HTTPS MCP URLs are supported for inspection.');
    }

    return {
      url: parsedUrl.toString(),
      headers: stringRecord(rawServer.headers),
    };
  }

  if (typeof rawServer.command !== 'string' || rawServer.command.trim() === '') {
    throw new Error('The configured MCP entry has no executable command.');
  }

  const args = rawServer.args === undefined
    ? []
    : Array.isArray(rawServer.args) && rawServer.args.every((arg) => typeof arg === 'string')
      ? rawServer.args as string[]
      : undefined;
  if (!args) {
    throw new Error('The configured MCP argument list is invalid.');
  }

  const env = rawServer.env === undefined ? undefined : stringRecord(rawServer.env);
  if (rawServer.env !== undefined && !env) {
    throw new Error('The configured MCP environment block contains non-string values.');
  }

  return {
    command: rawServer.command,
    args,
    env,
    cwd: typeof rawServer.cwd === 'string' ? rawServer.cwd : undefined,
  };
}
