/**
 * Agent Inventory Tool — Drift detection (8.8).
 * Reusable diff: current scan vs snapshot, or scan vs scan.
 */

export interface DriftResult {
  added: any[];
  removed: any[];
  changed: { before: any; after: any; fields: string[] }[];
}

const COMPARE_FIELDS = ['kind', 'name', 'agent', 'scope', 'config_path', 'launch_command', 'description'];

export function diffItemLists(before: any[], after: any[]): DriftResult {
  const beforeMap = new Map(before.map((i) => [i.id, i]));
  const afterMap = new Map(after.map((i) => [i.id, i]));

  const added = after.filter((i) => !beforeMap.has(i.id));
  const removed = before.filter((i) => !afterMap.has(i.id));
  const changed: DriftResult['changed'] = [];

  for (const item of after) {
    const old = beforeMap.get(item.id);
    if (!old) continue;
    const fields = COMPARE_FIELDS.filter((f) => (old[f] ?? null) !== (item[f] ?? null));
    if (fields.length > 0) changed.push({ before: old, after: item, fields });
  }

  return { added, removed, changed };
}

/** Diff current DB items against a stored snapshot manifest. */
export function diffAgainstSnapshot(snapshotItems: any[], currentItems: any[]): DriftResult {
  return diffItemLists(snapshotItems, currentItems);
}

export function formatDrift(drift: DriftResult): string {
  const lines: string[] = [];
  if (drift.added.length === 0 && drift.removed.length === 0 && drift.changed.length === 0) {
    return 'No drift — inventory matches the reference.';
  }
  for (const i of drift.added) lines.push(`+ ADDED   ${i.name} (${i.kind}/${i.agent}/${i.scope})`);
  for (const i of drift.removed) lines.push(`- REMOVED ${i.name} (${i.kind}/${i.agent}/${i.scope})`);
  for (const c of drift.changed)
    lines.push(`~ CHANGED ${c.after.name} [${c.fields.join(', ')}]`);
  return lines.join('\n');
}
