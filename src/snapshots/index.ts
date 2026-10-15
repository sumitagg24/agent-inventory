/**
 * Agent Inventory Tool - snapshot manifest helpers (8.7).
 * CRUD lives in storage/sqlite.ts; this module builds portable bundles.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createSnapshot, getSnapshot, getAllSnapshots, deleteSnapshot, getAllItems, getAllTools } from '../storage/sqlite.js';
import { redactLaunchCommand } from '../secrets/scan.js';

export interface SnapshotManifest {
  id: string;
  createdAt: string;
  name?: string;
  description?: string;
  items: any[];
  tools: any[];
  files: { itemId: string; configPath: string; included: boolean; note?: string }[];
  redacted: string[];
}

export function takeSnapshot(name?: string, description?: string): SnapshotManifest {
  const items = getAllItems();
  const tools = getAllTools();
  const id = `snap_${Date.now()}`;
  const files: SnapshotManifest['files'] = [];
  const redacted: string[] = [];
  for (const item of items) {
    const p: string = item.config_path;
    const resolved = p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
    let included = false;
    let note: string | undefined;
    try {
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) { included = true; }
      else { note = 'missing at export time'; }
    } catch { note = 'unreadable'; }
    const lc: string | undefined = item.launch_command;
    if (lc && redactLaunchCommand(lc) !== lc) redacted.push(item.id);
    files.push({ itemId: item.id, configPath: p, included, note });
  }
  const manifest: SnapshotManifest = {
    id, createdAt: new Date().toISOString(), name, description,
    items: items.map((i: any) => ({ ...i, launch_command: redactLaunchCommand(i.launch_command) })),
    tools, files, redacted,
  };
  createSnapshot({ id, name, description, items_json: JSON.stringify(manifest.items), tools_json: JSON.stringify(tools) });
  return manifest;
}

export function exportSnapshotToFile(snapshotId: string, outFile: string): void {
  const snap = getSnapshot(snapshotId) ?? getAllSnapshots().find((s) => s.name === snapshotId);
  if (!snap) throw new Error(`Snapshot not found`);
  const items = JSON.parse(snap.items_json);
  const tools = JSON.parse(snap.tools_json);
  const manifest: SnapshotManifest = {
    id: snap.id, createdAt: snap.created_at, name: snap.name, description: snap.description,
    items, tools, files: [], redacted: [],
  };
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(manifest, null, 2));
}

export function removeSnapshot(id: string): void { deleteSnapshot(id); }

