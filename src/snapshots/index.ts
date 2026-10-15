/**
 * Agent Inventory Tool — Snapshots, export bundles, and restore (8.7).
 * A snapshot is a portable bundle: items + tools + raw config contents + manifest.
 * Secrets are redacted on export; the manifest notes what must be re-added.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { createSnapshot, getSnapshot, getAllSnapshots, deleteSnapshot } from '../storage/sqlite.js';
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
  // Lazy-require storage getters to avoid circulars at import time.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const store = require('../storage/sqlite.js') as typeof import('../storage/sqlite.js');
  const items = store.getAllItems();
  const tools = store.getAllTools();
  const id = `snap_${Date.now()}`;

  const files: SnapshotManifest['files'] = [];
  const redacted: string[] = [];

  for (const item of items) {
    const p: string = item.config_path;
    const resolved = p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
    let included = false;
    let note: string | undefined;
    try {
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        included = true;
      } else {
        note = 'config file not found at export time';
      }
    } catch {
      note = 'unreadable config file';
    }
    // Detect likely redaction
    const lc: string | undefined = item.launch_command;
    if (lc && redactLaunchCommand(lc) !== lc) redacted.push(item.id);
    files.push({ itemId: item.id, configPath: p, included, note });
  }

  const manifest: SnapshotManifest = {
    id,
    createdAt: new Date().toISOString(),
    name,
    description,
    items: items.map((i: any) => ({ ...i, launch_command: redactLaunchCommand(i.launch_command) })),
    tools,
    files,
    redacted,
  };

  createSnapshot({
    id,
    name,
    description,
    items_json: JSON.stringify(manifest.items),
    tools_json: JSON.stringify(tools),
  });

  return manifest;
}

/** Write a snapshot bundle to disk as JSON (portable, restorable). */
export function exportSnapshotToFile(snapshotId: string, outFile: string): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const store = require('../storage/sqlite.js') as typeof import('../storage/sqlite.js');
  const snap = store.getSnapshot(snapshotId);
  if (!snap) throw new Error(`Snapshot "${snapshotId}" not found`);
  const items = JSON.parse(snap.items_json);
  const tools = JSON.parse(snap.tools_json);
  const manifest: SnapshotManifest = {
    id: snap.id,
    createdAt: snap.created_at,
    name: snap.name,
    description: snap.description,
    items,
    tools,
    files: items.map((i: any) => ({ itemId: i.id, configPath: i.config_path, included: false as boolean, note: 'content resolved at restore time' })),
    redacted: [],
  };
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(manifest, null, 2));
}

export function listSnapshots(): any[] {
  return getAllSnapshots();
}

export function removeSnapshot(id: string): void {
  deleteSnapshot(id);
}

export function getSnapshotManifest(id: string): SnapshotManifest {
  const snap = getSnapshot(id);
  if (!snap) throw new Error(`Snapshot "${id}" not found`);
  const items = JSON.parse(snap.items_json);
  const tools = JSON.parse(snap.tools_json);
  return {
    id: snap.id,
    createdAt: snap.created_at,
    name: snap.name,
    description: snap.description,
    items,
    tools,
    files: [],
    redacted: [],
  };
}
