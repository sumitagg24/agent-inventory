# Security policy

## Security model

Agent Inventory is a local inventory and health-check CLI. Its default scan path is static: it reads known agent configuration files and skill/rule Markdown, then writes normalized (best-effort redacted) inventory data to a local SQLite database. It does not run configured MCP commands during `scan`, does not update agent configs, and does not add scheduled/background tasks.

MCP introspection is intentionally separate. It is user-initiated and may execute the command in a local MCP configuration or contact its configured HTTP(S) endpoint. Confirmation is required for uncached inspections in interactive use; scripts must explicitly pass `--allow-execution`. MCP inspection is not a sandbox. Review the source and permissions of any server before allowing it to run.

The project does not hide itself from security products, change antivirus settings, add exclusions, evade scanning, or use persistence. Child-process console windows are suppressed by the official MCP SDK on Windows for a normal user-requested inspection; this is not used to hide a background task.

## Data handling

- Inventory data remains local unless a user explicitly exports it. Telemetry and upload are not implemented.
- Raw MCP arguments, configured environment values, HTTP headers, and server stderr are not intentionally logged or stored.
- Common secret formats and sensitive object keys are redacted from stored/displayed metadata, but pattern-based redaction cannot recognize every credential. Treat the database and exports as potentially sensitive.
- The database lives under the user's home directory by default. POSIX permissions are restricted where supported. Windows ACLs are inherited from the user's profile and are not changed by this project.
- `doctor --fix` affects only Agent Inventory's local database rows. It does not remove or alter the source configuration.

## Reporting a vulnerability

Please report a suspected vulnerability privately to the repository maintainer before making it public. Include the affected version, operating system, a minimal reproduction, and impact. Do not include real API keys, access tokens, or private MCP configuration files; use synthetic credentials.

## Antivirus / endpoint-protection alerts

There is no guarantee that Defender, McAfee, Gatekeeper/XProtect, or another product will never flag a build. If an alert occurs, keep protection enabled, record the detection name and the exact file path, verify the file came from this repository or an official release, and submit the sample/false-positive report to the vendor. Do not create broad exclusions or disable security controls to run the tool.
