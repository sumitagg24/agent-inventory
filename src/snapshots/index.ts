/**
 * Agent Inventory Tool - snapshot bundle helpers (8.7).
 * A snapshot = items + tools + actual config/SKILL.md file contents
 * (secrets redacted) + a manifest listing what was captured.
 * CRUD lives in storage/sqlite.ts.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createSnapshot, getSnapshot, getAllSnapshots, deleteSnapshot, getAllItems, getAllTools } from '../storage/sqlite.js';
import { redactLaunchCommand, redactSecretsInText } from '../secrets/scan.js';

export interface SnapshotFile {
  itemId: string;
  configPath: string;
  resolvedPath: string;
  included: boolean;
  note?: string;
  /** Redacted file contents; null when missing/unreadable or a directory. */
  content?: string | null;
}

export interface SnapshotManifest {
  id: string;
  createdAt: string;
  name?: string;
  description?: string;
  items: any[];
  tools: any[];
  files: SnapshotFile[];
  redacted: string[];
  /** Item ids whose files had secrets stripped; re-add after restore. */
  secretsRedacted: string[];
}

function resolveHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Read + redact one config/SKILL.md file for bundling. */
function captureFile(item: any): SnapshotFile {
  const resolved = resolveHome(item.config_path);
  const base: SnapshotFile = {
    itemId: item.id, configPath: item.config_path, resolvedPath: resolved,
    included: false, content: null,
  };
  try {
    const st = fs.statSync(resolved);
    if (!st.isFile()) return { ...base, note: 'directory (contents not bundled)' };
    const raw = fs.readFileSync(resolved, 'utf-8');
    const [content, didRedact] = redactSecretsInText(raw);
    return {
      ...base, included: true, content,
      note: didRedact ? 'secrets redacted - re-add after restore' : undefined,
    };
  } catch {
    return { ...base, note: 'missing at export time' };
  }
}

export function takeSnapshot(name?: string, description?: string): SnapshotManifest {
  const items = getAllItems();
  const tools = getAllTools();
  const id = `snap_${Date.now()}`;
  const files: SnapshotFile[] = [];
  const redacted: string[] = [];
  const secretsRedacted: string[] = [];
  for (const item of items) {
    const f = captureFile(item);
    if (f.note && f.note.startsWith('secrets redacted')) secretsRedacted.push(item.id);
    files.push(f);
    const lc: string | undefined = item.launch_command;
    if (lc && redactLaunchCommand(lc) !== lc) redacted.push(item.id);
  }
  const manifest: SnapshotManifest = {
    id, createdAt: new Date().toISOString(), name, description,
    items: items.map((i: any) => ({ ...i, launch_command: redactLaunchCommand(i.launch_command) })),
    tools, files, redacted, secretsRedacted,
  };
  createSnapshot({
    id, name, description,
    items_json: JSON.stringify(manifest.items),
    tools_json: JSON.stringify(tools),
    files_json: JSON.stringify(files),
  });
  return manifest;
}

/** Rebuild the full manifest from a stored snapshot row. */
export function manifestFromSnapshot(snap: any): SnapshotManifest {
  const items = JSON.parse(snap.items_json);
  const tools = JSON.parse(snap.tools_json);
  let files: SnapshotFile[] = [];
  try {
    files = snap.files_json ? JSON.parse(snap.files_json) : [];
  } catch {
    files = [];
  }
  // Older snapshots predate file capture: mark files as not bundled.
  if (files.length === 0) {
    files = items.map((i: any) => ({
      itemId: i.id, configPath: i.config_path, resolvedPath: resolveHome(i.config_path),
      included: false, note: 'not bundled (snapshot predates file capture)',
    }));
  }
  const redacted = items
    .filter((i: any) => i.launch_command && redactLaunchCommand(i.launch_command) !== i.launch_command)
    .map((i: any) => i.id);
  const secretsRedacted = files
    .filter((f) => f.note && f.note.startsWith('secrets redacted'))
    .map((f) => f.itemId);
  return {
    id: snap.id, createdAt: snap.created_at, name: snap.name, description: snap.description,
    items, tools, files, redacted, secretsRedacted,
  };
}

export function exportSnapshotToFile(snapshotId: string, outFile: string): void {
  const snap = getSnapshot(snapshotId) ?? getAllSnapshots().find((s) => s.name === snapshotId);
  if (!snap) throw new Error(`Snapshot not found`);
  const manifest = manifestFromSnapshot(snap);
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(manifest, null, 2));
}

/**
 * Restore bundled files to their original paths (8.7.2).
 * Caller must have confirmed; returns per-file results.
 */
export function restoreSnapshotFiles(
  manifest: SnapshotManifest,
  opts: { onlyItemId?: string } = {},
): { written: string[]; skipped: { path: string; reason: string }[] } {
  const written: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
  for (const f of manifest.files) {
    if (opts.onlyItemId && f.itemId !== opts.onlyItemId) continue;
    if (!f.included || typeof f.content !== 'string') {
      skipped.push({ path: f.configPath, reason: f.note ?? 'not bundled' });
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(f.resolvedPath), { recursive: true });
      fs.writeFileSync(f.resolvedPath, f.content, 'utf-8');
      written.push(f.configPath);
    } catch (err) {
      skipped.push({ path: f.configPath, reason: (err as Error).message });
    }
  }
  return { written, skipped };
}

export function removeSnapshot(id: string): void { deleteSnapshot(id); }