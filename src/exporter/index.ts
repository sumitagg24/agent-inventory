/**
 * Agent Inventory Tool — export helpers (8.7 + CLI `export`, `export-audit`).
 * Supports JSON and YAML output. Launch commands are redacted.
 */

import fs from 'fs';
import path from 'path';
import * as yaml from 'js-yaml';
import { redactLaunchCommand } from '../secrets/scan.js';

export function buildExportPayload(items: any[], toolsByItem: Map<string, any[]>): any {
  return {
    exportedAt: new Date().toISOString(),
    version: '0.1.0',
    items: items.map((item) => ({
      id: item.id,
      kind: item.kind,
      name: item.name,
      agent: item.agent,
      scope: item.scope,
      config_path: item.config_path,
      launch_command: redactLaunchCommand(item.launch_command),
      description: item.description,
      last_seen: item.last_seen,
      tools: toolsByItem.get(item.id) ?? [],
    })),
  };
}

export function writeExportFile(file: string, payload: any): void {
  const ext = path.extname(file).toLowerCase();
  const output = ext === '.yaml' || ext === '.yml' ? yaml.dump(payload) : JSON.stringify(payload, null, 2);
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, output);
}

export function buildAuditExport(log: any[], format: 'csv' | 'json'): string {
  if (format === 'json') return JSON.stringify(log, null, 2);
  const header = 'timestamp,action,item_name,agent,details,user';
  const esc = (v: any): string => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = log.map((e) =>
    [e.timestamp, e.action, e.item_name, e.agent, e.details, e.user].map(esc).join(','),
  );
  return [header, ...rows].join('\n');
}
