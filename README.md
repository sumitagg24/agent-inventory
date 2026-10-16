# Agent Inventory

A local, CLI-first tool for cataloguing MCP server configurations and skill/rule files across AI coding agents.

> **Current scope:** this is an early implementation of the architecture plan—not the full roadmap. It includes scanners for Claude Code, Cursor, Windsurf, Claude Desktop, VS Code, and explicitly selected project directories, plus a local SQLite store and CLI commands. Codex discovery, snapshots/restore, drift history, a dashboard, usage tracking, team features, and other roadmap items are **not implemented**. See [implementation status](docs/implementation-status.md).

## Supported scan locations

| Agent | User-level MCP config | Project-level MCP config | Skill/rule metadata |
|---|---|---|---|
| Claude Code | `~/.claude.json` | `.mcp.json` | `~/.claude/skills/`, `.claude/skills/` (`SKILL.md`) |
| Cursor | `~/.cursor/mcp.json` | `.cursor/mcp.json` | `~/.cursor/rules/`, `.cursor/rules/` (`.mdc`) |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `.windsurf/mcp_config.json` | — |
| Claude Desktop | macOS `~/Library/Application Support/Claude/claude_desktop_config.json`; Windows `%APPDATA%\Claude\claude_desktop_config.json`; Linux `$XDG_CONFIG_HOME/Claude/claude_desktop_config.json` (or `~/.config/Claude/...`) | — | — |
| VS Code | User `settings.json` MCP entries | `.vscode/mcp.json` | — |

`scan-projects <directory>` searches project-level locations below the directory you specify. The default depth is 3; allowed depth is 0–20. It skips common generated/dependency folders and does not recursively follow symlinked child directories.

## Requirements and quick start

Use Node.js 22.12 or newer and npm:

```sh
npm ci
npm test
npm run build
node dist/cli/index.js --help
```

Example commands:

```sh
node dist/cli/index.js scan
node dist/cli/index.js scan --agent cursor
node dist/cli/index.js scan-projects ./work --max-depth 4
node dist/cli/index.js list --kind mcp
node dist/cli/index.js search postgres
node dist/cli/index.js doctor
node dist/cli/index.js export inventory.json
node dist/cli/index.js inspect my-mcp
node dist/cli/index.js introspect-all
```

The scanner is designed for Windows, macOS, and Linux, using the current user's home directory for user-level configs. The automated checks in this checkout ran in a Linux sandbox; native Windows/macOS verification has not yet been performed.

## What happens to your machine

- `scan`, `list`, `search`, and `doctor` **do not execute MCP servers**, install software, contact a server, change agent settings, edit the registry, create a scheduled task, or install a startup item.
- Scans read agent JSON/settings and skill/rule Markdown. Results are written to a local SQLite database at `~/.agent-inventory/db.sqlite`. Set `AGENT_INVENTORY_DATA_DIR` to choose another data directory.
- On macOS and other POSIX systems, the database directory and file are created/restricted to owner-only permissions where supported. On Windows, the directory inherits the current user's profile ACL; this app does not change Windows ACLs.
- `doctor --fix` only removes stale rows and cached tool metadata from the Agent Inventory database. It never deletes or edits original agent configuration files.
- `export <file>` produces redacted JSON/YAML and refuses to overwrite an existing file unless `--force` is supplied. Exports may still contain local file paths; review them before sharing.
- No telemetry or cloud upload is implemented.

The database may contain names, descriptions, local paths, and tool schemas. Common secret-shaped command arguments, URLs, descriptions, and schema values are redacted before storage/display; this is best-effort and **not** a guarantee that every possible secret format is removed. Treat the database and exports as private.

## MCP inspection is a separate trust boundary

`inspect <name>` and `introspect-all` can start the configured local MCP process or connect to its configured HTTP(S) endpoint. A local server can execute code with the permissions and environment available to your user; a remote server receives a metadata/tools-list request. Inspection requests `initialize` and `tools/list` only—it does not call any advertised tool. Inspection is **not** a sandbox.

- A fresh cached result is shown without starting a process or making a network request.
- When a refresh is needed, an interactive run lists the server and its redacted launch summary and asks for confirmation.
- In a non-interactive shell, inspection is refused unless you explicitly pass `--allow-execution` for that invocation. Use this flag only when you trust the configured server(s).
- Raw launch arguments, configured environment values, HTTP headers, and server stderr are not printed. Raw launch details are re-read from the source config only for an approved inspection; they are not stored in the inventory database.
- Each MCP initialization and `tools/list` request has a 10-second timeout. The SDK closes the connection/process after inspection; a child process that deliberately spawns independent descendants may require separate operating-system cleanup.

Prefer `scan` and `doctor` for static inventory and health checks. The `serve` command is currently a placeholder.

## Background scanning and console windows

Agent Inventory does **not** install or enable recurring scans. It does not ship a hidden PowerShell/VBScript launcher or an automatic Task Scheduler/LaunchAgent/cron configuration. Run `scan` manually in a terminal unless you deliberately create your own scheduled job after reviewing the command and its permissions. There is no supported claim that a hidden launcher prevents all console flashes or is preferable for security.

## Security software and false positives

This project does not attempt to bypass Microsoft Defender, McAfee, macOS Gatekeeper/XProtect, or other security products. It uses no obfuscation, persistence, hidden-task installation, or security exclusions. No open-source project can guarantee that every antivirus product will never flag it: detections depend on signatures, reputation, dependencies, build environment, and heuristic rules. If you receive an alert, do not disable protection or add a broad exclusion. Verify the source/release and file location, scan it, and submit a suspected false positive to the relevant vendor for review.

See [SECURITY.md](SECURITY.md) for the security model and reporting guidance.
