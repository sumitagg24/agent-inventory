import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactSensitiveObject, redactSensitiveText } from '../security/redaction.js';

let database: Database.Database | undefined;

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
      description TEXT,
      last_seen TEXT NOT NULL,
      last_introspected TEXT
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

  // Additive migration for databases made by earlier releases.
  const itemColumns = db.pragma('table_info(items)') as Array<{ name: string }>;
  if (!itemColumns.some((column) => column.name === 'last_introspected')) {
    db.exec('ALTER TABLE items ADD COLUMN last_introspected TEXT');
  }

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
  const db = getDb();
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
  return getDb().prepare('SELECT * FROM items').all();
}

export function getItemsByKind(kind: string): any[] {
  return getDb().prepare('SELECT * FROM items WHERE kind = ?').all([kind]);
}

export function getItemById(id: string): any | null {
  return getDb().prepare('SELECT * FROM items WHERE id = ?').get(id) ?? null;
}

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

/** Remove an inventory row and its cached tool list; never changes the source config. */
export function deleteInventoryItem(itemId: string): void {
  const db = getDb();
  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM tools WHERE item_id = ?').run(itemId);
    db.prepare('DELETE FROM items WHERE id = ?').run(itemId);
  });
  transaction();
}

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

export function getLatestScan(): any | null {
  return getDb().prepare('SELECT * FROM scans ORDER BY started_at DESC LIMIT 1').get() ?? null;
}
