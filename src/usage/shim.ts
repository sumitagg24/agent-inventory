#!/usr/bin/env node
/**
 * agentinv-shim — stdio proxy between a coding agent and a real MCP server.
 * Logs each JSON-RPC call (tool name + timestamp) to the local SQLite DB,
 * then forwards bytes unchanged in both directions.
 *
 * Installed by `agentinv wrap <name>`; removed by `agentinv unwrap <name>`.
 */
import { spawn } from 'child_process';
import Database from 'better-sqlite3';
import path from 'path';
import crypto from 'crypto';

function getDbPath(): string {
  return path.join(
    process.env.HOME || process.env.USERPROFILE || '.',
    '.agent-inventory',
    'db.sqlite',
  );
}

function parseArgs(argv: string[]): { itemId: string; command: string; args: string[] } {
  const idx = argv.indexOf('--item-id');
  const itemId = idx >= 0 ? argv[idx + 1] : '';
  const sep = argv.indexOf('--');
  const command = sep >= 0 ? argv[sep + 1] : '';
  const args = sep >= 0 ? argv.slice(sep + 2) : [];
  if (!itemId || !command) {
    console.error('Usage: agentinv-shim --item-id <id> -- <command> [args...]');
    process.exit(2);
  }
  return { itemId, command, args };
}

const { itemId, command, args } = parseArgs(process.argv.slice(2));

let db: Database.Database | null = null;
try {
  db = new Database(getDbPath());
} catch {
  db = null;
}

function logEvent(toolName?: string): void {
  try {
    db?.prepare(
      'INSERT INTO usage_events (id, item_id, tool_name, timestamp) VALUES (?, ?, ?, ?)',
    ).run(crypto.randomUUID(), itemId, toolName ?? null, new Date().toISOString());
  } catch {
    // logging must never break forwarding
  }
}

const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });

// Agent -> server: sniff JSON-RPC method names, forward raw bytes.
let buffer = '';
process.stdin.on('data', (chunk: Buffer) => {
  child.stdin.write(chunk);
  try {
    buffer += chunk.toString('utf-8');
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.method === 'tools/call' && msg.params?.name) logEvent(String(msg.params.name));
        else if (typeof msg.method === 'string') logEvent(msg.method);
      } catch {
        // not JSON — ignore
      }
    }
  } catch {
    // sniffing must never break forwarding
  }
});

// Server -> agent: forward raw bytes.
child.stdout.on('data', (chunk: Buffer) => {
  process.stdout.write(chunk);
});

child.on('exit', (code) => {
  try { db?.close(); } catch { /* ignore */ }
  process.exit(code ?? 0);
});
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));
