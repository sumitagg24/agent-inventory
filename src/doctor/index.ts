/**
 * Agent Inventory Tool — Doctor checks (8.4) shared by CLI + API.
 * Fast, no process spawning. Includes secrets hygiene findings (8.9).
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { scanItemForSecrets } from '../secrets/scan.js';

export interface DoctorIssue {
  item: string;
  agent: string;
  scope: string;
  type: string;
  message: string;
  severity: 'error' | 'warning';
}

export function whichSync(cmd: string): boolean {
  const paths = (process.env.PATH || '').split(path.delimiter);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const p of paths) {
    for (const ext of exts) {
      try {
        if (p && fs.existsSync(path.join(p, cmd + ext))) return true;
      } catch {
        // ignore
      }
    }
  }
  return false;
}

export function resolveConfigPath(configPath: string): string {
  if (configPath.startsWith('~')) return path.join(os.homedir(), configPath.slice(1));
  return configPath;
}

/** Validate raw JSON of a config file; returns error message or null. */
export function validateConfigJson(resolvedPath: string): string | null {
  try {
    if (!fs.existsSync(resolvedPath)) return 'config file does not exist';
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) return null; // skills dir entry — not JSON
    if (!resolvedPath.endsWith('.json')) return null;
    JSON.parse(fs.readFileSync(resolvedPath, 'utf-8'));
    return null;
  } catch (e) {
    return `malformed JSON: ${(e as Error).message}`;
  }
}

export function runDoctor(items: any[]): { healthy: boolean; issues: DoctorIssue[] } {
  const issues: DoctorIssue[] = [];

  for (const item of items) {
    const resolved = resolveConfigPath(item.config_path);
    const isSkillFile = item.kind === 'skill';

    if (!fs.existsSync(resolved)) {
      issues.push({
        item: item.name, agent: item.agent, scope: item.scope,
        type: 'missing_config', message: `Config file missing: ${item.config_path}`, severity: 'error',
      });
      continue;
    }

    if (!isSkillFile) {
      const jsonErr = validateConfigJson(resolved);
      if (jsonErr) {
        issues.push({
          item: item.name, agent: item.agent, scope: item.scope,
          type: 'malformed_json', message: jsonErr, severity: 'error',
        });
      }
    }

    if (item.kind === 'mcp' && item.launch_command) {
      const binary = String(item.launch_command).split(/\s+/)[0];
      const isHttp = String(item.launch_command).startsWith('http');
      if (!isHttp && binary && !whichSync(binary) && !fs.existsSync(binary)) {
        issues.push({
          item: item.name, agent: item.agent, scope: item.scope,
          type: 'missing_binary', message: `Binary not found on PATH: ${binary}`, severity: 'warning',
        });
      }
      // No cached tools after a scan = introspection never succeeded.
      if (!itemHasTools(item)) {
        // soft signal only when we can check; CLI joins tools table separately.
      }
    }

    // Secrets hygiene (never includes secret values)
    try {
      const findings = scanItemForSecrets(item);
      for (const f of findings) {
        issues.push({
          item: item.name, agent: item.agent, scope: item.scope,
          type: 'secret_found',
          message: `Possible hardcoded credential (${f.pattern}) in ${f.location} — move to env var`,
          severity: f.severity,
        });
      }
    } catch {
      // secrets scan must never fail doctor
    }
  }

  return { healthy: issues.length === 0, issues };
}

// Overridden by CLI (which has the tools table handy); default false.
let toolsCheck: ((item: any) => boolean) | null = null;
export function setToolsCheck(fn: (item: any) => boolean): void {
  toolsCheck = fn;
}
function itemHasTools(item: any): boolean {
  try {
    return toolsCheck ? toolsCheck(item) : true;
  } catch {
    return true;
  }
}
