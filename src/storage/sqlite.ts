import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactSensitiveObject, redactSensitiveText } from '../security/redaction.js';

let database: Database.Database | undefined;

export function getDbPath(): string {
  return path.join(
    process.env.HOME || process.env.USERPROFILE || '.',
    '.agent-inventory',
    'db.sqlite'
  );
}

function initializeDatabase(): Database.Database {
  const dataDir = process.env.AGENT_INVENTORY_DATA_DIR
    ? path.resolve(process.env.AGENT_INVENTORY_DATA_DIR)
    : path.join(os.homedir(), '.agent-inventory');
  const dbPath = path.join(dataDir, 'db.sqlite');

  // Keep local inventory data private on POSIX systems. Windows uses the current
  // user's profile ACLs; Node's mode option does not replace Windows ACL management.
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(dataDir, 0o700);
    } catch {
      // Continue using the effective permissions if chmod is unavailable.
    }
  }

  const db = new Database(dbPath);
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(dbPath, 0o600);
    } catch {
      // The containing directory remains restricted to the current user.
    }
  }
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      agent TEXT NOT NULL,
      scope TEXT NOT NULL,
      config_path TEXT NOT NULL,
      launch_command TEXT,
      launch_command_raw TEXT,
      description TEXT,
      last_seen TEXT NOT NULL,
      last_introspected TEXT,
      introspection_status TEXT DEFAULT 'never',
      introspection_error TEXT,
      introspected_at TEXT,
      capabilities TEXT,
      license TEXT,
      source TEXT
    );

    CREATE TABLE IF NOT EXISTS tools (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES items(id),
      tool_name TEXT NOT NULL,
      tool_description TEXT,
      input_schema_json TEXT
    );

    CREATE TABLE IF NOT EXISTS scans (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      items_found INTEGER
    );

    CREATE TABLE IF NOT EXISTS scan_items (
      scan_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      PRIMARY KEY (scan_id, item_id)
    );

    CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES items(id),
      tool_name TEXT,
      timestamp TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      name TEXT,
      description TEXT,
      items_json TEXT NOT NULL,
      tools_json TEXT NOT NULL,
      files_json TEXT
    );

    CREATE TABLE IF NOT EXISTS team_baseline (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      agent TEXT,
      min_version TEXT,
      required BOOLEAN DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      action TEXT NOT NULL,
      item_id TEXT,
      item_name TEXT,
      agent TEXT,
      details TEXT,
      user TEXT
    );

    CREATE TABLE IF NOT EXISTS secrets_scan (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES items(id),
      pattern TEXT NOT NULL,
      location TEXT NOT NULL,
      severity TEXT NOT NULL,
      scanned_at TEXT NOT NULL
    );
  `);

  // Safe additive migrations for DBs created by older versions.
  function migrate(): void {
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(items)`).all() as any[]).map((c) => c.name),
    );
    const add = (name: string, ddl: string): void => {
      if (!cols.has(name)) {
        db.exec(`ALTER TABLE items ADD COLUMN ${ddl}`);
        cols.add(name);
      }
    };
    add('launch_command_raw', 'launch_command_raw TEXT');
    add('introspection_status', `introspection_status TEXT DEFAULT 'never'`);
    add('introspection_error', 'introspection_error TEXT');
    add('introspected_at', 'introspected_at TEXT');
    add('capabilities', 'capabilities TEXT');
    add('license', 'license TEXT');
    add('source', 'source TEXT');
    const snapCols = new Set(
      (db.prepare(`PRAGMA table_info(snapshots)`).all() as any[]).map((c) => c.name),
    );
    if (!snapCols.has('files_json')) db.exec(`ALTER TABLE snapshots ADD COLUMN files_json TEXT`);
  }
  migrate();

  // Remove common credentials that older versions may have stored in commands or schemas.
  const oldItems = db.prepare('SELECT id, launch_command, description FROM items').all() as Array<{
    id: string;
    launch_command: string | null;
    description: string | null;
  }>;
  const updateItem = db.prepare('UPDATE items SET launch_command = ?, description = ? WHERE id = ?');
  const oldTools = db.prepare('SELECT id, tool_name, tool_description, input_schema_json FROM tools').all() as Array<{
    id: string;
    tool_name: string;
    tool_description: string | null;
    input_schema_json: string | null;
  }>;
  const updateTool = db.prepare('UPDATE tools SET tool_name = ?, tool_description = ?, input_schema_json = ? WHERE id = ?');
  const sanitizeRows = db.transaction(() => {
    for (const item of oldItems) {
      const command = item.launch_command ? redactSensitiveText(item.launch_command) : item.launch_command;
      const description = item.description ? redactSensitiveText(item.description) : item.description;
      if (command !== item.launch_command || description !== item.description) {
        updateItem.run(command, description, item.id);
      }
    }
    for (const tool of oldTools) {
      const name = redactSensitiveText(tool.tool_name);
      const description = tool.tool_description ? redactSensitiveText(tool.tool_description) : tool.tool_description;
      let schema = tool.input_schema_json;
      if (schema) {
        try {
          schema = JSON.stringify(redactSensitiveObject(JSON.parse(schema)));
        } catch {
          // Leave non-JSON legacy values intact rather than discarding user data.
        }
      }
      if (name !== tool.tool_name || description !== tool.tool_description || schema !== tool.input_schema_json) {
        updateTool.run(name, description, schema, tool.id);
      }
    }
  });
  sanitizeRows();
  return db;
}

/** Open the local database on first use; importing the CLI for `--help` is side-effect free. */
export function getDb(): Database.Database {
  database ??= initializeDatabase();
  return database;
}

// ===== Items =====

export function upsertItem(item: {
  id: string;
  kind: string;
  name: string;
  agent: string;
  scope: string;
  config_path: string;
  launch_command?: string;
  launch_command_raw?: string;
  description?: string;
  last_seen: string;
  introspection_status?: string;
  introspection_error?: string;
  introspected_at?: string;
  capabilities?: string;
  license?: string;
  source?: string;
}): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO items (id, kind, name, agent, scope, config_path, launch_command, launch_command_raw, description, last_seen, last_introspected, introspection_status, introspection_error, introspected_at, capabilities, license, source)
    VALUES (@id, @kind, @name, @agent, @scope, @config_path, @launch_command, @launch_command_raw, @description, @last_seen, @last_introspected, COALESCE(@introspection_status, 'never'), @introspection_error, @introspected_at, @capabilities, @license, @source)
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind,
      name = excluded.name,
      agent = excluded.agent,
      scope = excluded.scope,
      config_path = excluded.config_path,
      launch_command = excluded.launch_command,
      launch_command_raw = COALESCE(excluded.launch_command_raw, items.launch_command_raw),
      description = excluded.description,
      last_seen = excluded.last_seen,
      last_introspected = COALESCE(excluded.last_introspected, items.last_introspected),
      capabilities = COALESCE(excluded.capabilities, items.capabilities),
      license = COALESCE(excluded.license, items.license),
      source = COALESCE(excluded.source, items.source)
  `);
  stmt.run({
    id: item.id,
    kind: item.kind,
    name: item.name,
    agent: item.agent,
    scope: item.scope,
    config_path: item.config_path,
    launch_command: item.launch_command,
    launch_command_raw: (item as any).launch_command_raw ?? null,
    description: item.description,
    last_seen: item.last_seen,
    last_introspected: (item as any).last_introspected ?? null,
    introspection_status: (item as any).introspection_status ?? null,
    introspection_error: (item as any).introspection_error ?? null,
    introspected_at: (item as any).introspected_at ?? null,
    capabilities: (item as any).capabilities ?? null,
    license: (item as any).license ?? null,
    source: (item as any).source ?? null,
  });
}

export function setIntrospectionResult(itemId: string, ok: boolean, error?: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE items SET introspection_status = ?, introspection_error = ?, introspected_at = ? WHERE id = ?`,
  ).run(ok ? 'ok' : 'failed', error ?? null, new Date().toISOString(), itemId);
}

export function setItemCapabilities(itemId: string, capabilities: string): void {
  const db = getDb();
  db.prepare(`UPDATE items SET capabilities = ? WHERE id = ?`).run(capabilities, itemId);
}

export function setItemLicense(itemId: string, license: string | null, source: string | null): void {
  const db = getDb();
  db.prepare(`UPDATE items SET license = ?, source = ? WHERE id = ?`).run(license, source, itemId);
}

export function getAllItems(): any[] {
  return getDb().prepare('SELECT * FROM items').all();
}

export function getItemsByKind(kind: string): any[] {
  return getDb().prepare('SELECT * FROM items WHERE kind = ?').all([kind]);
}

export function getItemById(id: string): any | null {
  return getDb().prepare('SELECT * FROM items WHERE id = ?').get(id) ?? null;
}

export function deleteInventoryItem(itemId: string): void {
  const db = getDb();
  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM tools WHERE item_id = ?').run(itemId);
    db.prepare('DELETE FROM items WHERE id = ?').run(itemId);
  });
  transaction();
}

export function deleteItem(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM items WHERE id = ?').run(id);
  db.prepare('DELETE FROM tools WHERE item_id = ?').run(id);
  db.prepare('DELETE FROM usage_events WHERE item_id = ?').run(id);
}

// ===== Tools =====

export function upsertTool(tool: {
  id: string;
  item_id: string;
  tool_name: string;
  tool_description?: string;
  input_schema_json?: string;
}): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO tools (id, item_id, tool_name, tool_description, input_schema_json)
    VALUES (@id, @item_id, @tool_name, @tool_description, @input_schema_json)
    ON CONFLICT(id) DO UPDATE SET
      item_id = excluded.item_id,
      tool_name = excluded.tool_name,
      tool_description = excluded.tool_description,
      input_schema_json = excluded.input_schema_json
  `);
  stmt.run({
    id: tool.id,
    item_id: tool.item_id,
    tool_name: tool.tool_name,
    tool_description: tool.tool_description,
    input_schema_json: tool.input_schema_json,
  });
}

export function getToolsByItemId(itemId: string): any[] {
  return getDb().prepare('SELECT * FROM tools WHERE item_id = ?').all([itemId]);
}

export function getAllTools(): any[] {
  return getDb().prepare(`
    SELECT t.*, i.name as item_name, i.agent, i.kind
    FROM tools t
    JOIN items i ON t.item_id = i.id
    ORDER BY i.agent, i.name, t.tool_name
  `).all();
}

export function getLastIntrospected(itemId: string): string | null {
  const row = getDb().prepare('SELECT last_introspected FROM items WHERE id = ?').get(itemId) as
    | { last_introspected: string | null }
    | undefined;
  return row?.last_introspected ?? null;
}

/** Replace cached tool metadata only after a successful introspection. */
export function replaceToolsForItem(
  itemId: string,
  tools: Array<{ id: string; tool_name: string; tool_description?: string; input_schema_json?: string }>,
  inspectedAt = new Date().toISOString(),
): void {
  const db = getDb();
  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM tools WHERE item_id = ?').run(itemId);
    const insert = db.prepare(`
      INSERT INTO tools (id, item_id, tool_name, tool_description, input_schema_json)
      VALUES (@id, @item_id, @tool_name, @tool_description, @input_schema_json)
    `);
    for (const tool of tools) {
      insert.run({
        id: tool.id,
        item_id: itemId,
        tool_name: tool.tool_name,
        tool_description: tool.tool_description,
        input_schema_json: tool.input_schema_json,
      });
    }
    db.prepare('UPDATE items SET last_introspected = ? WHERE id = ?').run(inspectedAt, itemId);
  });
  transaction();
}

// ===== Scans =====

export function recordScan(scanId: string, itemsFound: number, startedAt = new Date().toISOString()): void {
  const finishedAt = new Date().toISOString();
  const stmt = getDb().prepare(`
    INSERT INTO scans (id, started_at, finished_at, items_found)
    VALUES (@id, @started_at, @finished_at, @items_found)
    ON CONFLICT(id) DO UPDATE SET
      started_at = excluded.started_at,
      finished_at = excluded.finished_at,
      items_found = excluded.items_found
  `);
  stmt.run({ id: scanId, started_at: startedAt, finished_at: finishedAt, items_found: itemsFound });
}

export function finishScan(scanId: string): void {
  const finishedAt = new Date().toISOString();
  getDb().prepare('UPDATE scans SET finished_at = ? WHERE id = ?').run(finishedAt, scanId);
}

export function getLatestScan(): any | null {
  return getDb().prepare('SELECT * FROM scans ORDER BY started_at DESC LIMIT 1').get() ?? null;
}

export function getAllScans(): any[] {
  return getDb().prepare('SELECT * FROM scans ORDER BY started_at DESC').all();
}

export function getScanById(scanId: string): any | null {
  return getDb().prepare('SELECT * FROM scans WHERE id = ?').get(scanId);
}

export function recordScanItem(scanId: string, itemId: string): void {
  getDb().prepare('INSERT OR IGNORE INTO scan_items (scan_id, item_id) VALUES (?, ?)').run(scanId, itemId);
}

// ===== Usage Tracking =====

export function recordUsageEvent(event: {
  id: string;
  item_id: string;
  tool_name?: string;
  timestamp: string;
}): void {
  const stmt = getDb().prepare(`
    INSERT INTO usage_events (id, item_id, tool_name, timestamp)
    VALUES (@id, @item_id, @tool_name, @timestamp)
  `);
  stmt.run(event);
}

export function getUsageEvents(itemId?: string, days?: number): any[] {
  let query = 'SELECT * FROM usage_events';
  const params: any[] = [];

  if (itemId || days) {
    query += ' WHERE';
    const conditions: string[] = [];
    if (itemId) {
      conditions.push('item_id = ?');
      params.push(itemId);
    }
    if (days) {
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      conditions.push('timestamp >= ?');
      params.push(cutoff);
    }
    query += ' ' + conditions.join(' AND ');
  }

  query += ' ORDER BY timestamp DESC';
  return getDb().prepare(query).all(...params);
}

export function getUsageSummary(days: number = 30): any[] {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return getDb().prepare(`
    SELECT
      i.id,
      i.name,
      i.agent,
      i.kind,
      COUNT(ue.id) as event_count,
      MAX(ue.timestamp) as last_used
    FROM items i
    LEFT JOIN usage_events ue ON i.id = ue.item_id AND ue.timestamp >= ?
    GROUP BY i.id
    ORDER BY event_count DESC
  `).all(cutoff);
}

// ===== Snapshots =====

export function createSnapshot(snapshot: {
  id: string;
  name?: string;
  description?: string;
  items_json: string;
  tools_json: string;
  files_json?: string;
}): void {
  const stmt = getDb().prepare(`
    INSERT INTO snapshots (id, created_at, name, description, items_json, tools_json, files_json)
    VALUES (@id, @created_at, @name, @description, @items_json, @tools_json, @files_json)
  `);
  stmt.run({
    id: snapshot.id,
    created_at: new Date().toISOString(),
    name: snapshot.name,
    description: snapshot.description,
    items_json: snapshot.items_json,
    tools_json: snapshot.tools_json,
    files_json: snapshot.files_json ?? null,
  });
}

export function getSnapshot(snapshotId: string): any | null {
  return getDb().prepare('SELECT * FROM snapshots WHERE id = ?').get(snapshotId);
}

export function getAllSnapshots(): any[] {
  return getDb().prepare('SELECT id, created_at, name, description, items_json, tools_json, files_json FROM snapshots ORDER BY created_at DESC').all();
}

export function deleteSnapshot(snapshotId: string): void {
  getDb().prepare('DELETE FROM snapshots WHERE id = ?').run(snapshotId);
}

// ===== Team Baseline =====

export function addTeamBaselineItem(item: {
  id: string;
  name: string;
  kind: string;
  agent?: string;
  min_version?: string;
  required?: boolean;
}): void {
  const stmt = getDb().prepare(`
    INSERT INTO team_baseline (id, name, kind, agent, min_version, required, created_at)
    VALUES (@id, @name, @kind, @agent, @min_version, @required, @created_at)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      kind = excluded.kind,
      agent = excluded.agent,
      min_version = excluded.min_version,
      required = excluded.required
  `);
  stmt.run({
    id: item.id,
    name: item.name,
    kind: item.kind,
    agent: item.agent,
    min_version: item.min_version,
    required: item.required ?? 1,
    created_at: new Date().toISOString(),
  });
}

export function getTeamBaseline(): any[] {
  return getDb().prepare('SELECT * FROM team_baseline ORDER BY kind, name').all();
}

export function removeTeamBaselineItem(id: string): void {
  getDb().prepare('DELETE FROM team_baseline WHERE id = ?').run(id);
}

export function checkTeamBaseline(): { missing: any[]; extra: any[]; matched: any[] } {
  const baseline = getTeamBaseline();
  const current = getAllItems();
  const currentMap = new Map(current.map(i => [`${i.kind}:${i.name}:${i.agent || ''}`, i]));

  const missing: any[] = [];
  const matched: any[] = [];

  for (const b of baseline) {
    const key = `${b.kind}:${b.name}:${b.agent || ''}`;
    if (currentMap.has(key)) {
      matched.push({ baseline: b, current: currentMap.get(key) });
    } else {
      missing.push(b);
    }
  }

  const extra = current.filter(c => {
    const key = `${c.kind}:${c.name}:${c.agent || ''}`;
    return !baseline.some(b => `${b.kind}:${b.name}:${b.agent || ''}` === key);
  });

  return { missing, extra, matched };
}

// ===== Audit Log =====

export function addAuditLog(entry: {
  id: string;
  action: string;
  item_id?: string;
  item_name?: string;
  agent?: string;
  details?: string;
  user?: string;
}): void {
  const stmt = getDb().prepare(`
    INSERT INTO audit_log (id, timestamp, action, item_id, item_name, agent, details, user)
    VALUES (@id, @timestamp, @action, @item_id, @item_name, @agent, @details, @user)
  `);
  stmt.run({
    id: entry.id,
    timestamp: new Date().toISOString(),
    action: entry.action,
    item_id: entry.item_id,
    item_name: entry.item_name,
    agent: entry.agent,
    details: entry.details,
    user: entry.user,
  });
}

export function getAuditLog(limit: number = 100, offset: number = 0): any[] {
  return getDb().prepare('SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ? OFFSET ?').all(limit, offset);
}

export function getAuditLogByItem(itemId: string): any[] {
  return getDb().prepare('SELECT * FROM audit_log WHERE item_id = ? ORDER BY timestamp DESC').all(itemId);
}

// ===== Secrets Scanning =====

export function recordSecretFinding(finding: {
  id: string;
  item_id: string;
  pattern: string;
  location: string;
  severity: string;
}): void {
  const stmt = getDb().prepare(`
    INSERT INTO secrets_scan (id, item_id, pattern, location, severity, scanned_at)
    VALUES (@id, @item_id, @pattern, @location, @severity, @scanned_at)
  `);
  stmt.run({
    id: finding.id,
    item_id: finding.item_id,
    pattern: finding.pattern,
    location: finding.location,
    severity: finding.severity,
    scanned_at: new Date().toISOString(),
  });
}

export function getSecretFindings(itemId?: string): any[] {
  if (itemId) {
    return getDb().prepare('SELECT * FROM secrets_scan WHERE item_id = ? ORDER BY scanned_at DESC').all(itemId);
  }
  return getDb().prepare('SELECT ss.*, i.name as item_name, i.agent FROM secrets_scan ss JOIN items i ON ss.item_id = i.id ORDER BY scanned_at DESC').all();
}

export function clearSecretFindings(itemId?: string): void {
  if (itemId) {
    getDb().prepare('DELETE FROM secrets_scan WHERE item_id = ?').run(itemId);
  } else {
    getDb().prepare('DELETE FROM secrets_scan').run();
  }
}

// ===== Drift Detection =====

export function compareScans(scanId1: string, scanId2: string): { added: any[]; removed: any[]; changed: any[] } {
  const items1 = getDb().prepare('SELECT * FROM items WHERE id IN (SELECT item_id FROM scan_items WHERE scan_id = ?)').all(scanId1) as any[];
  const items2 = getDb().prepare('SELECT * FROM items WHERE id IN (SELECT item_id FROM scan_items WHERE scan_id = ?)').all(scanId2) as any[];

  const map1 = new Map(items1.map(i => [i.id, i]));
  const map2 = new Map(items2.map(i => [i.id, i]));

  const added = items2.filter(i => !map1.has(i.id));
  const removed = items1.filter(i => !map2.has(i.id));
  const changed = items2.filter(i => {
    const old = map1.get(i.id);
    return old && (old.launch_command !== i.launch_command || old.description !== i.description);
  });

  return { added, removed, changed };
}

// ===== Stats =====

export function getStats(): any {
  const db = getDb();
  const totalItems = db.prepare('SELECT COUNT(*) as count FROM items').get() as { count: number };
  const totalTools = db.prepare('SELECT COUNT(*) as count FROM tools').get() as { count: number };
  const byKind = db.prepare('SELECT kind, COUNT(*) as count FROM items GROUP BY kind').all();
  const byAgent = db.prepare('SELECT agent, COUNT(*) as count FROM items GROUP BY agent ORDER BY count DESC').all();
  const byScope = db.prepare('SELECT scope, COUNT(*) as count FROM items GROUP BY scope').all();
  const itemsWithTools = db.prepare('SELECT COUNT(DISTINCT item_id) as count FROM tools').get() as { count: number };
  const totalScans = db.prepare('SELECT COUNT(*) as count FROM scans').get() as { count: number };
  const totalSnapshots = db.prepare('SELECT COUNT(*) as count FROM snapshots').get() as { count: number };
  const usageEvents30d = db.prepare('SELECT COUNT(*) as count FROM usage_events WHERE timestamp >= ?').get(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()) as { count: number };

  return {
    totalItems: totalItems.count,
    totalTools: totalTools.count,
    itemsWithTools: itemsWithTools.count,
    byKind,
    byAgent,
    byScope,
    totalScans: totalScans.count,
    totalSnapshots: totalSnapshots.count,
    usageEvents30d: usageEvents30d.count,
  };
}
