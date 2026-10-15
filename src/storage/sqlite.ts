import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const dbPath = path.join(
  process.env.HOME || process.env.USERPROFILE || '.',
  '.agent-inventory',
  'db.sqlite'
);

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
`);

/**
 * Get the database instance.
 */
export function getDb(): Database.Database {
  return db;
}

// Helper: upsert an item
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

/**
 * Get all items.
 */
export function getAllItems(): any[] {
  return db.prepare('SELECT * FROM items').all();
}

/**
 * Get items by kind.
 */
export function getItemsByKind(kind: string): any[] {
  return db.prepare('SELECT * FROM items WHERE kind = ?').all([kind]);
}

/**
 * Get a single item by ID.
 */
export function getItemById(id: string): any | null {
  return db.prepare('SELECT * FROM items WHERE id = ?').get(id);
}

/**
 * Upsert a tool.
 */
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

/**
 * Get tools for an item.
 */
export function getToolsByItemId(itemId: string): any[] {
  return db.prepare('SELECT * FROM tools WHERE item_id = ?').all([itemId]);
}

/**
 * Record a scan.
 */
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

/**
 * Get the most recent scan.
 */
export function getLatestScan(): any | null {
  return db.prepare('SELECT * FROM scans ORDER BY started_at DESC LIMIT 1').get();
}