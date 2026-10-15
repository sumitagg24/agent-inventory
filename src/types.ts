/**
 * Agent Inventory Tool — shared types.
 * Single source of truth for InstalledItem so scanners and CLI agree.
 */

export interface InstalledItem {
  id: string;
  kind: 'mcp' | 'skill';
  name: string;
  agent: string;
  scope: 'user' | 'project';
  config_path: string;
  launch_command?: string;
  description?: string;
  last_seen: string;
  /** JSON-encoded allowed-tools / declared capabilities (plan §3.2). */
  capabilities?: string;
  /** Introspection outcome for doctor (plan §3.2/§8.4). */
  introspection_status?: 'never' | 'ok' | 'failed';
  introspection_error?: string;
  introspected_at?: string;
  license?: string;
  source?: string;
}

export interface DiscoveredToolRecord {
  id: string;
  item_id: string;
  tool_name: string;
  tool_description?: string;
  input_schema_json?: string;
}

export interface DoctorIssue {
  item: string;
  agent: string;
  scope: string;
  type: 'missing_config' | 'missing_binary' | 'malformed_json' | 'secret_found' | 'introspection_failed' | 'unknown';
  message: string;
  severity: 'error' | 'warning';
}

export const SUPPORTED_AGENTS = [
  'claude-code',
  'cursor',
  'windsurf',
  'claude-desktop',
  'vscode',
  'codex',
  'kiro',
  'generic',
] as const;

export type SupportedAgent = (typeof SUPPORTED_AGENTS)[number];
