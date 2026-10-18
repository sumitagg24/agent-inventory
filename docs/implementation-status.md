# Implementation status against the Agent Inventory architecture plan

This checkout is an early implementation, not the complete roadmap. This table is deliberately explicit so users do not assume the unbuilt features are present.

| Plan area | Status in this checkout |
|---|---|
| Static scanner | Partial: Claude Code, Cursor, Windsurf, Claude Desktop, VS Code and explicitly selected project directories. Claude Code `SKILL.md` and Cursor `.mdc` metadata are parsed. Codex/generic config discovery and additional agent-specific skill locations remain future work. |
| Normalized inventory and SQLite | Partial: items, cached tool metadata and scan records are stored locally. The CLI uses an additive migration for the introspection timestamp and sanitizes common secret patterns left by earlier versions. IDs still use the original readable format rather than the plan's name/agent/path hash; changing that safely needs a deliberate ID migration. The schema does not yet include full scan snapshots, errors, events, or audit history. |
| MCP introspection | Partial and opt-in: official MCP SDK, stdio/Streamable HTTP, initialization plus `tools/list`, timeouts, cache, explicit confirmation, and connection/process cleanup. It does not call discovered tools. Advanced auth flows, sandboxing, and strong descendant-process containment are not implemented. |
| CLI | Partial: `scan`, `scan-projects`, `list`, `search`, `inspect`, `introspect-all`, `doctor`, and JSON/YAML `export` are present. `doctor --fix` only deletes local inventory records; export avoids accidental overwrite by default. |
| Dashboard | Not implemented. `serve` is a placeholder. |
| Snapshot/restore, drift detection, secrets hygiene, usage tracking | Not implemented. Redaction of common secret shapes is defense-in-depth, not the full planned secrets-hygiene scanner. |
| Team baseline, CI, onboarding, registry, team dashboard, policy, provenance, audit export | Not implemented. |

The static scanner path does not schedule itself or modify agent configuration. To keep later work aligned with the plan, implement and test each roadmap phase separately; keep MCP process execution opt-in and disclose any new file, network, or persistence behavior before adding it.
