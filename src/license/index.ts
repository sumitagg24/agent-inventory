/**
 * Agent Inventory Tool — License & provenance enrichment (plan §8.15).
 *
 * Best-effort: infers an npm/PyPI package from the launch command, queries the
 * public registry (network via global fetch), and persists the result on the
 * item. Never throws — enrichment failures leave the item marked 'unknown'.
 */
import { getAllItems, setItemLicense } from '../storage/sqlite.js';

export interface LicenseResult {
  itemId: string;
  name: string;
  license: string;      // SPDX id or 'unknown'
  source: string | null; // provenance URL
}

/** Infer an npm package name from tokens in the launch command. */
export function inferNpmPackage(launchCommand?: string): string | null {
  if (!launchCommand) return null;
  const tokens = launchCommand.split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].replace(/["']/g, '');
    if ((t === 'npx' || t === 'pnpm' || t === 'yarn') && tokens[i + 1] === '-y') {
      const cand = tokens[i + 2]?.replace(/["']/g, '');
      if (cand && /^[a-z0-9@][a-z0-9@/._-]*$/i.test(cand) && !cand.startsWith('-')) return cand;
    }
    if (t === 'npx' || t === 'pnpm' || t === 'yarn') {
      const cand = tokens[i + 1]?.replace(/["']/g, '');
      if (cand && /^[a-z0-9@][a-z0-9@/._-]*$/i.test(cand) && !cand.startsWith('-') && !cand.startsWith('-')) return cand;
    }
    // node .../node_modules/<pkg>/... (or .../node_modules/@scope/pkg/...)
    const m = t.match(/node_modules\/((@[^/]+\/)?[^/\\]+)/);
    if (m) return m[1];
  }
  return null;
}

/** Infer a PyPI package name from the launch command. */
export function inferPyPackage(launchCommand?: string): string | null {
  if (!launchCommand) return null;
  const m = launchCommand.match(/python[0-9.]*\s+-m\s+pip\s+install\s+(?:-[a-zA-Z]+\s+)*([a-zA-Z0-9._-]+)/);
  return m ? m[1] : null;
}

async function fetchWithTimeout(url: string, ms = 8000): Promise<any | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

const npmCache = new Map<string, LicenseResult>();
const pypiCache = new Map<string, LicenseResult>();

async function lookupNpm(pkg: string): Promise<{ license: string; source: string } | null> {
  const cached = npmCache.get(pkg);
  if (cached) return { license: cached.license, source: cached.source! };
  const data = await fetchWithTimeout(`https://registry.npmjs.org/${encodeURIComponent(pkg)}`);
  const license: string | undefined = data?.license ?? data?.versions?.[data['dist-tags']?.latest]?.license;
  if (!license) return null;
  const result = { license: String(license), source: `https://www.npmjs.com/package/${pkg}` };
  return result;
}

async function lookupPyPI(pkg: string): Promise<{ license: string; source: string } | null> {
  const cached = pypiCache.get(pkg);
  if (cached) return { license: cached.license, source: cached.source! };
  const data = await fetchWithTimeout(`https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`);
  const license: string | undefined = data?.info?.license || data?.info?.license_expression || undefined;
  if (!license) return null;
  return { license: String(license).trim().slice(0, 60), source: `https://pypi.org/project/${pkg}/` };
}

/**
 * Enrich all MCP items with license + provenance.
 * opts.refresh re-queries even previously resolved items.
 * opts.concurrency is reserved (lookups run sequentially to stay polite).
 */
export async function enrichLicenses(opts: { refresh?: boolean } = {}): Promise<LicenseResult[]> {
  const items = getAllItems().filter((i) => i.kind === 'mcp');
  const out: LicenseResult[] = [];
  for (const item of items) {
    if (!opts.refresh && item.license && item.license !== 'unknown') {
      out.push({ itemId: item.id, name: item.name, license: item.license, source: item.source });
      continue;
    }
    const npm = inferNpmPackage(item.launch_command_raw ?? item.launch_command);
    const pypi = npm ? null : inferPyPackage(item.launch_command_raw ?? item.launch_command);
    let resolved: { license: string; source: string } | null = null;
    let sourceKind: 'npm' | 'pypi' | null = null;
    if (npm) {
      resolved = await lookupNpm(npm);
      if (resolved) sourceKind = 'npm';
    }
    if (!resolved && pypi) {
      resolved = await lookupPyPI(pypi);
      if (resolved) sourceKind = 'pypi';
    }
    const result: LicenseResult = resolved
      ? { itemId: item.id, name: item.name, license: resolved.license, source: resolved.source }
      : { itemId: item.id, name: item.name, license: 'unknown', source: npm ? `https://www.npmjs.com/package/${npm}` : (pypi ? `https://pypi.org/project/${pypi}/` : null) };
    if (sourceKind === 'npm') npmCache.set(npm!, result);
    if (sourceKind === 'pypi') pypiCache.set(pypi!, result);
    setItemLicense(item.id, result.license, result.source);
    out.push(result);
  }
  return out;
}