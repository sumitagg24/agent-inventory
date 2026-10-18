import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getDbPath } from '../src/storage/sqlite.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve static files from dist
app.use(express.static(path.join(__dirname, 'dist')));

// API routes
app.get('/api/items', (req, res) => {
  try {
    const db = new Database(getDbPath(), { readonly: true });
    const kind = req.query.kind as string | undefined;
    const agent = req.query.agent as string | undefined;

    let query = 'SELECT * FROM items';
    const params: any[] = [];
    const conditions: string[] = [];

    if (kind) {
      conditions.push('kind = ?');
      params.push(kind);
    }
    if (agent) {
      conditions.push('agent = ?');
      params.push(agent);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY agent, name';

    const items = db.prepare(query).all(...params);
    db.close();

    res.json(items);
  } catch (err) {
    console.error('Error fetching items:', err);
    res.status(500).json({ error: 'Failed to fetch items' });
  }
});

app.get('/api/items/:id', (req, res) => {
  try {
    const db = new Database(getDbPath(), { readonly: true });
    const item = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
    
    if (!item) {
      db.close();
      return res.status(404).json({ error: 'Item not found' });
    }

    const tools = db.prepare('SELECT * FROM tools WHERE item_id = ?').all(req.params.id);
    db.close();

    res.json({ ...item, tools });
  } catch (err) {
    console.error('Error fetching item:', err);
    res.status(500).json({ error: 'Failed to fetch item' });
  }
});

app.get('/api/tools', (req, res) => {
  try {
    const db = new Database(getDbPath(), { readonly: true });
    const tools = db.prepare(`
      SELECT t.*, i.name as item_name, i.agent, i.kind
      FROM tools t
      JOIN items i ON t.item_id = i.id
      ORDER BY i.agent, i.name, t.tool_name
    `).all();
    db.close();

    res.json(tools);
  } catch (err) {
    console.error('Error fetching tools:', err);
    res.status(500).json({ error: 'Failed to fetch tools' });
  }
});

app.get('/api/search', (req, res) => {
  try {
    const term = req.query.q as string;
    if (!term || term.length < 2) {
      return res.json([]);
    }

    const db = new Database(getDbPath(), { readonly: true });
    const lowerTerm = `%${term.toLowerCase()}%`;

const items: any[] = db.prepare(`
      SELECT * FROM items
      WHERE LOWER(name) LIKE ?
         OR LOWER(description) LIKE ?
         OR LOWER(agent) LIKE ?
       ORDER BY agent, name
    `).all(lowerTerm, lowerTerm, lowerTerm);

    // Also search in tools
    const toolMatches: any[] = db.prepare(`
      SELECT DISTINCT i.* FROM items i
      JOIN tools t ON i.id = t.item_id
      WHERE LOWER(t.tool_name) LIKE ?
         OR LOWER(t.tool_description) LIKE ?
    `).all(lowerTerm, lowerTerm);

    db.close();

    // Combine and deduplicate
    const allItems = [...items, ...toolMatches];
    const unique = new Map(allItems.map((item: any) => [item.id, item]));
    res.json(Array.from(unique.values()));
  } catch (err) {
    console.error('Error searching:', err);
    res.status(500).json({ error: 'Failed to search' });
  }
});

app.get('/api/stats', (req, res) => {
  try {
    const db = new Database(getDbPath(), { readonly: true });
    
    const totalItems = db.prepare('SELECT COUNT(*) as count FROM items').get() as { count: number };
    const totalTools = db.prepare('SELECT COUNT(*) as count FROM tools').get() as { count: number };
    const byKind = db.prepare('SELECT kind, COUNT(*) as count FROM items GROUP BY kind').all();
    const byAgent = db.prepare('SELECT agent, COUNT(*) as count FROM items GROUP BY agent ORDER BY count DESC').all();
    const byScope = db.prepare('SELECT scope, COUNT(*) as count FROM items GROUP BY scope').all();
    const itemsWithTools = db.prepare(`
      SELECT COUNT(DISTINCT item_id) as count FROM tools
    `).get() as { count: number };

    db.close();

    res.json({
      totalItems: totalItems.count,
      totalTools: totalTools.count,
      itemsWithTools: itemsWithTools.count,
      byKind,
      byAgent,
      byScope,
    });
  } catch (err) {
    console.error('Error fetching stats:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

app.get('/api/doctor', async (req, res) => {
  try {
    const db = new Database(getDbPath(), { readonly: true });
    const items = db.prepare('SELECT * FROM items').all() as any[];
    db.close();

    const issues: any[] = [];

    for (const item of items) {
      const configPath = item.config_path.startsWith('~')
        ? item.config_path.replace('~', os.homedir())
        : item.config_path;

      if (!fs.existsSync(configPath)) {
        issues.push({
          item: item.name,
          agent: item.agent,
          scope: item.scope,
          type: 'missing_config',
          message: `Config file missing: ${item.config_path}`,
          severity: 'error',
        });
        continue;
      }

      if (item.kind === 'mcp' && item.launch_command) {
        const binary = item.launch_command.split(' ')[0];
        const isHttp = item.launch_command.startsWith('http');
        if (!isHttp) {
          // Check if binary exists on PATH
          const paths = (process.env.PATH || '').split(path.delimiter);
          const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
          let found = false;
          for (const p of paths) {
            for (const ext of exts) {
              if (fs.existsSync(path.join(p, binary + ext))) {
                found = true;
                break;
              }
            }
            if (found) break;
          }
          if (!found) {
            issues.push({
              item: item.name,
              agent: item.agent,
              scope: item.scope,
              type: 'missing_binary',
              message: `Binary not found on PATH: ${binary}`,
              severity: 'warning',
            });
          }
        }
      }
    }

    res.json({
      healthy: issues.length === 0,
      issues,
      summary: {
        total: items.length,
        errors: issues.filter(i => i.severity === 'error').length,
        warnings: issues.filter(i => i.severity === 'warning').length,
      },
    });
  } catch (err) {
    console.error('Error running doctor:', err);
    res.status(500).json({ error: 'Failed to run doctor' });
  }
});

// DEFERRED: /api/export route — pending dedicated security review.
// Returns raw (unredacted) inventory data; do not enable until redaction is added.
// app.get('/api/export', (_req, res) => {
//   try {
//     const db = new Database(getDbPath(), { readonly: true });
//     const items = db.prepare('SELECT * FROM items ORDER BY agent, name').all();
//     const tools = db.prepare('SELECT * FROM tools').all();
//     db.close();
//     res.setHeader('Content-Disposition', 'attachment; filename="skill-recognizer-export.json"');
//     res.json({
//       exportedAt: new Date().toISOString(),
//       version: '0.1.0',
//       items,
//       tools
//     });
//   } catch (err) {
//     console.error('Error exporting data:', err);
//     res.status(500).json({ error: 'Failed to export data' });
//   }
// });

// SPA fallback
app.get('/{*any}', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Dashboard server running on http://localhost:${PORT}`);
});

export { app };