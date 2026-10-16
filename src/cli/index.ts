#!/usr/bin/env node

/**
 * Agent Inventory Tool — CLI Entry Point
 *
 * A cross-agent inventory tool that detects, catalogs, and explains
 * every MCP server and Skill installed across AI coding agents.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import path from 'node:path';
import fs from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { stringify as stringifyYaml } from 'yaml';
import { scanClaudeCode } from '../scanners/claude-code.js';
import { scanCursor } from '../scanners/cursor.js';
import { scanWindsurf } from '../scanners/windsurf.js';
import { scanClaudeDesktop } from '../scanners/claude-desktop.js';
import { scanVSCode } from '../scanners/vscode.js';
import { scanProjects } from '../scanners/project.js';
import { upsertItem, getAllItems, getToolsByItemId, recordScan, deleteInventoryItem } from '../storage/sqlite.js';
import { hasFreshMcpCache, inspectMcp } from '../introspection/mcp.js';
import { readMcpLaunchSpec, resolveConfigPath } from '../introspection/launch-spec.js';
import { redactSensitiveObject, redactSensitiveText, safeDisplayText } from '../security/redaction.js';
import type { InstalledItem } from '../scanners/claude-code.js';

const program = new Command();

program
  .name('agentinv')
  .description('Cross-agent inventory tool for MCP servers and Skills')
  .version('0.1.0');

function safeSchemaJson(serialized?: string): string {
  try {
    return JSON.stringify(redactSensitiveObject(JSON.parse(serialized || '{}')));
  } catch {
    return '{}';
  }
}

async function confirmMcpExecution(items: InstalledItem[], allowExecution: boolean): Promise<boolean> {
  if (allowExecution) return true;

  if (!stdin.isTTY || !stdout.isTTY) {
    console.error('Refusing to start MCP servers without interactive confirmation. Re-run with --allow-execution only if you trust the configured server(s).');
    return false;
  }

  console.warn(chalk.yellow('\nSecurity notice: MCP inspection starts the configured process or contacts its configured HTTP endpoint.'));
  console.warn(chalk.yellow('That server may run arbitrary code with your user permissions and may use credentials from its config.'));
  console.warn(chalk.yellow('Agent Inventory will only request the server metadata/tools list; it will not call any listed tool.'));
  console.warn(chalk.yellow('Secret values and server stderr output will not be printed or stored.'));
  console.warn(chalk.yellow('Servers to inspect (launch details are redacted for display):'));
  for (const item of items) {
    const summary = item.launch_command ? ` — ${safeDisplayText(item.launch_command)}` : '';
    console.warn(`  - ${safeDisplayText(item.name)} (${safeDisplayText(item.agent)})${summary}`);
  }

  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await prompt.question('Type yes to continue: ');
    return answer.trim().toLowerCase() === 'yes';
  } finally {
    prompt.close();
  }
}

// ===== SCAN COMMAND =====
program
  .command('scan')
  .description('Scan all known agents for MCP servers and Skills')
  .option('-a, --agent <agent>', 'Scan specific agent (claude-code, cursor, windsurf, claude-desktop, vscode, all)')
  .action(async (options) => {
    console.log(chalk.blue('🔍 Scanning for MCP servers and Skills...'));
    const scanStartedAt = new Date().toISOString();
    const scanId = `scan_${Date.now()}`;

    let items: InstalledItem[] = [];

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

    recordScan(scanId, items.length, scanStartedAt);

    console.log(chalk.green(`\n✅ Scan complete! Found ${items.length} total items.`));
    console.log(chalk.gray(`Run "agentinv list" to see all items.`));
  });

// ===== SCAN-PROJECTS COMMAND =====
program
  .command('scan-projects <directory>')
  .description('Recursively scan a directory for project-level MCP configs and Skills')
  .option('-d, --max-depth <number>', 'Maximum directory depth to scan', '3')
  .action(async (directory, options) => {
    const maxDepth = Number(options.maxDepth);
    if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 20) {
      console.error(chalk.red('Invalid --max-depth value. Use an integer from 0 to 20.'));
      process.exitCode = 2;
      return;
    }

    let rootStats: fs.Stats;
    try {
      rootStats = fs.statSync(directory);
    } catch {
      console.error(chalk.red(`Project directory not found or inaccessible: ${safeDisplayText(directory)}`));
      process.exitCode = 1;
      return;
    }
    if (!rootStats.isDirectory()) {
      console.error(chalk.red(`Project scan target is not a directory: ${safeDisplayText(directory)}`));
      process.exitCode = 1;
      return;
    }

    console.log(chalk.blue(`🔍 Scanning projects in ${safeDisplayText(directory)}...`));
    const scanStartedAt = new Date().toISOString();
    const scanId = `scan-projects_${Date.now()}`;

    let items: InstalledItem[];
    try {
      items = scanProjects({ rootDir: directory, maxDepth });
    } catch (err) {
      const message = err instanceof Error ? safeDisplayText(err.message) : 'Unknown scan error';
      console.error(chalk.red(`Project scan failed: ${message}`));
      process.exitCode = 1;
      return;
    }

    // Store items in database
    for (const item of items) {
      upsertItem(item);
    }

    recordScan(scanId, items.length, scanStartedAt);

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
        console.log(`  ${kindIcon} ${chalk.bold(safeDisplayText(item.name))} ${scopeBadge}`);
        if (item.description) {
          console.log(`     ${chalk.gray(safeDisplayText(item.description))}`);
        }
        if (item.kind === 'mcp' && item.launch_command) {
          console.log(`     ${chalk.gray('→')} ${chalk.cyan(safeDisplayText(item.launch_command))}`);
        }
        console.log(`     ${chalk.gray(safeDisplayText(item.config_path))}`);
      }
    }

    console.log(chalk.gray(`\nTotal: ${items.length} items`));
  });

// ===== INSPECT COMMAND =====
program
  .command('inspect <name>')
  .description('Inspect an item; MCP inspection may start its configured server')
  .option('--no-cache', 'Force re-introspection, ignore cache')
  .option('--allow-execution', 'Skip the interactive safety prompt for this explicitly requested MCP inspection')
  .action(async (name, options) => {
    // Try to find the item by name
    const items = getAllItems().filter(item =>
      item.name.toLowerCase() === name.toLowerCase()
    );

    if (items.length === 0) {
      console.log(chalk.red(`Item "${safeDisplayText(name)}" not found. Run "agentinv scan" first.`));
      return;
    }

    if (items.length > 1) {
      console.log(chalk.yellow(`Multiple items match "${safeDisplayText(name)}":`));
      for (const item of items) {
        console.log(`  ${safeDisplayText(item.agent)}/${safeDisplayText(item.scope)}: ${safeDisplayText(item.name)} (${safeDisplayText(item.kind)})`);
      }
      return;
    }

    const item = items[0];
    console.log(chalk.bold(`\n📋 ${safeDisplayText(item.name)} (${safeDisplayText(item.kind)})`));
    console.log(chalk.gray(`  Agent: ${safeDisplayText(item.agent)} (${safeDisplayText(item.scope)})`));
    console.log(chalk.gray(`  Config: ${safeDisplayText(item.config_path)}`));
    if (item.description) {
      console.log(chalk.gray(`  Description: ${safeDisplayText(item.description)}`));
    }
    if (item.launch_command) {
      console.log(chalk.gray(`  Launch: ${safeDisplayText(item.launch_command)}`));
    }

    if (item.kind === 'mcp') {
      const hasCache = options.cache !== false && hasFreshMcpCache(item.id);
      if (!hasCache && !item.launch_command) {
        console.log(chalk.yellow('\n  No supported launch configuration was discovered; no process was started.'));
      } else {
        if (!hasCache && !(await confirmMcpExecution([item], options.allowExecution))) {
          console.log(chalk.gray('  Inspection cancelled; no server was started.'));
          return;
        }

        console.log(chalk.blue(hasCache ? '\n🔍 Showing cached MCP metadata...' : '\n🔍 Inspecting MCP metadata...'));
        try {
          const tools = await inspectMcp(item, options.cache !== false, true);
          if (tools.length > 0) {
            console.log(chalk.green(`\n  Found ${tools.length} tools:`));
            for (const tool of tools) {
              console.log(`    ${chalk.bold(safeDisplayText(tool.name))}`);
              if (tool.description) console.log(`      ${chalk.gray(safeDisplayText(tool.description))}`);
              if (tool.input_schema_json) {
                const schemaType = JSON.parse(tool.input_schema_json).type || 'object';
                console.log(`      ${chalk.gray('Schema:')} ${safeDisplayText(String(schemaType))}`);
              }
            }
          } else {
            console.log(chalk.yellow('\n  No tools were returned.'));
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          console.log(chalk.red(`\n  Introspection failed: ${safeDisplayText(message)}`));
        }
      }
    }

    // Show any stored tools
    const storedTools = getToolsByItemId(item.id);
    if (storedTools.length > 0) {
      console.log(chalk.green(`\n  Cached tools (${storedTools.length}):`));
      for (const tool of storedTools) {
        console.log(`    ${chalk.bold(safeDisplayText(tool.tool_name))}`);
        if (tool.tool_description) console.log(`      ${chalk.gray(safeDisplayText(tool.tool_description))}`);
      }
    }
  });

// ===== SEARCH COMMAND =====
program
  .command('search <term>')
  .description('Search items by name, description, agent, or cached tool names')
  .action((term) => {
    const items = getAllItems();
    const lowerTerm = term.toLowerCase();

    const matches = items.filter(item =>
      item.name.toLowerCase().includes(lowerTerm) ||
      (item.description && item.description.toLowerCase().includes(lowerTerm)) ||
      item.agent.toLowerCase().includes(lowerTerm) ||
      getToolsByItemId(item.id).some((tool: any) =>
        tool.tool_name.toLowerCase().includes(lowerTerm) ||
        (tool.tool_description || '').toLowerCase().includes(lowerTerm)
      )
    );

    if (matches.length === 0) {
      console.log(chalk.yellow(`No matches for "${safeDisplayText(term)}"`));
      return;
    }

    console.log(chalk.bold(`\n🔍 Search results for "${safeDisplayText(term)}":\n`));

    for (const item of matches) {
      const kindIcon = item.kind === 'mcp' ? '🔧' : '📝';
      const scopeBadge = item.scope === 'user' ? chalk.gray('[user]') : chalk.blue('[project]');
      console.log(`  ${kindIcon} ${chalk.bold(safeDisplayText(item.name))} ${scopeBadge} ${chalk.cyan(`(${safeDisplayText(item.agent)})`)}`);
      if (item.description) {
        console.log(`     ${chalk.gray(safeDisplayText(item.description))}`);
      }
    }

    console.log(chalk.gray(`\n${matches.length} match(es) found`));
  });

// ===== DOCTOR COMMAND =====
program
  .command('doctor')
  .description('Check for missing config files and unavailable MCP executables (read-only)')
  .option('--fix', 'Remove stale rows from the local inventory database only; never deletes config files')
  .action((options) => {
    console.log(chalk.blue('\n🏥 Running health check...\n'));

    const items = getAllItems();
    let issues = 0;
    const toRemove: string[] = [];

    for (const item of items) {
      // Read-only checks: never alter the user's agent configuration.
      const configPath = resolveConfigPath(item.config_path);

      if (!fs.existsSync(configPath)) {
        console.log(chalk.red(`❌ ${safeDisplayText(item.name)} (${safeDisplayText(item.agent)}/${safeDisplayText(item.scope)})`));
        console.log(`   Config file missing: ${safeDisplayText(item.config_path)}`);
        issues++;
        if (options.fix) toRemove.push(item.id);
        continue;
      }

      if (item.kind === 'mcp') {
        try {
          const spec = readMcpLaunchSpec(item);
          if (spec.command && !whichSync(spec.command)) {
            console.log(chalk.yellow(`⚠️  ${safeDisplayText(item.name)} (${safeDisplayText(item.agent)}/${safeDisplayText(item.scope)})`));
            console.log(`   Executable not found on PATH: ${safeDisplayText(spec.command)}`);
            issues++;
          }
        } catch {
          console.log(chalk.yellow(`⚠️  ${safeDisplayText(item.name)} (${safeDisplayText(item.agent)}/${safeDisplayText(item.scope)})`));
          console.log('   The MCP entry could not be parsed from its config file.');
          issues++;
        }
      }
    }

    // --fix only removes inventory records; source config files are never modified.
    if (options.fix && toRemove.length > 0) {
      for (const id of toRemove) {
        deleteInventoryItem(id);
        console.log(chalk.gray(`   Removed stale inventory record: ${safeDisplayText(id)}`));
      }
    }

    if (issues === 0) {
      console.log(chalk.green('✅ All configs look healthy!'));
    } else {
      console.log(chalk.red(`\n⚠️  Found ${issues} issue(s)`));
      if (!options.fix) {
        console.log(chalk.gray('Run with --fix to remove stale rows from the local inventory database; source files are untouched.'));
      }
    }
  });

// ===== EXPORT COMMAND =====
program
  .command('export <file>')
  .description('Export a redacted inventory to YAML/JSON (refuses to overwrite by default)')
  .option('--force', 'Overwrite the destination file if it already exists')
  .action((file, options) => {
    const items = getAllItems();
    const data = {
      exportedAt: new Date().toISOString(),
      items: items.map(item => ({
        id: item.id,
        kind: item.kind,
        name: safeDisplayText(item.name),
        agent: item.agent,
        scope: item.scope,
        config_path: item.config_path,
        launch_command: item.launch_command ? redactSensitiveText(item.launch_command) : undefined,
        description: item.description ? redactSensitiveText(item.description) : undefined,
        last_seen: item.last_seen,
        tools: getToolsByItemId(item.id).map((tool: any) => ({
          id: tool.id,
          tool_name: redactSensitiveText(tool.tool_name),
          tool_description: tool.tool_description ? redactSensitiveText(tool.tool_description) : undefined,
          input_schema_json: safeSchemaJson(tool.input_schema_json),
        })),
      })),
    };

    const ext = path.extname(file).toLowerCase();
    const output = ext === '.yaml' || ext === '.yml'
      ? stringifyYaml(data)
      : JSON.stringify(data, null, 2);

    if (fs.existsSync(file) && !options.force) {
      console.error(chalk.red(`Refusing to overwrite existing file: ${safeDisplayText(file)}. Use --force to replace it.`));
      process.exitCode = 1;
      return;
    }

    try {
      fs.writeFileSync(file, output, {
        encoding: 'utf8',
        flag: options.force ? 'w' : 'wx',
        mode: 0o600,
      });
    } catch (err) {
      const message = err instanceof Error ? safeDisplayText(err.message) : 'Unknown file write error';
      console.error(chalk.red(`Could not write export: ${message}`));
      process.exitCode = 1;
      return;
    }
    console.log(chalk.green(`✅ Exported ${items.length} items to ${safeDisplayText(file)}`));
  });

// ===== INTROSPECT-ALL COMMAND =====
program
  .command('introspect-all')
  .description('Inspect all MCP servers; stale servers require explicit execution consent')
  .option('--allow-execution', 'Skip the interactive safety prompt for this explicitly requested batch')
  .action(async (options) => {
    const items = getAllItems().filter(item => item.kind === 'mcp') as InstalledItem[];
    const toExecute = items.filter(item => !hasFreshMcpCache(item.id));

    if (toExecute.length > 0 && !(await confirmMcpExecution(toExecute, options.allowExecution))) {
      console.log(chalk.gray('Batch inspection cancelled; no server was started.'));
      return;
    }

    console.log(chalk.blue('\n🔍 Inspecting MCP metadata...\n'));
    let success = 0;
    let failed = 0;

    for (const item of items) {
      console.log(`\nInspecting ${safeDisplayText(item.name)}...`);
      try {
        const tools = await inspectMcp(item, true, true);
        console.log(`  ✅ Found ${tools.length} tool(s)`);
        success++;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.log(`  ❌ Failed: ${safeDisplayText(message)}`);
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
  if (path.isAbsolute(cmd)) return fs.existsSync(cmd);
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