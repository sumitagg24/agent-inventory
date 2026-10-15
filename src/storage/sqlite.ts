import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

export function getDbPath(): string {
  return path.join(
    process.env.HOME || process.env.USERPROFILE || '.',
    '.agent-inventory',
    'db.sqlite'
  );
}

const dbPath = getDbPath();

// Ensure the directory exists
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);

/**
 * Initialize the database schema.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    agent TEXT NOT NULL,
    scope TEXT NOT NULL,
    config_path TEXT NOT NULL,
    launch_command TEXT,
    description TEXT,
    last_seen TEXT NOT NULL
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
    tools_json TEXT NOT NULL
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

/**
 * Get the database instance.
 */
export function getDb(): Database.Database {
  return db;
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
  description?: string;
  last_seen: string;
}): void {
  const stmt = db.prepare(`
    INSERT INTO items (id, kind, name, agent, scope, config_path, launch_command, description, last_seen)
    VALUES (@id, @kind, @name, @agent, @scope, @config_path, @launch_command, @description, @last_seen)
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind,
      name = excluded.name,
      agent = excluded.agent,
      scope = excluded.scope,
      config_path = excluded.config_path,
      launch_command = excluded.launch_command,
      description = excluded.description,
      last_seen = excluded.last_seen
  `);
  stmt.run({
    id: item.id,
    kind: item.kind,
    name: item.name,
    agent: item.agent,
    scope: item.scope,
    config_path: item.config_path,
    launch_command: item.launch_command,
    description: item.description,
    last_seen: item.last_seen,
  });
}

export function getAllItems(): any[] {
  return db.prepare('SELECT * FROM items').all();
}

export function getItemsByKind(kind: string): any[] {
  return db.prepare('SELECT * FROM items WHERE kind = ?').all([kind]);
}

export function getItemById(id: string): any | null {
  return db.prepare('SELECT * FROM items WHERE id = ?').get(id);
}

export function deleteItem(id: string): void {
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
  const stmt = db.prepare(`
    INSERT INTO tools (id, item_id, tool_name, tool_description, input_schema_json)
    VALUES (@id, @item_id, @tool_name, @tool_description, @input_schema_json)
    ON CONFLICT(id) DO UPDATE SET
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
  return db.prepare('SELECT * FROM tools WHERE item_id = ?').all([itemId]);
}

export function getAllTools(): any[] {
  return db.prepare(`
    SELECT t.*, i.name as item_name, i.agent, i.kind
    FROM tools t
    JOIN items i ON t.item_id = i.id
    ORDER BY i.agent, i.name, t.tool_name
  `).all();
}

// ===== Scans =====
export function recordScan(scanId: string, itemsFound: number): void {
  const startedAt = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO scans (id, started_at, items_found)
    VALUES (@id, @started_at, @items_found)
    ON CONFLICT(id) DO UPDATE SET
      started_at = excluded.started_at,
      items_found = excluded.items_found
  `);
  stmt.run({ id: scanId, started_at: startedAt, items_found: itemsFound });
}

export function finishScan(scanId: string): void {
  const finishedAt = new Date().toISOString();
  db.prepare('UPDATE scans SET finished_at = ? WHERE id = ?').run(finishedAt, scanId);
}

export function getLatestScan(): any | null {
  return db.prepare('SELECT * FROM scans ORDER BY started_at DESC LIMIT 1').get();
}

export function getAllScans(): any[] {
  return db.prepare('SELECT * FROM scans ORDER BY started_at DESC').all();
}

export function getScanById(scanId: string): any | null {
  return db.prepare('SELECT * FROM scans WHERE id = ?').get(scanId);
}

export function recordScanItem(scanId: string, itemId: string): void {
  db.prepare('INSERT OR IGNORE INTO scan_items (scan_id, item_id) VALUES (?, ?)').run(scanId, itemId);
}

// ===== Usage Tracking =====
export function recordUsageEvent(event: {
  id: string;
  item_id: string;
  tool_name?: string;
  timestamp: string;
}): void {
  const stmt = db.prepare(`
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
  return db.prepare(query).all(...params);
}

export function getUsageSummary(days: number = 30): any[] {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return db.prepare(`
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
}): void {
  const stmt = db.prepare(`
    INSERT INTO snapshots (id, created_at, name, description, items_json, tools_json)
    VALUES (@id, @created_at, @name, @description, @items_json, @tools_json)
  `);
  stmt.run({
    id: snapshot.id,
    created_at: new Date().toISOString(),
    name: snapshot.name,
    description: snapshot.description,
    items_json: snapshot.items_json,
    tools_json: snapshot.tools_json,
  });
}

export function getSnapshot(snapshotId: string): any | null {
  return db.prepare('SELECT * FROM snapshots WHERE id = ?').get(snapshotId);
}

export function getAllSnapshots(): any[] {
  return db.prepare('SELECT id, created_at, name, description, items_json, tools_json FROM snapshots ORDER BY created_at DESC').all();
}

export function deleteSnapshot(snapshotId: string): void {
  db.prepare('DELETE FROM snapshots WHERE id = ?').run(snapshotId);
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
  const stmt = db.prepare(`
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
  return db.prepare('SELECT * FROM team_baseline ORDER BY kind, name').all();
}

export function removeTeamBaselineItem(id: string): void {
  db.prepare('DELETE FROM team_baseline WHERE id = ?').run(id);
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
  const stmt = db.prepare(`
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
  return db.prepare('SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ? OFFSET ?').all(limit, offset);
}

export function getAuditLogByItem(itemId: string): any[] {
  return db.prepare('SELECT * FROM audit_log WHERE item_id = ? ORDER BY timestamp DESC').all(itemId);
}

// ===== Secrets Scanning =====
export function recordSecretFinding(finding: {
  id: string;
  item_id: string;
  pattern: string;
  location: string;
  severity: string;
}): void {
  const stmt = db.prepare(`
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
    return db.prepare('SELECT * FROM secrets_scan WHERE item_id = ? ORDER BY scanned_at DESC').all(itemId);
  }
  return db.prepare('SELECT ss.*, i.name as item_name, i.agent FROM secrets_scan ss JOIN items i ON ss.item_id = i.id ORDER BY scanned_at DESC').all();
}

export function clearSecretFindings(itemId?: string): void {
  if (itemId) {
    db.prepare('DELETE FROM secrets_scan WHERE item_id = ?').run(itemId);
  } else {
    db.prepare('DELETE FROM secrets_scan').run();
  }
}

// ===== Drift Detection =====
export function compareScans(scanId1: string, scanId2: string): { added: any[]; removed: any[]; changed: any[] } {
  const items1 = db.prepare('SELECT * FROM items WHERE id IN (SELECT item_id FROM scan_items WHERE scan_id = ?)').all(scanId1) as any[];
  const items2 = db.prepare('SELECT * FROM items WHERE id IN (SELECT item_id FROM scan_items WHERE scan_id = ?)').all(scanId2) as any[];
  
  // For simplicity, compare current items with a previous scan's items
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