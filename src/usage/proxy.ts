/**
 * Agent Inventory Tool — Usage tracking (8.6).
 * MCP proxy shim: `agentinv wrap <name>` rewrites an agent config so the shim
 * sits between the agent and the real MCP server, logging calls then forwarding.
 * `agentinv unwrap <name>` restores the original config byte-for-byte.
 *
 * Skills: presence-based (no separate process to observe) — recorded as
 * available, with true invocation tracking as a stretch goal.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

function resolveConfigPath(configPath: string): string {
  if (configPath.startsWith('~')) return path.join(os.homedir(), configPath.slice(1));
  return configPath;
}

function backupPath(configPath: string): string {
  return `${configPath}.agentinv-backup`;
}

export function wrapMcpWithProxy(item: any, shimPath: string): { configFile: string; backedUp: boolean } {
  const configFile = resolveConfigPath(item.config_path);
  if (!fs.existsSync(configFile)) throw new Error(`Config file not found: ${item.config_path}`);
  const raw = fs.readFileSync(configFile, 'utf-8');
  const bp = backupPath(configFile);
  let backedUp = false;
  if (!fs.existsSync(bp)) {
    fs.writeFileSync(bp, raw);
    backedUp = true;
  }
  // Only JSON mcpServers configs can be wrapped safely.
  const config = JSON.parse(raw);
  const servers = config.mcpServers ?? config.servers;
  if (!servers || typeof servers !== 'object' || !servers[item.name]) {
    throw new Error(`Cannot wrap: "${item.name}" not found as a JSON entry in ${item.config_path}`);
  }
  const original = servers[item.name];
  const prevArgs: string[] = Array.isArray(original.args) ? original.args : [];
  servers[item.name] = {
    ...original,
    command: process.execPath,
    args: [shimPath, '--item-id', item.id, '--', original.command ?? 'npx', ...prevArgs],
    _agentinvWrapped: true,
    _agentinvOriginal: { command: original.command, args: prevArgs },
  };
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  return { configFile, backedUp };
}

export function unwrapMcpProxy(item: any): { configFile: string; restored: boolean } {
  const configFile = resolveConfigPath(item.config_path);
  const bp = backupPath(configFile);
  if (fs.existsSync(bp)) {
    fs.writeFileSync(configFile, fs.readFileSync(bp, 'utf-8'));
    fs.unlinkSync(bp);
    return { configFile, restored: true };
  }
  // Fallback: unwrap inline metadata if no backup exists.
  if (fs.existsSync(configFile)) {
    try {
      const config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
      const servers = config.mcpServers ?? config.servers;
      const entry = servers?.[item.name];
      if (entry?._agentinvWrapped && entry?._agentinvOriginal) {
        servers[item.name] = { ...entry, command: entry._agentinvOriginal.command, args: entry._agentinvOriginal.args };
        delete servers[item.name]._agentinvWrapped;
        delete servers[item.name]._agentinvOriginal;
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
        return { configFile, restored: true };
      }
    } catch {
      // fall through
    }
  }
  return { configFile, restored: false };
}

export function isWrapped(item: any): boolean {
  try {
    const configFile = resolveConfigPath(item.config_path);
    if (!fs.existsSync(configFile)) return false;
    const config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    const servers = config.mcpServers ?? config.servers;
    return !!servers?.[item.name]?._agentinvWrapped || fs.existsSync(backupPath(configFile));
  } catch {
    return false;
  }
}
