/**
 * Agent Inventory Tool — Team baseline + CI check + onboarding doc (8.10, 8.11).
 * team.yaml schema:
 *   required:
 *     - name: postgres
 *       kind: mcp
 *       agent: cursor        # optional: any agent if omitted
 *   blocked:                 # optional denylist (8.14 lite)
 *     - name: risky-server
 *       kind: mcp
 */

import fs from 'fs';
import * as yaml from 'js-yaml';

export interface TeamRequirement {
  name: string;
  kind: 'mcp' | 'skill';
  agent?: string;
}

export interface TeamProfile {
  team?: string;
  required: TeamRequirement[];
  blocked?: TeamRequirement[];
}

export function parseTeamFile(filePath: string): TeamProfile {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const data = (filePath.endsWith('.json') ? JSON.parse(raw) : yaml.load(raw)) as any;
  const required: TeamRequirement[] = Array.isArray(data?.required)
    ? data.required
    : Array.isArray(data)
      ? data
      : [];
  const blocked: TeamRequirement[] | undefined = Array.isArray(data?.blocked) ? data.blocked : undefined;
  return { team: data?.team, required, blocked };
}

export interface BaselineCheck {
  missing: TeamRequirement[];
  matched: { requirement: TeamRequirement; item: any }[];
  blockedFound: { requirement: TeamRequirement; item: any }[];
  extra: any[];
}

export function checkAgainstProfile(items: any[], profile: TeamProfile): BaselineCheck {
  const missing: TeamRequirement[] = [];
  const matched: BaselineCheck['matched'] = [];
  for (const req of profile.required) {
    const hit = items.find(
      (i) =>
        i.kind === req.kind &&
        i.name.toLowerCase() === req.name.toLowerCase() &&
        (!req.agent || i.agent === req.agent),
    );
    if (hit) matched.push({ requirement: req, item: hit });
    else missing.push(req);
  }

  const blockedFound: BaselineCheck['blockedFound'] = [];
  for (const b of profile.blocked ?? []) {
    const hit = items.find(
      (i) =>
        i.kind === b.kind &&
        i.name.toLowerCase() === b.name.toLowerCase() &&
        (!b.agent || i.agent === b.agent),
    );
    if (hit) blockedFound.push({ requirement: b, item: hit });
  }

  const extra = items.filter(
    (i) =>
      !profile.required.some(
        (r) =>
          r.kind === i.kind &&
          r.name.toLowerCase() === i.name.toLowerCase() &&
          (!r.agent || r.agent === i.agent),
      ),
  );

  return { missing, matched, blockedFound, extra };
}

export function sampleTeamFile(): string {
  return `# team.yaml — required AI tooling for this repo/team
team: my-team
required:
  - name: postgres
    kind: mcp
  - name: deploy-to-staging
    kind: skill
blocked:
  - name: risky-server
    kind: mcp
`;
}

/** Render an onboarding guide from a team profile (8.11). */
export function renderOnboardingDoc(profile: TeamProfile, items: any[]): string {
  const lines: string[] = [];
  lines.push(`# Onboarding — ${profile.team ?? 'Team'} AI tooling setup`);
  lines.push('');
  lines.push('Install the agents you need, then add each required item below.');
  lines.push('');
  const byAgent = new Map<string, any[]>();
  for (const req of profile.required) {
    const known = items.find(
      (i) => i.kind === req.kind && i.name.toLowerCase() === req.name.toLowerCase(),
    );
    const agent = req.agent ?? known?.agent ?? 'any-agent';
    if (!byAgent.has(agent)) byAgent.set(agent, []);
    byAgent.get(agent)!.push({ req, known });
  }
  for (const [agent, list] of byAgent) {
    lines.push(`## ${agent}`);
    lines.push('');
    for (const { req, known } of list) {
      lines.push(`### ${req.name} (${req.kind})`);
      if (known?.description) lines.push('', known.description);
      if (known?.launch_command && req.kind === 'mcp') {
        lines.push('', '```json', `{ "mcpServers": { "${req.name}": { "command": "${known.launch_command}" } } }`, '```');
      } else if (req.kind === 'skill') {
        lines.push('', `Copy the skill into your agent skills dir (e.g. \`~/.claude/skills/${req.name}/SKILL.md\`).`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}
