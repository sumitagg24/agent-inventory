/**
 * Agent Inventory Tool — Scanner for Codex + generic MCP configs.
 * Codex CLI: ~/.codex/config.toml [mcp_servers.*] + ~/.codex/skills/.
 * Generic: mcp.json-shaped files under known dirs (Kiro etc.).
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { InstalledItem } from '../types.js';

export interface InstalledItemWithCaps extends InstalledItem {
  capabilities?: string;
}

interface MCPServerConfig {
  type?: string;
  url?: string;
  command?: string;
  args?: string[];
  description?: string;
}

function now(): string {
  return new Date().toISOString();
}

export function toLaunchCommand(cfg: MCPServerConfig): string | undefined {
  if (cfg.type === 'http' && cfg.url) return `http ${cfg.url}`;
  if (cfg.command) return `${cfg.command} ${(cfg.args || []).join(' ')}`;
  return undefined;
}

/** Minimal TOML reader for [mcp_servers."name"] tables (no dependency). */
export function parseCodexToml(raw: string): Record<string, MCPServerConfig> {
  const servers: Record<string, MCPServerConfig> = {};
  const lines = raw.split(/\r?\n/);
  let current: string | null = null;
  let cfg: MCPServerConfig | null = null;
  const flush = (): void => {
    if (current && cfg) servers[current] = cfg;
  };
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const section = t.match(/^\[mcp_servers\.["']?([^"'\]]+)["']?\]$/);
    if (section) {
      flush();
      current = section[1];
      cfg = {};
      continue;
    }
    if (/^\[/.test(t)) {
      flush();
      current = null;
      cfg = null;
      continue;
    }
    if (cfg && current) {
      const kv = t.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
      if (kv) {
        const val = kv[2].trim();
        const str = val.match(/^["'](.*)["']$/);
        if (str) {
          (cfg as any)[kv[1]] = str[1];
        } else if (val.startsWith('[')) {
          try {
            const arr = JSON.parse(val.replace(/'/g, '"'));
            if (Array.isArray(arr)) (cfg as any)[kv[1]] = arr.map(String);
          } catch {
            // ignore
          }
        } else {
          (cfg as any)[kv[1]] = val;
        }
      }
    }
  }
  flush();
  return servers;
}

export function scanCodex(): InstalledItem[] {
  const items: InstalledItem[] = [];
  const cfgPath = path.join(os.homedir(), '.codex', 'config.toml');
  if (fs.existsSync(cfgPath)) {
    try {
      const servers = parseCodexToml(fs.readFileSync(cfgPath, 'utf-8'));
      for (const [name, sc] of Object.entries(servers)) {
        items.push({
          id: `${name}@codex@user`,
          kind: 'mcp',
          name,
          agent: 'codex',
          scope: 'user',
          config_path: cfgPath,
          launch_command: toLaunchCommand(sc),
          description: sc.description,
          last_seen: now(),
        });
      }
    } catch {
      // malformed TOML — skipped, doctor flags JSON only
    }
  }
  // Codex skills: ~/.codex/skills/<name>/SKILL.md (+allowed-tools)
  const skillsDir = path.join(os.homedir(), '.codex', 'skills');
  const walk = (dir: string): void => {
    let entries: any[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name === 'SKILL.md') {
        try {
          const raw = fs.readFileSync(full, 'utf-8');
          const fm = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
          let sname: string | undefined;
          let desc: string | undefined;
          let caps: string[] = [];
          if (fm) {
            const n = fm[1].match(/^name\s*:\s*["']?(.+?)["']?\s*$/m);
            const d = fm[1].match(/^description\s*:\s*["']?(.+?)["']?\s*$/m);
            const at = fm[1].match(/^allowed-tools\s*:\s*(.+?)\s*$/m);
            if (n) sname = n[1].trim();
            if (d) desc = d[1].trim();
            if (at) caps = at[1].split(/[, ]+/).map((s) => s.trim()).filter(Boolean);
          }
          if (!sname) sname = path.basename(path.dirname(full));
          items.push({
            id: `${sname}@codex@user@${path.basename(full)}`,
            kind: 'skill',
            name: sname,
            agent: 'codex',
            scope: 'user',
            config_path: full,
            description: desc ?? (caps.length > 0 ? `Allowed tools: ${caps.join(', ')}` : undefined),
            last_seen: now(),
            capabilities: caps.length > 0 ? JSON.stringify(caps) : undefined,
          } as InstalledItem);
        } catch {
          // skip unreadable
        }
      }
    }
  };
  if (fs.existsSync(skillsDir)) walk(skillsDir);
  // Generic mcp.json-shaped discovery (Kiro + future agents)
  const cands: { agent: string; rel: string; scope: 'user' | 'project' }[] = [
    { agent: 'kiro', rel: '.kiro/settings/mcp.json', scope: 'user' },
    { agent: 'kiro', rel: '.kiro/mcp.json', scope: 'project' },
    { agent: 'codex', rel: '.codex/mcp.json', scope: 'project' },
  ];
  for (const root of [os.homedir(), process.cwd()]) {
    for (const cand of cands) {
      const full = path.join(root, cand.rel);
      if (!fs.existsSync(full)) continue;
      try {
        const cfg = JSON.parse(fs.readFileSync(full, 'utf-8'));
        const servers = cfg.mcpServers ?? cfg.servers ?? {};
        for (const [sname, sc] of Object.entries(servers as Record<string, MCPServerConfig>)) {
          if (!sc || typeof sc !== 'object') continue;
          items.push({
            id: `${sname}@${cand.agent}@${cand.scope}@${full}`,
            kind: 'mcp',
            name: sname,
            agent: cand.agent,
            scope: cand.scope,
            config_path: full,
            launch_command: toLaunchCommand(sc),
            description: (sc as MCPServerConfig).description,
            last_seen: now(),
          });
        }
      } catch {
        // malformed — doctor flags it
      }
    }
  }
  return items;
}

export default { scanCodex };

