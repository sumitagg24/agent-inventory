#!/usr/bin/env node

/**
 * Agent Inventory Tool — CLI Entry Point
 *
 * A cross-agent inventory tool that detects, catalogs, and explains
 * every MCP server and Skill installed across AI coding agents.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import path from 'path';
import fs from 'fs';
import { scanClaudeCode } from '../scanners/claude-code.js';
import { scanCursor } from '../scanners/cursor.js';
import { scanWindsurf } from '../scanners/windsurf.js';
import { scanClaudeDesktop } from '../scanners/claude-desktop.js';
import { scanVSCode } from '../scanners/vscode.js';
import { scanCodex } from '../scanners/codex.js';
import { scanProjects } from '../scanners/project.js';
import {
  upsertItem,
  getAllItems,
  getAllTools,
  getToolsByItemId,
  recordScan,
  recordScanItem,
  finishScan,
  getAllScans,
  getDb,
  createSnapshot,
  getSnapshot,
  getAllSnapshots,
  deleteSnapshot,
  getUsageSummary,
  getAuditLog,
  addAuditLog,
  recordSecretFinding,
  clearSecretFindings,
} from '../storage/sqlite.js';
import { enrichLicenses } from '../license/index.js';
import { inspectMcp } from '../introspection/mcp.js';
import {
  setIntrospectionResult,
} from '../storage/sqlite.js';
import {
  takeSnapshot,
  manifestFromSnapshot,
  restoreSnapshotFiles,
} from '../snapshots/index.js';
import { runDoctor } from '../doctor/index.js';
import { scanItemForSecrets } from '../secrets/scan.js';
import { diffItemLists, formatDrift } from '../drift/index.js';
import { parseTeamFile, checkAgainstProfile, sampleTeamFile, renderOnboardingDoc } from '../team/index.js';
import { buildExportPayload, writeExportFile, buildAuditExport } from '../exporter/index.js';
import { wrapMcpWithProxy, unwrapMcpProxy } from '../usage/proxy.js';
import type { InstalledItem } from '../types.js';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function persistScan(scanId: string, items: InstalledItem[]): void {
  for (const item of items) {
    upsertItem(item);
    recordScanItem(scanId, item.id);
  }
  recordScan(scanId, items.length);
  finishScan(scanId);
}

function audit(action: string, details?: string, item?: any): void {
  try {
    addAuditLog({
      id: crypto.randomUUID(),
      action,
      item_id: item?.id,
      item_name: item?.name,
      agent: item?.agent,
      details,
      user: process.env.USER || process.env.USERNAME,
    });
  } catch {
    // audit must never break the command
  }
}

const program = new Command();

program
  .name('agentinv')
  .description('Cross-agent inventory tool for MCP servers and Skills')
  .version('0.1.0');

// ===== SCAN COMMAND =====
program
  .command('scan')
  .description('Scan all known agents for MCP servers and Skills')
  .option('-a, --agent <agent>', 'Scan specific agent (claude-code, cursor, windsurf, claude-desktop, vscode, codex, all)')
  .action(async (options) => {
    console.log(chalk.blue('🔍 Scanning for MCP servers and Skills...'));
    const scanId = `scan_${Date.now()}`;

    let items: any[] = [];

    const agent = options.agent || 'all';

    if (agent === 'all' || agent === 'claude-code') {
      const claudeItems = scanClaudeCode();
      items = items.concat(claudeItems);
      console.log(chalk.green(`  ✓ Found ${claudeItems.length} items from Claude Code`));
    }

    if (agent === 'all' || agent === 'cursor') {
      const cursorItems = scanCursor();
      items = items.concat(cursorItems);
      console.log(chalk.green(`  ✓ Found ${cursorItems.length} items from Cursor`));
    }

    if (agent === 'all' || agent === 'windsurf') {
      const windsurfItems = scanWindsurf();
      items = items.concat(windsurfItems);
      console.log(chalk.green(`  ✓ Found ${windsurfItems.length} items from Windsurf`));
    }

    if (agent === 'all' || agent === 'claude-desktop') {
      const desktopItems = scanClaudeDesktop();
      items = items.concat(desktopItems);
      console.log(chalk.green(`  ✓ Found ${desktopItems.length} items from Claude Desktop`));
    }

    if (agent === 'all' || agent === 'vscode') {
      const vscodeItems = scanVSCode();
      items = items.concat(vscodeItems);
      console.log(chalk.green(`  ✓ Found ${vscodeItems.length} items from VS Code`));
    }

    if (agent === 'all' || agent === 'codex') {
      const codexItems = scanCodex();
      items = items.concat(codexItems);
      console.log(chalk.green(`  ✓ Found ${codexItems.length} items from Codex/others`));
    }

    persistScan(scanId, items);
    audit('scan', `agent=${agent} items=${items.length}`);

    // Automatic secrets hygiene pass (metadata only, no values logged)
    clearSecretFindings();
    let secretCount = 0;
    for (const item of items as InstalledItem[]) {
      for (const f of scanItemForSecrets(item)) {
        recordSecretFinding({ id: crypto.randomUUID(), item_id: f.itemId, pattern: f.pattern, location: f.location, severity: f.severity });
        secretCount++;
      }
    }
    if (secretCount > 0) console.log(chalk.yellow(`  ⚠️  ${secretCount} possible hardcoded credential(s) — see "agentinv doctor"`));

    console.log(chalk.green(`\n✅ Scan complete! Found ${items.length} total items.`));
    console.log(chalk.gray(`Run "agentinv list" to see all items.`));
  });

// ===== SCAN-PROJECTS COMMAND =====
program
  .command('scan-projects <directory>')
  .description('Recursively scan a directory for project-level MCP configs and Skills')
  .option('-d, --max-depth <number>', 'Maximum directory depth to scan', '3')
  .action(async (directory, options) => {
    console.log(chalk.blue(`🔍 Scanning projects in ${directory}...`));
    const scanId = `scan-projects_${Date.now()}`;

    const items = scanProjects({
      rootDir: directory,
      maxDepth: parseInt(options.maxDepth, 10),
    });

    persistScan(scanId, items as InstalledItem[]);
    audit('scan-projects', `dir=${directory} items=${items.length}`);

    console.log(chalk.green(`\n✅ Project scan complete! Found ${items.length} total items.`));
    console.log(chalk.gray(`Run "agentinv list" to see all items.`));
  });

// ===== LIST COMMAND =====
program
  .command('list')
  .description('List all installed items')
  .option('-k, --kind <kind>', 'Filter by kind (mcp or skill)')
  .option('-a, --agent <agent>', 'Filter by agent')
  .action((options) => {
    let items = getAllItems() as InstalledItem[];

    if (options.kind) {
      items = items.filter(item => item.kind === options.kind);
    }

    if (options.agent) {
      items = items.filter(item => item.agent === options.agent);
    }

    if (items.length === 0) {
      console.log(chalk.yellow('No items found. Run "agentinv scan" first.'));
      return;
    }

    console.log(chalk.bold('\n📦 Installed Items\n'));

    // Group by agent for better display
    const byAgent = items.reduce((acc, item) => {
      if (!acc[item.agent]) acc[item.agent] = [];
      acc[item.agent].push(item);
      return acc;
    }, {} as Record<string, InstalledItem[]>);

    for (const [agent, agentItems] of Object.entries(byAgent)) {
      console.log(chalk.cyan(`\n${agent.toUpperCase()}:`));
      for (const item of agentItems) {
        const kindIcon = item.kind === 'mcp' ? '🔧' : '📝';
        const scopeBadge = item.scope === 'user' ? chalk.gray('[user]') : chalk.blue('[project]');
        console.log(`  ${kindIcon} ${chalk.bold(item.name)} ${scopeBadge}`);
        if (item.description) {
          console.log(`     ${chalk.gray(item.description)}`);
        }
        if (item.kind === 'mcp' && item.launch_command) {
          console.log(`     ${chalk.gray('→')} ${chalk.cyan(item.launch_command)}`);
        }
        console.log(`     ${chalk.gray(item.config_path)}`);
      }
    }

    console.log(chalk.gray(`\nTotal: ${items.length} items`));
  });

// ===== INSPECT COMMAND =====
program
  .command('inspect <name>')
  .description('Inspect an item in detail (runs introspection for MCPs)')
  .option('--no-cache', 'Force re-introspection, ignore cache')
  .option('--yes', 'Skip opt-in confirmation for spawning the server')
  .action(async (name, options) => {
    // Try to find the item by name
    const items = getAllItems().filter(item =>
      item.name.toLowerCase() === name.toLowerCase()
    );

    if (items.length === 0) {
      console.log(chalk.red(`Item "${name}" not found. Run "agentinv scan" first.`));
      return;
    }

    if (items.length > 1) {
      console.log(chalk.yellow(`Multiple items match "${name}":`));
      for (const item of items) {
        console.log(`  ${item.agent}/${item.scope}: ${item.name} (${item.kind})`);
      }
      return;
    }

    const item = items[0];
    console.log(chalk.bold(`\n📋 ${item.name} (${item.kind})`));
    console.log(chalk.gray(`  Agent: ${item.agent} (${item.scope})`));
    console.log(chalk.gray(`  Config: ${item.config_path}`));
    if (item.description) {
      console.log(chalk.gray(`  Description: ${item.description}`));
    }
    if (item.launch_command) {
      console.log(chalk.gray(`  Launch: ${item.launch_command}`));
    }

    if (item.kind === 'mcp') {
      const cached = getToolsByItemId(item.id);
      if (!options.yes && cached.length === 0 && process.stdin.isTTY) {
        console.log(chalk.yellow('\n⚠️  Introspection spawns this MCP server as a child process.'));
        console.log(chalk.gray('Pass --yes to confirm. Continuing in 3s…'));
        await new Promise((r) => setTimeout(r, 3000));
      }
      console.log(chalk.blue('\n🔍 Running introspection...'));
      try {
        const tools = await inspectMcp(item, options.cache !== false);
        setIntrospectionResult(item.id, true);
        if (tools && tools.length > 0) {
          console.log(chalk.green(`\n  Found ${tools.length} tools:`));
          for (const tool of tools) {
            console.log(`    ${chalk.bold(tool.name)}`);
            if (tool.description) console.log(`      ${chalk.gray(tool.description)}`);
            if (tool.input_schema_json) {
              console.log(`      ${chalk.gray('Schema:')} ${JSON.parse(tool.input_schema_json).type || 'object'}`);
            }
          }
        } else {
          console.log(chalk.yellow('\n  No tools returned (or introspection failed)'));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setIntrospectionResult(item.id, false, msg);
        console.log(chalk.red(`\n  Introspection failed: ${msg}`));
      }
    }

    // Show any stored tools
    const storedTools = getToolsByItemId(item.id);
    if (storedTools.length > 0) {
      console.log(chalk.green(`\n  Cached tools (${storedTools.length}):`));
      for (const tool of storedTools) {
        console.log(`    ${chalk.bold(tool.tool_name)}`);
        if (tool.tool_description) console.log(`      ${chalk.gray(tool.tool_description)}`);
      }
    }
  });

// ===== SEARCH COMMAND =====
program
  .command('search <term>')
  .description('Search items by name, description, agent, or tool names')
  .action((term) => {
    const items = getAllItems();
    const tools = getAllTools();
    const lowerTerm = term.toLowerCase();

    const toolHitIds = new Set(
      tools
        .filter(
          (t) =>
            String(t.tool_name).toLowerCase().includes(lowerTerm) ||
            (t.tool_description && String(t.tool_description).toLowerCase().includes(lowerTerm)),
        )
        .map((t) => t.item_id),
    );

    const matches = items.filter(
      (item) =>
        item.name.toLowerCase().includes(lowerTerm) ||
        (item.description && item.description.toLowerCase().includes(lowerTerm)) ||
        item.agent.toLowerCase().includes(lowerTerm) ||
        toolHitIds.has(item.id),
    );

    if (matches.length === 0) {
      console.log(chalk.yellow(`No matches for "${term}"`));
      return;
    }

    console.log(chalk.bold(`\n🔍 Search results for "${term}":\n`));

    for (const item of matches) {
      const kindIcon = item.kind === 'mcp' ? '🔧' : '📝';
      const scopeBadge = item.scope === 'user' ? chalk.gray('[user]') : chalk.blue('[project]');
      const viaTool = toolHitIds.has(item.id) ? chalk.magenta(' [tool match]') : '';
      console.log(`  ${kindIcon} ${chalk.bold(item.name)} ${scopeBadge} ${chalk.cyan(`(${item.agent})`)}${viaTool}`);
      if (item.description) {
        console.log(`     ${chalk.gray(item.description)}`);
      }
    }

    console.log(chalk.gray(`\n${matches.length} match(es) found`));
  });

program
  .command('licenses')
  .description('Show license & provenance for MCP packages (plan §8.15; network lookup, cached)')
  .option('--refresh', 'Re-query registries even when cached')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const results = await enrichLicenses({ refresh: options.refresh });
    audit('licenses', `items=${results.length} refresh=${options.refresh ? 'yes' : 'no'}`);
    if (options.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }
    console.log(chalk.bold(`\n🔐 License & provenance (${results.length} MCP servers):`));
    for (const r of results) {
      const lic = r.license === 'unknown' ? chalk.red('unknown') : chalk.green(r.license);
      console.log(`  ${r.name} ${lic}${r.source ? chalk.gray(`  (${r.source})`) : chalk.gray('  (no public source)')}`);
    }
    const unknown = results.filter((r) => r.license === 'unknown').length;
    if (unknown > 0) console.log(chalk.yellow(`\n⚠️  ${unknown} item(s) unresolved — run with --refresh later or review manually.`));
  });

// ===== DOCTOR COMMAND =====
program
  .command('doctor')
  .description('Check for broken configs, missing binaries, and hardcoded secrets')
  .option('--fix', 'Remove DB rows whose config files are gone')
  .action((options) => {
    console.log(chalk.blue('\n🏥 Running health check...\n'));

    const items = getAllItems();
    const { healthy, issues } = runDoctor(items);

    const toRemove = new Set<string>();
    for (const issue of issues) {
      const icon = issue.severity === 'error' ? chalk.red('❌') : chalk.yellow('⚠️ ');
      console.log(`${icon} ${issue.item} (${issue.agent}/${issue.scope})`);
      console.log(`   [${issue.type}] ${issue.message}`);
      if (options.fix && issue.type === 'missing_config') {
        const hit = items.find((i) => i.name === issue.item && i.agent === issue.agent);
        if (hit) toRemove.add(hit.id);
      }
    }

    for (const item of items.filter((i) => i.kind === 'mcp')) {
      if (getToolsByItemId(item.id).length === 0) {
        console.log(chalk.gray(`ℹ️  ${item.name} (${item.agent}) — never introspected (run: agentinv inspect "${item.name}" --yes)`));
      }
    }

    if (options.fix && toRemove.size > 0) {
      const db = getDb();
      const stmt = db.prepare('DELETE FROM items WHERE id = ?');
      for (const id of toRemove) {
        stmt.run(id);
        console.log(chalk.gray(`   Removed missing config: ${id}`));
      }
    }

    if (healthy) console.log(chalk.green('✅ All configs look healthy!'));
    else {
      console.log(chalk.red(`\n⚠️  Found ${issues.length} issue(s)`));
      if (!options.fix) console.log(chalk.gray('Run with --fix to remove rows for missing configs.'));
    }
  });

// ===== EXPORT COMMAND =====
program
  .command('export <file>')
  .description('Export inventory to JSON/YAML (launch commands redacted)')
  .action((file) => {
    const items = getAllItems();
    const toolsByItem = new Map<string, any[]>();
    for (const item of items) toolsByItem.set(item.id, getToolsByItemId(item.id));
    const payload = buildExportPayload(items, toolsByItem);
    writeExportFile(file, payload);
    audit('export', `file=${file} items=${items.length}`);
    console.log(chalk.green(`✅ Exported ${items.length} items to ${file}`));
  });

// ===== SNAPSHOT COMMANDS =====
program
  .command('snapshot <name>')
  .description('Save a named bundle: inventory + config/SKILL.md file contents (secrets redacted)')
  .option('-d, --description <text>', 'Snapshot description')
  .action((name, options) => {
    const manifest = takeSnapshot(name, options.description);
    const bundled = manifest.files.filter((f) => f.included).length;
    audit('snapshot', `id=${manifest.id} name=${name} items=${manifest.items.length} files=${bundled}`);
    console.log(chalk.green(`✅ Snapshot "${name}" saved (${manifest.items.length} items, ${bundled} file(s) bundled, id=${manifest.id})`));
    if (manifest.secretsRedacted.length > 0) {
      console.log(chalk.yellow(`   ⚠️  ${manifest.secretsRedacted.length} file(s) had secrets redacted — re-add API keys after restore.`));
    }
  });

program
  .command('snapshots')
  .description('List saved snapshots')
  .action(() => {
    const snaps = getAllSnapshots();
    if (snaps.length === 0) {
      console.log(chalk.yellow('No snapshots yet. Run "agentinv snapshot <name>" first.'));
      return;
    }
    for (const s of snaps) console.log(`  ${chalk.bold(s.name ?? s.id)}  ${chalk.gray(s.id)}  ${s.created_at}`);
  });

program
  .command('drift [snapshotId]')
  .description('Diff current inventory against a snapshot (or two scans with --scans)')
  .option('--scans <ids>', 'Compare two scan ids: --scans <id1,id2>')
  .action((snapshotId, options) => {
    if (typeof snapshotId === 'object' && snapshotId !== null && !options?.scans) {
      options = snapshotId;
      snapshotId = undefined;
    }
    if (options?.scans) {
      const [id1, id2] = String(options.scans).split(',');
      const db = getDb();
      const before = db.prepare('SELECT * FROM items WHERE id IN (SELECT item_id FROM scan_items WHERE scan_id = ?)').all(id1);
      const afterScan = db.prepare('SELECT * FROM items WHERE id IN (SELECT item_id FROM scan_items WHERE scan_id = ?)').all(id2);
      console.log(chalk.bold(`\n📊 Drift: ${id1} → ${id2}\n`));
      console.log(formatDrift(diffItemLists(before as any[], afterScan as any[])));
      return;
    }
    const snap = (snapshotId ? getSnapshot(snapshotId) : undefined) ?? getAllSnapshots().find((s) => s.name === snapshotId || s.id === snapshotId);
    if (!snap) {
      console.log(chalk.red(`Snapshot "${snapshotId ?? '(none)'}" not found. Run "agentinv snapshots" to list them.`));
      return;
    }
    let before: any[];
    try {
      before = JSON.parse(snap.items_json);
    } catch {
      console.log(chalk.red(`Snapshot "${snap.name ?? snap.id}" has corrupt data.`));
      return;
    }
    console.log(chalk.bold(`\n📊 Drift vs snapshot "${snap.name ?? snap.id}":\n`));
    console.log(formatDrift(diffItemLists(before, getAllItems())));
  });

program
  .command('scans')
  .description('List recorded scans')
  .action(() => {
    const scans = getAllScans();
    if (scans.length === 0) {
      console.log(chalk.yellow('No scans recorded yet.'));
      return;
    }
    for (const s of scans) console.log(`  ${chalk.bold(s.id)}  ${s.started_at}  items=${s.items_found ?? '?'}`);
  });

program
  .command('snapshot-delete <id>')
  .description('Delete a snapshot by id or name')
  .action((id) => {
    const snap = getSnapshot(id) ?? getAllSnapshots().find((s) => s.name === id);
    if (!snap) {
      console.log(chalk.red(`Snapshot "${id}" not found.`));
      return;
    }
    deleteSnapshot(snap.id);
    audit('snapshot-delete', `id=${snap.id} name=${snap.name ?? ''}`);
    console.log(chalk.green(`✅ Deleted snapshot "${snap.name ?? snap.id}".`));
  });

program
  .command('restore <snapshotId>')
  .description('Dry-run restore of a snapshot (preview only; use --apply to write)')
  .option('--apply', 'Write config files (with per-file confirmation)')
  .action(async (snapshotId, options) => {
    const snap = getSnapshot(snapshotId) ?? getAllSnapshots().find((s) => s.name === snapshotId);
    if (!snap) {
      console.log(chalk.red(`Snapshot "${snapshotId}" not found. Run "agentinv snapshots" to list them.`));
      return;
    }
    let manifest;
    try {
      manifest = manifestFromSnapshot(snap);
    } catch {
      console.log(chalk.red('Snapshot has corrupt data.'));
      return;
    }
    const items = manifest.items;
    const bundledCount = manifest.files.filter((f) => f.included).length;
    console.log(chalk.bold(`
📦 Restore plan: snapshot "${snap.name ?? snap.id}" (${items.length} items, ${bundledCount} file(s) bundled)`));
    const { createInterface } = await import('readline');
    for (const item of items) {
      const tag = item.kind === 'mcp' ? '🔧' : '📝';
      const f = manifest.files.find((x) => x.itemId === item.id);
      const state = f && f.included ? chalk.green('bundled') : chalk.gray((f && f.note) || 'not bundled');
      console.log(`  ${tag} ${item.name} [${item.agent}/${item.scope}] → ${item.config_path} ${state}`);
    }
    if (manifest.secretsRedacted.length > 0) {
      console.log(chalk.yellow(`
⚠️  ${manifest.secretsRedacted.length} file(s) contain redacted secrets — re-add API keys after restore.`));
    }
    if (!options.apply) {
      console.log(chalk.yellow('\nDry-run only — no files written. Re-run with --apply to restore.'));
      return;
    }
    if (bundledCount === 0) {
      console.log(chalk.red('\nNo files bundled in this snapshot (it predates file capture). Re-run "agentinv snapshot" first.'));
      return;
    }
    console.log(chalk.yellow(`
⚠️  --apply will overwrite ${bundledCount} file(s) listed above.`));
    if (process.stdin.isTTY && !options.yes) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) =>
        rl.question('Type RESTORE to confirm: ', (a: string) => {
          rl.close();
          resolve(a);
        }),
      );
      if (answer.trim() !== 'RESTORE') {
        console.log(chalk.gray('Aborted — no files written.'));
        return;
      }
    }
    const writeResult = restoreSnapshotFiles(manifest);
    for (const w of writeResult.written) console.log(chalk.gray(`  written: ${w}`));
    for (const s of writeResult.skipped) console.log(chalk.gray(`  skipped: ${s.path} (${s.reason})`));
    audit('restore', `snapshot=${snap.id} written=${writeResult.written.length} skipped=${writeResult.skipped.length} mode=apply`);
    console.log(chalk.green(`
✅ Restored ${writeResult.written.length} file(s), skipped ${writeResult.skipped.length}.`));
    console.log(chalk.gray('Secrets were redacted in the snapshot — re-add API keys, then run "agentinv scan".'));
  });

// ===== INTROSPECT-ALL COMMAND =====
program
  .command('introspect-all')
  .description('Run introspection on all MCP servers (opt-in, uses cache)')
  .option('--yes', 'Skip confirmation')
  .action(async (options) => {
    console.log(chalk.blue('\n🔍 Introspecting all MCP servers...\n'));
    if (!options.yes && process.stdin.isTTY) {
      console.log(chalk.yellow('⚠️  This spawns each configured MCP server. Pass --yes to confirm. Continuing in 3s…'));
      await new Promise((r) => setTimeout(r, 3000));
    }

    const items = getAllItems().filter(item => item.kind === 'mcp');
    let success = 0;
    let failed = 0;

    for (const item of items) {
      console.log(`\nIntrospecting ${item.name}...`);
      try {
        const tools = await inspectMcp(item);
        setIntrospectionResult(item.id, true);
        console.log(`  ✅ Found ${tools.length} tool(s)`);
        success++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setIntrospectionResult(item.id, false, msg);
        console.log(`  ❌ Failed: ${msg}`);
        failed++;
      }
    }

    console.log(chalk.green(`\n✅ Completed: ${success} succeeded, ${failed} failed`));
  });

// ===== USAGE COMMANDS =====
program
  .command('usage')
  .description('Show dormant vs active MCPs/skills')
  .option('--days <n>', 'Window in days', '30')
  .action((options) => {
    const days = parseInt(options.days, 10) || 30;
    const summary = getUsageSummary(days);
    const active = summary.filter((s) => Number(s.event_count) > 0);
    const totalEvents = summary.reduce((a: number, s: any) => a + Number(s.event_count || 0), 0);
    console.log(chalk.bold(`\n📊 Usage — last ${days} days`));
    console.log(chalk.gray(`Active: ${active.length}/${summary.length} items, ${totalEvents} events\n`));
    const sorted = [...summary].sort((a, b) => Number(b.event_count) - Number(a.event_count));
    for (const s of sorted.slice(0, 20)) {
      const mark = Number(s.event_count) > 0 ? chalk.green('●') : chalk.gray('○');
      console.log(`  ${mark} ${s.name} ${chalk.gray(`(${s.agent}/${s.kind})`)} — ${s.event_count} calls${s.last_used ? chalk.gray(` last ${s.last_used}`) : ''}`);
    }
  });

program
  .command('wrap <name>')
  .description('Install usage-tracking proxy shim for an MCP (opt-in, reversible)')
  .action((name) => {
    const items = getAllItems().filter((i) => i.name.toLowerCase() === name.toLowerCase() && i.kind === 'mcp');
    if (items.length === 0) {
      console.log(chalk.red(`MCP "${name}" not found.`));
      return;
    }
    const item = items[0];
    const shimPath = path.join(__dirname, '..', 'usage', 'shim.js');
    try {
      const res = wrapMcpWithProxy(item, shimPath);
      audit('wrap', `shim=${shimPath}`, item);
      console.log(chalk.green(`✅ Wrapped "${item.name}" — calls now logged to usage_events.`));
      console.log(chalk.gray(`Config: ${res.configFile}${res.backedUp ? ' (original backed up)' : ''}`));
      console.log(chalk.gray('Restore with: agentinv unwrap "' + item.name + '"'));
    } catch (err) {
      console.log(chalk.red(`Wrap failed: ${(err as Error).message}`));
    }
  });

program
  .command('unwrap <name>')
  .description('Remove usage-tracking shim and restore original config')
  .action(async (name) => {
    const items = getAllItems().filter((i) => i.name.toLowerCase() === name.toLowerCase() && i.kind === 'mcp');
    if (items.length === 0) {
      console.log(chalk.red(`MCP "${name}" not found.`));
      return;
    }
    const mod = await import('../usage/proxy.js');
    const res = mod.unwrapMcpProxy(items[0]);
    audit('unwrap', undefined, items[0]);
    if (res.restored) console.log(chalk.green(`✅ Restored original config for "${items[0].name}".`));
    else console.log(chalk.yellow('No backup found — config left untouched.'));
  });

// ===== TEAM COMMANDS =====
program
  .command('team-init')
  .description('Write a sample team.yaml in the current directory')
  .action(() => {
    const out = path.join(process.cwd(), 'team.yaml');
    if (fs.existsSync(out)) {
      console.log(chalk.yellow('team.yaml already exists.'));
      return;
    }
    fs.writeFileSync(out, sampleTeamFile());
    console.log(chalk.green(`✅ Wrote ${out}`));
  });

program
  .command('team-check [file]')
  .description('Compare inventory against team.yaml (default: ./team.yaml)')
  .action((file) => {
    const teamFile = file ?? path.join(process.cwd(), 'team.yaml');
    if (!fs.existsSync(teamFile)) {
      console.log(chalk.red(`Team file not found: ${teamFile}. Run "agentinv team-init" first.`));
      process.exitCode = 1;
      return;
    }
    const profile = parseTeamFile(teamFile);
    const result = checkAgainstProfile(getAllItems(), profile);
    console.log(chalk.bold(`\n👥 Team check: ${profile.team ?? teamFile}`));
    console.log(chalk.green(`  Matched: ${result.matched.length}`));
    for (const m of result.matched) console.log(`    ✓ ${m.requirement.name} (${m.requirement.kind})`);
    if (result.missing.length > 0) {
      console.log(chalk.red(`  Missing: ${result.missing.length}`));
      for (const m of result.missing) console.log(`    ✗ ${m.name} (${m.kind}${m.agent ? '/' + m.agent : ''})`);
    }
    if (result.blockedFound.length > 0) {
      console.log(chalk.red(`  Blocked found: ${result.blockedFound.length}`));
      for (const b of result.blockedFound) console.log(`    ⛔ ${b.requirement.name} in use by ${b.item.agent}`);
    }
    audit('team-check', `missing=${result.missing.length} blocked=${result.blockedFound.length}`);
    if (result.missing.length > 0 || result.blockedFound.length > 0) process.exitCode = 1;
    else console.log(chalk.green('\n✅ Environment matches team profile.'));
  });

program
  .command('onboard [file]')
  .description('Generate onboarding markdown from team.yaml')
  .option('-o, --out <file>', 'Output file', 'ONBOARDING.md')
  .action((file, options) => {
    const teamFile = file ?? path.join(process.cwd(), 'team.yaml');
    if (!fs.existsSync(teamFile)) {
      console.log(chalk.red(`Team file not found: ${teamFile}`));
      return;
    }
    const profile = parseTeamFile(teamFile);
    const doc = renderOnboardingDoc(profile, getAllItems());
    fs.writeFileSync(options.out, doc);
    console.log(chalk.green(`✅ Wrote ${options.out}`));
  });

program
  .command('export-audit <file>')
  .description('Export audit log as CSV or JSON (by extension)')
  .option('--limit <n>', 'Max rows', '500')
  .action((file, options) => {
    const log = getAuditLog(parseInt(options.limit, 10) || 500);
    const ext = path.extname(file).toLowerCase();
    const out = ext === '.json' ? buildAuditExport(log, 'json') : buildAuditExport(log, 'csv');
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(file, out);
    console.log(chalk.green(`✅ Exported ${log.length} audit rows to ${file}`));
  });

program
  .command('stats')
  .description('Show inventory summary statistics')
  .action(() => {
    const items = getAllItems();
    const tools = getAllTools();
    const byAgent = new Map<string, number>();
    const byKind = new Map<string, number>();
    for (const i of items) {
      byAgent.set(i.agent, (byAgent.get(i.agent) ?? 0) + 1);
      byKind.set(i.kind, (byKind.get(i.kind) ?? 0) + 1);
    }
    console.log(chalk.bold('\n📊 Inventory stats\n'));
    console.log(`  Items: ${items.length}  Tools introspected: ${tools.length}`);
    for (const [k, v] of byKind) console.log(`  ${k}: ${v}`);
    for (const [a, v] of byAgent) console.log(`  ${a}: ${v}`);
    const usage = getUsageSummary(30);
    const active = usage.filter((u: any) => Number(u.event_count) > 0).length;
    console.log(chalk.gray(`\n  Active in last 30d: ${active}/${usage.length}`));
  });

// ===== SERVE COMMAND =====
program
  .command('serve')
  .description('Launch local dashboard (API + built UI)')
  .option('-p, --port <port>', 'Port to serve on', '3000')
  .action(async (options) => {
    const port = parseInt(options.port, 10) || 3000;
    const { createServer } = await import('../server/index.js');
    const server = createServer({ port });
    server.listen(port, () => {
      console.log(chalk.green(`✅ Dashboard at http://localhost:${port}`));
      console.log(chalk.gray('API: /api/items /api/tools /api/search?q= /api/stats /api/doctor /api/export'));
    });
  });

program.parse();
