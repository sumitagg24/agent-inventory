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
import { scanProjects } from '../scanners/project.js';
import { upsertItem, getAllItems, getItemById, getToolsByItemId, recordScan, recordScanItem, getLatestScan, getDb } from '../storage/sqlite.js';
import { inspectMcp } from '../introspection/mcp.js';
import type { InstalledItem } from '../scanners/claude-code.js';

const program = new Command();

program
  .name('agentinv')
  .description('Cross-agent inventory tool for MCP servers and Skills')
  .version('0.1.0');

// ===== SCAN COMMAND =====
program
  .command('scan')
  .description('Scan all known agents for MCP servers and Skills')
  .option('-a, --agent <agent>', 'Scan specific agent (claude-code, cursor, windsurf, claude-desktop, vscode, all)')
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

    // Store items in database
    for (const item of items) {
      upsertItem(item);
    }

    recordScan(scanId, items.length);

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

    // Store items in database
    for (const item of items) {
      upsertItem(item);
    }

    recordScan(scanId, items.length);

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
      console.log(chalk.blue('\n🔍 Running introspection...'));
      try {
        const tools = await inspectMcp(item, options.cache !== false);
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
        console.log(chalk.red(`\n  Introspection failed: ${err}`));
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
  .description('Search items by name, description, or tool names')
  .action((term) => {
    const items = getAllItems();
    const lowerTerm = term.toLowerCase();

    const matches = items.filter(item =>
      item.name.toLowerCase().includes(lowerTerm) ||
      (item.description && item.description.toLowerCase().includes(lowerTerm)) ||
      item.agent.toLowerCase().includes(lowerTerm)
    );

    if (matches.length === 0) {
      console.log(chalk.yellow(`No matches for "${term}"`));
      return;
    }

    console.log(chalk.bold(`\n🔍 Search results for "${term}":\n`));

    for (const item of matches) {
      const kindIcon = item.kind === 'mcp' ? '🔧' : '📝';
      const scopeBadge = item.scope === 'user' ? chalk.gray('[user]') : chalk.blue('[project]');
      console.log(`  ${kindIcon} ${chalk.bold(item.name)} ${scopeBadge} ${chalk.cyan(`(${item.agent})`)}`);
      if (item.description) {
        console.log(`     ${chalk.gray(item.description)}`);
      }
    }

    console.log(chalk.gray(`\n${matches.length} match(es) found`));
  });

// ===== DOCTOR COMMAND =====
program
  .command('doctor')
  .description('Check for broken configs and failed introspections')
  .option('--fix', 'Attempt to fix issues (e.g., remove missing configs)')
  .action((options) => {
    console.log(chalk.blue('\n🏥 Running health check...\n'));

    const items = getAllItems();
    let issues = 0;
    const toRemove: string[] = [];

    for (const item of items) {
      // Check if config file exists
      const configPath = item.config_path.startsWith('~')
        ? item.config_path.replace('~', process.env.HOME || process.env.USERPROFILE || '')
        : item.config_path;

      if (!fs.existsSync(configPath)) {
        console.log(chalk.red(`❌ ${item.name} (${item.agent}/${item.scope})`));
        console.log(`   Config file missing: ${item.config_path}`);
        issues++;
        if (options.fix) {
          toRemove.push(item.id);
        }
        continue;
      }

      // Check if launch command binary exists (for MCPs)
      if (item.kind === 'mcp' && item.launch_command) {
        const binary = item.launch_command.split(' ')[0];
        // Check if binary is available on PATH
        const isHttp = item.launch_command.startsWith('http');
        if (!isHttp && !whichSync(binary)) {
          console.log(chalk.yellow(`⚠️  ${item.name} (${item.agent}/${item.scope})`));
          console.log(`   Binary not found on PATH: ${binary}`);
          issues++;
        }
      }
    }

    // Remove missing configs if --fix flag
    if (options.fix && toRemove.length > 0) {
      const db = getDb();
      const stmt = db.prepare('DELETE FROM items WHERE id = ?');
      for (const id of toRemove) {
        stmt.run(id);
        console.log(chalk.gray(`   Removed missing config: ${id}`));
      }
    }

    if (issues === 0) {
      console.log(chalk.green('✅ All configs look healthy!'));
    } else {
      console.log(chalk.red(`\n⚠️  Found ${issues} issue(s)`));
      if (!options.fix) {
        console.log(chalk.gray('Run with --fix to automatically remove missing configs.'));
      }
    }
  });

// ===== EXPORT COMMAND =====
program
  .command('export <file>')
  .description('Export inventory to YAML/JSON')
  .action((file) => {
    const items = getAllItems();
    const data = {
      exportedAt: new Date().toISOString(),
      items: items.map(item => ({
        id: item.id,
        kind: item.kind,
        name: item.name,
        agent: item.agent,
        scope: item.scope,
        config_path: item.config_path,
        launch_command: item.launch_command,
        description: item.description,
        last_seen: item.last_seen,
        tools: getToolsByItemId(item.id)
      }))
    };

    const ext = path.extname(file).toLowerCase();
    const output = ext === '.yaml' || ext === '.yml'
      ? require('js-yaml').dump(data)
      : JSON.stringify(data, null, 2);

    fs.writeFileSync(file, output);
    console.log(chalk.green(`✅ Exported ${items.length} items to ${file}`));
  });

// ===== INTROSPECT-ALL COMMAND =====
program
  .command('introspect-all')
  .description('Run introspection on all MCP servers (opt-in, uses cache)')
  .action(async () => {
    console.log(chalk.blue('\n🔍 Introspecting all MCP servers...\n'));

    const items = getAllItems().filter(item => item.kind === 'mcp');
    let success = 0;
    let failed = 0;

    for (const item of items) {
      console.log(`\nIntrospecting ${item.name}...`);
      try {
        const tools = await inspectMcp(item);
        console.log(`  ✅ Found ${tools.length} tool(s)`);
        success++;
      } catch (err) {
        console.log(`  ❌ Failed: ${(err as Error).message}`);
        failed++;
      }
    }

    console.log(chalk.green(`\n✅ Completed: ${success} succeeded, ${failed} failed`));
  });

// ===== SERVE COMMAND =====
program
  .command('serve')
  .description('Launch local dashboard (not yet implemented)')
  .option('-p, --port <port>', 'Port to serve on', '3000')
  .action((options) => {
    console.log(chalk.yellow('Dashboard not yet implemented. Use CLI commands for now.'));
    console.log(chalk.gray(`Would serve on http://localhost:${options.port}`));
  });

// Helper function to check if binary exists on PATH
function whichSync(cmd: string): boolean {
  const paths = (process.env.PATH || '').split(path.delimiter);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];

  for (const p of paths) {
    for (const ext of exts) {
      const fullPath = path.join(p, cmd + ext);
      if (fs.existsSync(fullPath)) {
        return true;
      }
    }
  }
  return false;
}

program.parse();