/**
 * Agent Inventory Tool — local API server (used by `agentinv serve`).
 * Serves the built dashboard UI + JSON API reading the same SQLite file.
 */
import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDbPath } from '../storage/sqlite.js';
import { runDoctor } from '../doctor/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function openDb(): Database.Database {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database not found at ${dbPath}. Run "agentinv scan" first.`);
  }
  return new Database(dbPath, { readonly: true });
}

export function createServer(_opts?: { port?: number }): express.Express {
  const app = express();
  app.use(cors());
  app.use(express.json());

  const candidates = [
    path.join(process.cwd(), 'dashboard', 'dist'),
    path.join(__dirname, '..', '..', 'dashboard', 'dist'),
  ];
  const uiDir = candidates.find((d) => fs.existsSync(path.join(d, 'index.html')));
  if (uiDir) app.use(express.static(uiDir));

  app.get('/api/items', (req, res) => {
    try {
      const db = openDb();
      const kind = req.query.kind as string | undefined;
      const agent = req.query.agent as string | undefined;
      let query = 'SELECT * FROM items';
      const params: any[] = [];
      const conditions: string[] = [];
      if (kind) { conditions.push('kind = ?'); params.push(kind); }
      if (agent) { conditions.push('agent = ?'); params.push(agent); }
      if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
      query += ' ORDER BY agent, name';
      const items = db.prepare(query).all(...params);
      db.close();
      res.json(items);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/items/:id', (req, res) => {
    try {
      const db = openDb();
      const item = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
      if (!item) { db.close(); res.status(404).json({ error: 'Item not found' }); return; }
      const tools = db.prepare('SELECT * FROM tools WHERE item_id = ?').all(req.params.id);
      db.close();
      res.json({ ...(item as object), tools });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/tools', (_req, res) => {
    try {
      const db = openDb();
      const tools = db.prepare(
        'SELECT t.*, i.name as item_name FROM tools t JOIN items i ON t.item_id = i.id ORDER BY i.agent, i.name',
      ).all();
      db.close();
      res.json(tools);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/search', (req, res) => {
    try {
      const term = String(req.query.q ?? '');
      if (term.length < 2) { res.json([]); return; }
      const db = openDb();
      const like = `%${term.toLowerCase()}%`;
      const items: any[] = db.prepare(
        "SELECT * FROM items WHERE LOWER(name) LIKE ? OR LOWER(agent) LIKE ? OR LOWER(COALESCE(description,'')) LIKE ? ORDER BY agent, name",
      ).all(like, like, like);
      db.close();
      res.json(items);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/stats', (_req, res) => {
    try {
      const db = openDb();
      const totalItems = (db.prepare('SELECT COUNT(*) as count FROM items').get() as any).count;
      const totalTools = (db.prepare('SELECT COUNT(*) as count FROM tools').get() as any).count;
      const byKind = db.prepare('SELECT kind, COUNT(*) as count FROM items GROUP BY kind').all();
      const byAgent = db.prepare('SELECT agent, COUNT(*) as count FROM items GROUP BY agent').all();
      const byScope = db.prepare('SELECT scope, COUNT(*) as count FROM items GROUP BY scope').all();
      db.close();
      res.json({ totalItems, totalTools, byKind, byAgent, byScope });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/doctor', (_req, res) => {
    try {
      const db = openDb();
      const items = db.prepare('SELECT * FROM items').all();
      db.close();
      const { healthy, issues } = runDoctor(items as any[]);
      res.json({ healthy, issues });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/export', (_req, res) => {
    try {
      const db = openDb();
      const items = db.prepare('SELECT * FROM items ORDER BY agent, name').all();
      const tools = db.prepare('SELECT * FROM tools').all();
      db.close();
      res.json({ exportedAt: new Date().toISOString(), version: '0.1.0', items, tools });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/usage', (req, res) => {
    try {
      const days = parseInt(String(req.query.days ?? '30'), 10) || 30;
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const db = openDb();
      const rows = db.prepare(
        'SELECT i.id, i.name, i.agent, i.kind, COUNT(ue.id) as event_count FROM items i LEFT JOIN usage_events ue ON i.id = ue.item_id AND ue.timestamp >= ? GROUP BY i.id ORDER BY event_count DESC',
      ).all(cutoff);
      db.close();
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/{*any}', (req, res, next) => {
    if (req.path.startsWith('/api/')) { next(); return; }
    const ui = path.join(process.cwd(), 'dashboard', 'dist', 'index.html');
    if (fs.existsSync(ui)) res.sendFile(ui);
    else res.status(404).json({ error: 'Dashboard UI not built.' });
  });

  return app;
}
