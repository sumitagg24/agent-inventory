/**
 * Small, dependency-free redaction helpers for inventory data.
 * These are defense-in-depth, not a substitute for treating exported files as sensitive.
 */

const SENSITIVE_NAME =
  '(?:api[-_]?key|access[-_]?key|auth(?:orization)?|client[-_]?secret|connection[-_]?string|credential|password|passwd|private[-_]?key|secret|token)';
const SENSITIVE_KEY = new RegExp(SENSITIVE_NAME, 'i');

/** Redact common secret-bearing flags, assignments, URL credentials, and query parameters. */
export function redactSensitiveText(value: string): string {
  let result = value;

  // Do not print credentials embedded in a URL's authority section.
  result = result.replace(/(https?:\/\/)[^\s/@]+@/gi, '$1[REDACTED]@');

  // Hide sensitive query parameters while leaving the rest of the URL useful.
  result = result.replace(
    new RegExp(`([?&][^=&#\\s]*${SENSITIVE_NAME}[^=&#\\s]*=)[^&#\\s]*`, 'gi'),
    '$1[REDACTED]',
  );

  // Redact common bearer/basic authorization values.
  result = result.replace(
    /(\b(?:proxy-)?authorization\s*[:=]\s*(?:(?:bearer|basic)\s+)?)[^\s,;"']+/gi,
    '$1[REDACTED]',
  );

  // Redact JSON/YAML-style values whose key names indicate credentials.
  result = result.replace(
    new RegExp(`(["']?${SENSITIVE_NAME}[\\w.-]*["']?\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|[^,\\s}]+)`, 'gi'),
    '$1"[REDACTED]"',
  );

  // Redact `--token value` / `--token=value` and similar CLI arguments.
  result = result.replace(
    new RegExp(`(--[\\w.-]*${SENSITIVE_NAME}[\\w.-]*\\s+)("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|[^\\s]+)`, 'gi'),
    '$1[REDACTED]',
  );
  result = result.replace(
    new RegExp(`(--[\\w.-]*${SENSITIVE_NAME}[\\w.-]*=)("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|[^\\s]+)`, 'gi'),
    '$1[REDACTED]',
  );

  // Redact environment-style assignments such as GITHUB_TOKEN=... or API_KEY: ... .
  result = result.replace(
    new RegExp(`(\\b[\\w.-]*${SENSITIVE_NAME}[\\w.-]*\\s*[:=]\\s*)("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|[^\\s,;&?#]+)`, 'gi'),
    '$1[REDACTED]',
  );

  // Common provider token prefixes and PEM private keys may appear as bare values.
  result = result.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,})\b/g, '[REDACTED]');
  result = result.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]');
  return result;
}

/** Redact object values under credential-like keys before serialization or display. */
export function redactSensitiveObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveObject(entry));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactSensitiveObject(entry),
      ]),
    );
  }

  if (typeof value === 'string') {
    return redactSensitiveText(value);
  }

  return value;
}

/** Format a launch command strictly for display/storage; it is not executable output. */
export function formatLaunchCommand(command: string, args: readonly string[] = []): string {
  const quoteForDisplay = (part: string) => /[\s"']/.test(part) ? JSON.stringify(part) : part;
  return redactSensitiveText([command, ...args].map(quoteForDisplay).join(' '));
}

export function formatLaunchUrl(url: string): string {
  return redactSensitiveText(`http ${url}`);
}

/** Prevent untrusted metadata from emitting terminal escape/control sequences. */
export function safeDisplayText(value: string): string {
  return redactSensitiveText(value)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}

export function formatMcpLaunchSummary(config: {
  type?: unknown;
  url?: unknown;
  command?: unknown;
  args?: unknown;
}): string | undefined {
  if (typeof config.url === 'string' && (config.type === 'http' || config.type === 'streamable-http' || typeof config.command !== 'string')) {
    return formatLaunchUrl(config.url);
  }
  if (typeof config.command !== 'string') return undefined;
  const args = Array.isArray(config.args)
    ? config.args.filter((argument): argument is string => typeof argument === 'string')
    : [];
  return formatLaunchCommand(config.command, args);
}
