/**
 * Agent Inventory Tool — Secrets hygiene check (8.9).
 * Pure static analysis: never logs secret values, only the fact + location.
 * Safe to run automatically on every scan.
 */

import fs from 'fs';

export interface SecretFinding {
  itemId: string;
  itemName: string;
  pattern: string;
  location: string;
  severity: 'error' | 'warning';
}

interface Pattern {
  name: string;
  regex: RegExp;
  severity: 'error' | 'warning';
}

const PATTERNS: Pattern[] = [
  { name: 'openai_key', regex: /sk-(proj-)?[A-Za-z0-9_-]{20,}/, severity: 'error' },
  { name: 'github_token', regex: /gh[pousr]_[A-Za-z0-9_]{20,}/, severity: 'error' },
  { name: 'google_api_key', regex: /AIza[0-9A-Za-z_-]{20,}/, severity: 'error' },
  { name: 'aws_key', regex: /AKIA[0-9A-Z]{16}/, severity: 'error' },
  { name: 'slack_token', regex: /xox[baprs]-[A-Za-z0-9-]{10,}/, severity: 'error' },
  { name: 'generic_bearer', regex: /bearer\s+[A-Za-z0-9\-._~+/=]{20,}/i, severity: 'warning' },
  { name: 'env_inline_secret', regex: /"(api[_-]?key|token|secret|password)"\s*:\s*"[^"]{8,}"/i, severity: 'warning' },
  { name: 'url_embedded_token', regex: /https?:\/\/[^/\s:]+:[^@\s]+@[^\s]+/, severity: 'error' },
  { name: 'private_key_block', regex: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, severity: 'error' },
];

function highEntropyStrings(text: string): boolean {
  // Flag long base64/hex-looking tokens assigned to env values.
  const m = text.match(/["']([A-Za-z0-9_\-+/=]{32,})["']/g);
  return !!m && m.length > 0;
}

/** Scan one item's launch command + raw config text. Never returns secret values. */
export function scanItemForSecrets(item: {
  id: string;
  name: string;
  launch_command?: string;
  config_path: string;
}): SecretFinding[] {
  const haystacks: { label: string; text: string }[] = [];
  if (item.launch_command) haystacks.push({ label: 'launch_command', text: item.launch_command });
  try {
    const p = item.config_path.startsWith('~')
      ? item.config_path
      : item.config_path;
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      const raw = fs.readFileSync(p, 'utf-8');
      haystacks.push({ label: 'config_file', text: raw.slice(0, 200_000) });
    }
  } catch {
    // unreadable config: doctor handles that separately
  }

  const findings: SecretFinding[] = [];
  for (const { label, text } of haystacks) {
    for (const p of PATTERNS) {
      if (p.regex.test(text)) {
        findings.push({
          itemId: item.id,
          itemName: item.name,
          pattern: p.name,
          location: label,
          severity: p.severity,
        });
      }
    }
    if (highEntropyStrings(text) && !findings.some((f) => f.location === label)) {
      findings.push({
        itemId: item.id,
        itemName: item.name,
        pattern: 'high_entropy_string',
        location: label,
        severity: 'warning',
      });
    }
  }
  return findings;
}

/** Redact a launch command for safe storage/display (API keys -> **REDACTED**). */
export function redactLaunchCommand(cmd?: string): string | undefined {
  if (!cmd) return cmd;
  let out = cmd;
  out = out.replace(/sk-(proj-)?[A-Za-z0-9_-]{20,}/g, 'sk-**REDACTED**');
  out = out.replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, 'gh**REDACTED**');
  out = out.replace(/AIza[0-9A-Za-z_-]{20,}/g, 'AIza**REDACTED**');
  out = out.replace(/xox[baprs]-[A-Za-z0-9-]+/g, 'xox**REDACTED**');
  out = out.replace(/(api[_-]?key|token|secret|password)=[^ \s]+/gi, '$1=**REDACTED**');
  return out;
}

/**
 * Redact secrets anywhere in a text blob (plan §8.7.3: never bundle secrets —
 * used when snapshot/export captures raw config + SKILL.md file contents).
 * Returns [redactedText, didRedact].
 */
export function redactSecretsInText(text: string): [string, boolean] {
  let out = text;
  let did = false;
  const replace = (re: RegExp, repl: string | ((...args: any[]) => string)): void => {
    if (re.test(out)) {
      out = out.replace(re, repl as string);
      did = true;
    }
    re.lastIndex = 0;
  };
  replace(/sk-(proj-)?[A-Za-z0-9_-]{20,}/g, 'sk-**REDACTED**');
  replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, 'gh**REDACTED**');
  replace(/AIza[0-9A-Za-z_-]{20,}/g, 'AIza**REDACTED**');
  replace(/AKIA[0-9A-Z]{16}/g, 'AKIA**REDACTED**');
  replace(/xox[baprs]-[A-Za-z0-9-]+/g, 'xox**REDACTED**');
  replace(/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '**REDACTED PRIVATE KEY**');
  // JSON shape: keep quotes so the file stays parseable after redaction.
  replace(/("(?:api[_-]?key|apikey|token|secret|password|authorization|access[_-]?key)"\s*:\s*)"[^"]*"/gi, '$1"**REDACTED**"');
  // KEY=value shape (env blocks, CLI args).
  replace(/\b(api[_-]?key|token|secret|password|authorization)(\s*[:=]\s*)[^\s"',;]{8,}/gi, '$1$2**REDACTED**');
  replace(/https?:\/\/[^\s/:@]+:[^\s@]+@[^\s]+/g, (m: string) => m.replace(/:[^:@/]+@/, ':**REDACTED**@'));
  replace(/Bearer\s+[A-Za-z0-9\-._~+/=]{20,}/gi, 'Bearer **REDACTED**');
  return [out, did];
}
