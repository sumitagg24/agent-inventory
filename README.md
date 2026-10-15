# agentinv — Agent Inventory Tool

Detect, catalog, and explain every MCP server and Skill installed across your AI coding agents (Claude Code, Cursor, Windsurf, Codex, Kiro, …): what each one is, which agent(s) use it, and the actual tools/commands it exposes.

## Install

```bash
npm install -g agent-inventory
# or run without installing
npx agent-inventory scan
```

Requires Node 18+.

## Quick start

```bash
agentinv scan                 # discover everything
agentinv list                 # browse grouped by agent
agentinv doctor               # broken configs, missing binaries, hardcoded secrets
agentinv inspect "tinyfish"   # boot one MCP, list its real tools (opt-in)
agentinv search postgres      # names, descriptions, agents, tool names
agentinv serve                # local dashboard on http://localhost:3000
```

## Commands

| Command | What it does |
|---|---|
| `scan [--agent <name>]` | Scan all (or one) agent configs + skills into SQLite |
| `scan-projects <dir>` | Recursively scan a directory tree for project-level configs |
| `list [--kind mcp\|skill] [--agent <a>]` | Table of installed items |
| `inspect <name> [--no-cache] [--yes]` | Detail + opt-in MCP introspection (`tools/list`) |
| `introspect-all [--yes]` | Introspect every MCP (cached, 24h) |
| `search <term>` | Full-text across names, descriptions, agents, tool names |
| `licenses [--refresh]` | License + provenance for MCP packages (npm/PyPI registry lookup, cached) |
| `doctor [--fix]` | Missing configs, malformed JSON, missing binaries, secrets |
| `export <file.json\|yaml>` | Redacted inventory export |
| `snapshot <name>` / `snapshots` / `snapshot-delete <id>` | Named bundles: inventory + config/SKILL.md file contents (secrets redacted) |
| `restore <snapshot> [--apply]` | Dry-run plan; `--apply` writes bundled files back (secrets re-added manually) |
| `drift <snapshot>` / `drift --scans a,b` | Added/removed/changed diff |
| `scans` | Scan history |
| `usage [--days 30]` | Active vs dormant rollup |
| `wrap <mcp>` / `unwrap <mcp>` | Opt-in usage-tracking proxy shim (reversible) |
| `team-init` / `team-check [file]` / `onboard [file]` | Team baseline, CI check, onboarding doc |
| `export-audit <file.csv\|json>` | Compliance export of the audit log |
| `stats` | Counts by kind/agent + 30d activity |
| `serve [--port 3000]` | Local dashboard (API + UI) |

## Security model

- **Scanning is read-only.** No servers are started by `scan`, `list`, `search`, or `doctor`.
- **Introspection spawns processes** (`inspect`, `introspect-all`) — always explicit/opt-in with a warning, 10s timeout per server, failures recorded rather than fatal.
- **Secrets are never logged.** `export` redacts launch commands; `doctor` reports only pattern + location (e.g. `openai_key in config_file`), never values.
- **`wrap` rewrites agent config** to route through a logging shim — always backs up the original; `unwrap` restores byte-for-byte.

## Data

Local SQLite file: `~/.agent-inventory/db.sqlite` — tables `items`, `tools`, `scans`, `scan_items`, `usage_events`, `snapshots`, `team_baseline`, `audit_log`, `secrets_scan`. Back it up or delete it freely.

## Team / CI

```bash
agentinv team-init            # writes sample team.yaml
agentinv team-check           # exit 1 if required items missing / blocked present
agentinv onboard -o ONBOARDING.md
```

See `.github/workflows/agentinv-check.yml` for a drop-in PR check.

## Dashboard

```bash
npm run build:dashboard
agentinv serve --port 3000
```

Views: all items (search/filter), item detail with tools, by-agent grouping, doctor, usage.

## Automated Background Scanning (Windows)

A scheduled scanner script is provided at `scripts/skills-and-mcps-scanner.ps1` to automatically scan skills and MCP configs and update JSON/Markdown snapshots on change.

### Preventing Console Window Flashes

When running background tasks on Windows:
1. **Child process suppression:** External commands (such as `npm`, `node`, `git`) called by PowerShell will normally spawn their own console window. Use the included `Invoke-SilentCommand` helper (`CreateNoWindow = $true`) to suppress child windows.
2. **Initial PowerShell window suppression:** Even with `-WindowStyle Hidden`, `powershell.exe` briefly allocates a console window upon launch. To make background runs 100% silent:
   - Use `wscript.exe` with `scripts/run-hidden.vbs` as the Task Scheduler action:
     - **Program/script:** `wscript.exe`
     - **Arguments:** `"C:\path\to\scripts\run-hidden.vbs" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\path\to\scripts\skills-and-mcps-scanner.ps1"`

## License

MIT

