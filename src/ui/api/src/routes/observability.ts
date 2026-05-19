import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { resolve } from 'path';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'fs';
import { stringify as yamlStringify } from 'yaml';
import { loadScenario, listHookScenarios } from '@construct/eval/scenario-loader.js';
import { spawn } from 'child_process';
import { claudePaths, dataPaths, getMemoryDbPath } from '@construct/data';
import { Database } from 'bun:sqlite';
import {
  parseSessionsForDays,
  aggregateOverview,
  aggregateTools,
  aggregateHooks,
  aggregateSkills,
  aggregateTokens,
  aggregateCost,
  aggregateSessions,
  aggregateToolDetail,
  aggregateHookDetail,
  aggregateSkillDetail,
  aggregateMemoryUsage,
  aggregateMemorySearches,
  aggregateHookEvents,
  aggregateCompaction,
  aggregateApiDuration,
  aggregateSessionTrace,
  getRecentEvents,
  aggregateSubagents,
  aggregateVerifications,
} from '@construct/telemetry';
import type { Granularity, TelemetryEvent } from '@construct/telemetry';

const MAX_MEMORY_ITEMS = 500;

// ---------------------------------------------------------------------------
// Reducer result cache: 5-minute TTL for heavy aggregate views (tools, hooks,
// sessions, cost, etc.); 60s for lighter detail views. The underlying corpus
// cache (adapter.ts) refreshes every 5s, so aggregate views may lag behind raw
// events by at most the TTL. Keyed by route URL (path + query string) — safe
// for read-only aggregate endpoints. Session traces excluded (per-session id).
// ---------------------------------------------------------------------------

const MAX_CACHE = 100;

interface ResultCacheEntry {
  value: unknown;
  expiresAt: number;
}

const resultCache = new Map<string, ResultCacheEntry>();

function cachedResult<T>(key: string, ttlMs: number, fn: () => T): T {
  const now = Date.now();
  const cached = resultCache.get(key);
  if (cached && now < cached.expiresAt) return cached.value as T;
  if (resultCache.size >= MAX_CACHE) {
    const firstKey = resultCache.keys().next().value;
    if (firstKey) resultCache.delete(firstKey);
  }
  const value = fn();
  resultCache.set(key, { value, expiresAt: now + ttlMs });
  return value;
}

type QueryParams = { days?: string; range?: string; granularity?: string; session?: string };
type ObsRequest = FastifyRequest<{ Querystring: QueryParams }> & {
  telemetryEntries: TelemetryEvent[];
  granularity: Granularity;
};

function parseGranularity(raw?: string): Granularity {
  if (raw === 'minute' || raw === 'hour' || raw === 'day') return raw;
  return 'day';
}

function rangeToDays(range?: string): number | undefined {
  switch (range) {
    case '1h': return 1;      // parse 1 day, filter later
    case '1d': return 1;
    case '7d': return 7;
    case '30d': return 30;
    case 'session': return 7; // parse 7 days, filter to latest session
    default: return undefined;
  }
}

function parseDaysPreHandler(
  req: FastifyRequest<{ Querystring: QueryParams }>,
  reply: { code: (n: number) => { send: (body: unknown) => void } },
  done: () => void,
) {
  const range = req.query.range;
  const days = range ? rangeToDays(range) : parseInt(req.query.days || '30', 10);
  if (!days || Number.isNaN(days) || days < 1 || days > 365) {
    reply.code(400).send({ error: 'invalid days or range parameter' });
    return;
  }
  let entries = parseSessionsForDays(days);

  // For 1h range, filter to entries within the last hour
  if (range === '1h') {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    entries = entries.filter((e) => e.ts >= oneHourAgo);
  }

  // For session range, filter to the most recent session
  if (range === 'session') {
    const latest = entries.reduce((best, e) => (e.ts > best ? e.ts : best), '');
    if (latest) {
      const latestSession = entries.find((e) => e.ts === latest)?.sid;
      if (latestSession) {
        entries = entries.filter((e) => e.sid === latestSession);
      }
    }
  }

  // Filter by explicit session if provided
  const sessionFilter = req.query.session;
  if (sessionFilter) {
    entries = entries.filter((e) => e.sid === sessionFilter);
  }

  (req as ObsRequest).telemetryEntries = entries;
  (req as ObsRequest).granularity = parseGranularity(req.query.granularity);
  done();
}

function timed<T>(fn: () => T): { result: T; queryTimeMs: number } {
  const start = performance.now();
  const result = fn();
  const queryTimeMs = Math.round((performance.now() - start) * 100) / 100;
  return { result, queryTimeMs };
}

function extractHookPath(fullCommand: string): string | undefined {
  const parts = fullCommand.split(/\s+/);
  for (const part of parts) {
    if (part.startsWith('/') && (part.endsWith('.ts') || part.endsWith('.js') || part.endsWith('.sh'))) {
      return part;
    }
  }
  return undefined;
}

function checkHookActive(fullCommand: string): boolean {
  const path = extractHookPath(fullCommand);
  return path ? existsSync(path) : false;
}

function tryRead(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try { return readFileSync(path, 'utf-8'); } catch { return undefined; }
}

type ContextFile = { label: string; path: string; chars: number; estTokens: number };

function readContextFiles(sessionId: string): { files: ContextFile[] } {
  // Find the project for this session by scanning telemetry dirs
  let projectEncoded: string | undefined;
  for (const dir of readdirSync(claudePaths.projects)) {
    const sessionFile = resolve(claudePaths.projects, dir, `${sessionId}.jsonl`);
    if (existsSync(sessionFile)) { projectEncoded = dir; break; }
  }

  const files: ContextFile[] = [];

  function addFile(label: string, path: string): string | undefined {
    const content = tryRead(path);
    if (content === undefined) return undefined;
    files.push({ label, path, chars: content.length, estTokens: Math.ceil(content.length / 3.5) });
    return content;
  }

  // 1. Global CLAUDE.md
  const globalContent = addFile('Global CLAUDE.md', resolve(claudePaths.root, 'CLAUDE.md'));

  // 2. Resolve @-references in global CLAUDE.md (e.g. @construct/core/CLAUDE.md)
  if (globalContent) {
    for (const ref of globalContent.matchAll(/^@([^\s]+)/gm)) {
      const refPath = ref[1];
      // Map known construct/ prefix to actual construct path
      const resolved = refPath.startsWith('construct/')
        ? resolve(claudePaths.construct, refPath.slice('construct/'.length))
        : resolve(claudePaths.root, refPath);
      addFile(refPath, resolved);
    }
  }

  // 3. Project-local CLAUDE.md
  let projectPath: string | undefined;
  if (projectEncoded) {
    projectPath = projectIdToPath(projectEncoded) ?? undefined;
    if (projectPath) {
      const projectContent = addFile('Project CLAUDE.md', resolve(projectPath, '.claude', 'CLAUDE.md'));
      // Resolve @-refs in project CLAUDE.md too
      if (projectContent) {
        for (const ref of projectContent.matchAll(/^@([^\s]+)/gm)) {
          const refPath = ref[1];
          const resolved = resolve(projectPath, '.claude', refPath);
          if (!files.some(f => f.path === resolved)) addFile(refPath, resolved);
        }
      }
    }
  }

  // 4. Settings files — Claude Code reads these and injects permissions + hook names into context
  addFile('Global settings.json', resolve(claudePaths.root, 'settings.json'));
  addFile('Global settings.local.json', resolve(claudePaths.root, 'settings.local.json'));
  if (projectPath) {
    addFile('Project settings.json', resolve(projectPath, '.claude', 'settings.json'));
    addFile('Project settings.local.json', resolve(projectPath, '.claude', 'settings.local.json'));
  }

  return { files };
}

function readHookSource(fullCommand: string): string | undefined {
  const path = extractHookPath(fullCommand);
  if (!path) return undefined;
  return tryRead(path);
}

interface SessionGateInfo {
  inlineOverride: boolean;
  dispatchBlocks: number;
  dispatchAllows: number;
}

function readSessionGateInfo(): Map<string, SessionGateInfo> {
  const map = new Map<string, SessionGateInfo>();
  const hookEventsPath = dataPaths.events;
  if (!existsSync(hookEventsPath)) return map;
  try {
    const lines = readFileSync(hookEventsPath, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as { ts: string; hook: string; event: string; sessionId?: string };
        const sid = entry.sessionId;
        if (!sid) continue;
        if (!map.has(sid)) map.set(sid, { inlineOverride: false, dispatchBlocks: 0, dispatchAllows: 0 });
        const info = map.get(sid)!;
        if (entry.hook === 'inline-override') {
          info.inlineOverride = true;
        }
      } catch {}
    }
  } catch {}
  return map;
}

function toGateInfo(info: SessionGateInfo | undefined): { inlineOverride: boolean; dispatchBlocks: number; dispatchAllows: number; hookBlocks: number; hookAdvisories: number; mode: 'dispatched' | 'inline' | 'none' } | undefined {
  if (!info) return undefined;
  if (!info.inlineOverride && info.dispatchBlocks === 0 && info.dispatchAllows === 0) return undefined;
  const mode = info.inlineOverride ? 'inline' : info.dispatchBlocks > 0 ? 'dispatched' : 'none';
  return { ...info, hookBlocks: 0, hookAdvisories: 0, mode };
}

function readSelfReportedHookCounts(startDate?: string): Map<string, { count: number; event: string }> {
  const counts = new Map<string, { count: number; event: string }>();
  const hookEventsPath = dataPaths.events;
  if (!existsSync(hookEventsPath)) return counts;
  try {
    const lines = readFileSync(hookEventsPath, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as { ts: string; hook: string; event: string };
        if (startDate && entry.ts < startDate) continue;
        const key = entry.hook.endsWith('.ts') ? entry.hook : entry.hook + '.ts';
        const cur = counts.get(key) || { count: 0, event: entry.event };
        cur.count++;
        counts.set(key, cur);
      } catch {}
    }
  } catch {}
  return counts;
}

function getRegisteredSkills(): string[] {
  const rulesPath = resolve(claudePaths.skills, 'skill-rules.json');
  if (!existsSync(rulesPath)) return [];
  try {
    const data = JSON.parse(readFileSync(rulesPath, 'utf-8'));
    return (data.rules || []).map((r: { skill: string }) => r.skill);
  } catch (e) {
    console.error(`Failed to parse skill-rules.json: ${(e as Error).message}`);
    return [];
  }
}

function projectIdToPath(projectId: string): string | undefined {
  // -home-user-project → /home/user/project
  // Try progressively joining segments with / vs -
  const raw = projectId.replace(/^-/, '/').replace(/-/g, '/');
  if (existsSync(raw)) return raw;
  // Fallback: try keeping last segments hyphenated
  const parts = projectId.replace(/^-/, '').split('-');
  for (let split = 3; split <= parts.length; split++) {
    const path = '/' + parts.slice(0, split).join('/');
    if (existsSync(path)) return path;
  }
  return undefined;
}

function getCommandNames(): Set<string> {
  const names = new Set<string>();
  // Global commands
  try {
    for (const f of readdirSync(claudePaths.commands)) {
      if (f.endsWith('.md')) names.add(f.replace(/\.md$/, ''));
    }
  } catch {}
  // Project-local commands: scan known project dirs
  try {
    for (const dir of readdirSync(claudePaths.projects)) {
      const projectPath = projectIdToPath(dir);
      if (!projectPath) continue;
      const localCmds = resolve(projectPath, '.claude', 'commands');
      try {
        for (const f of readdirSync(localCmds)) {
          if (f.endsWith('.md')) names.add(f.replace(/\.md$/, ''));
        }
      } catch {}
    }
  } catch {}
  return names;
}

function findSkillSource(name: string, projects?: string[]): string | undefined {
  const normalized = name.startsWith('/') ? name.slice(1) : name;
  // Check skill SKILL.md
  const skillMd = tryRead(resolve(claudePaths.skills, normalized, 'SKILL.md'));
  if (skillMd) return skillMd;
  // Check global command
  const globalCmd = tryRead(resolve(claudePaths.commands, `${normalized}.md`));
  if (globalCmd) return globalCmd;
  // Check project-local commands
  const projectDirs = projects ?? [];
  for (const projectId of projectDirs) {
    const projectPath = projectIdToPath(projectId);
    if (!projectPath) continue;
    const localCmd = tryRead(resolve(projectPath, '.claude', 'commands', `${normalized}.md`));
    if (localCmd) return localCmd;
  }
  return undefined;
}

function getRegisteredHooks(): Array<{ command: string; event: string }> {
  const settingsPath = resolve(claudePaths.root, 'settings.json');
  if (!existsSync(settingsPath)) return [];
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const hooks: Array<{ command: string; event: string }> = [];
    for (const [event, entries] of Object.entries(settings.hooks || {})) {
      for (const entry of entries as Array<{ hooks?: Array<{ command: string }>; command?: string }>) {
        const cmds = entry.hooks?.map(h => h.command) ?? (entry.command ? [entry.command] : []);
        for (const raw of cmds) {
          // Strip shell redirections (e.g. "2>/dev/null") before extracting filename
          const clean = raw.replace(/\s+\d*>\s*\/dev\/null/g, '').trim();
          const cmd = clean.split('/').pop()?.replace(/\.ts$/, '') || clean;
          if (!cmd || cmd === 'null') continue;
          hooks.push({ command: cmd, event });
        }
      }
    }
    return hooks;
  } catch (e) {
    console.error(`Failed to parse settings.json hooks: ${(e as Error).message}`);
    return [];
  }
}

function checkToolActive(_toolName: string, lastUsed?: string): boolean {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  if (lastUsed) {
    return new Date(lastUsed) >= sevenDaysAgo;
  }
  return false;
}

type HookMeta = {
  blocking: boolean;
  gate?: string;
  markerFile?: string;
  description: string;
};

const HOOK_METADATA: Record<string, HookMeta> = {
  'isolation-block-sql': {
    blocking: true,
    description: 'Blocks destructive SQL (DROP, TRUNCATE, DELETE without WHERE)',
  },
  'quality-check-stop': {
    blocking: false,
    description: 'Advisory check for e2e verification evidence after edits',
  },
  'git-require-edit': {
    blocking: true,
    gate: 'git-require-edit',
    markerFile: 'git-require-edit-{sessionId}',
    description: 'Groups dirty files by directory; warns at 3 groups, blocks at 5',
  },
  'quality-format-edit': {
    blocking: false,
    description: 'Post-tool formatting quality checks',
  },
  'quality-typecheck-edit': {
    blocking: false,
    description: 'Runs tsc type-check after Edit/Write on .ts files',
  },
  'routing-classify-submit': {
    blocking: false,
    gate: 'dispatch',
    description: 'Classifies prompt depth, matches skills, writes directives',
  },
  'context-monitor-stop': {
    blocking: false,
    description: 'Monitors context window usage at stop',
  },
  'context-backup-precompact': {
    blocking: false,
    description: 'Backs up transcript before context compaction',
  },
  'context-suggest-edit': {
    blocking: false,
    description: 'Suggests /compact at 50 tool calls with phase-boundary decision guide',
  },
  'security-scan-bash': {
    blocking: false,
    description: 'Scans staged diff for secrets and console.log before git commit',
  },
};

// ---------------------------------------------------------------------------
// Hook group inference from name prefix
// ---------------------------------------------------------------------------

const HOOK_GROUP_MAP: Record<string, string> = {
  quality: 'Quality',
  memory: 'Memory',
  git: 'Git',
  context: 'Context',
  routing: 'Routing',
  signal: 'Signals',
  isolation: 'Isolation',
  security: 'Security',
  consolidator: 'Memory',
  'context-save': 'Context',
  'context-restore': 'Context',
  'context-monitor': 'Context',
  'context-backup': 'Context',
  'context-suggest': 'Context',
};

function hookGroup(command: string): string | undefined {
  const base = command.replace(/\.ts$/, '');
  for (const [prefix, group] of Object.entries(HOOK_GROUP_MAP)) {
    if (base.startsWith(prefix + '-') || base === prefix) return group;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Hook gating stats from hook-events.jsonl
// ---------------------------------------------------------------------------

type HookGatingStat = {
  blocks: number;
  advisories: number;
  passes: number;
  total: number;
  blockRate: number;
  advisoryRate: number;
  ignoredAdvisories: number;
  repeatedBlocks: number;
  topPatterns: Array<{ detail: string; count: number }>;
};

function readHookGatingStats(startDate?: string): Record<string, HookGatingStat> {
  const hookEventsPath = dataPaths.events;
  if (!existsSync(hookEventsPath)) return {};
  type Entry = { ts: string; hook: string; event: string; sessionId: string; decision?: string; detail?: string };
  type HookAccum = {
    blocks: number;
    advisories: number;
    passes: number;
    sessionAdvisories: Map<string, boolean>;
    sessionBlocks: Map<string, number>;
    detailCounts: Map<string, number>;
  };
  const perHook: Record<string, HookAccum> = {};
  try {
    const lines = readFileSync(hookEventsPath, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as Entry;
        if (startDate && entry.ts < startDate) continue;
        const hook = entry.hook;
        if (!perHook[hook]) {
          perHook[hook] = { blocks: 0, advisories: 0, passes: 0, sessionAdvisories: new Map(), sessionBlocks: new Map(), detailCounts: new Map() };
        }
        const h = perHook[hook];
        if (entry.decision === 'block') {
          h.blocks++;
          h.sessionBlocks.set(entry.sessionId, (h.sessionBlocks.get(entry.sessionId) ?? 0) + 1);
          if (h.sessionAdvisories.has(entry.sessionId) && !h.sessionAdvisories.get(entry.sessionId)) {
            h.sessionAdvisories.set(entry.sessionId, true); // advisory ignored → then blocked
          }
        } else if (entry.decision === 'advisory') {
          h.advisories++;
          if (!h.sessionAdvisories.has(entry.sessionId)) h.sessionAdvisories.set(entry.sessionId, false);
        } else {
          h.passes++;
        }
        if (entry.detail) {
          h.detailCounts.set(entry.detail, (h.detailCounts.get(entry.detail) ?? 0) + 1);
        }
      } catch {}
    }
  } catch {}
  const result: Record<string, HookGatingStat> = {};
  for (const [hook, h] of Object.entries(perHook)) {
    if (h.blocks === 0 && h.advisories === 0) continue;
    const ignoredAdvisories = [...h.sessionAdvisories.values()].filter(Boolean).length;
    const repeatedBlocks = [...h.sessionBlocks.values()].filter(n => n >= 2).length;
    const total = h.blocks + h.advisories + h.passes;
    const topPatterns = [...h.detailCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([detail, count]) => ({ detail, count }));
    result[hook] = {
      blocks: h.blocks, advisories: h.advisories, passes: h.passes, total,
      blockRate: total > 0 ? h.blocks / total : 0,
      advisoryRate: total > 0 ? h.advisories / total : 0,
      ignoredAdvisories, repeatedBlocks, topPatterns,
    };
  }
  return result;
}

function readMarkerFileStats(): Record<string, { writes: number; clears: number; activeNow: boolean }> {
  const stats: Record<string, { writes: number; clears: number; activeNow: boolean }> = {};
  // Check require-e2e marker
  const e2eMarker = resolve(dataPaths.signals, 'require-e2e');
  stats['require-e2e'] = { writes: 0, clears: 0, activeNow: existsSync(e2eMarker) };

  // Read hook trace log for marker write/clear counts
  const traceLog = resolve(dataPaths.signals, 'hook-trace.log');
  if (existsSync(traceLog)) {
    try {
      const content = readFileSync(traceLog, 'utf-8');
      const e2eWrites = (content.match(/marker written/g) || []).length;
      const e2eClears = (content.match(/cleared marker/g) || []).length;
      stats['require-e2e'].writes = e2eWrites;
      stats['require-e2e'].clears = e2eClears;
    } catch {}
  }

  // Check git commit markers — activeNow is live (file scan); writes come from gate_marker events
  let activeNow = false;
  try {
    const signalFiles = readdirSync(dataPaths.signals);
    activeNow = signalFiles.some(f => f.startsWith('git-require-edit-'));
  } catch {}
  let writes = 0;
  try {
    if (existsSync(dataPaths.events)) {
      const lines = readFileSync(dataPaths.events, 'utf-8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const e = JSON.parse(line) as Record<string, unknown>;
          if (e.hook === 'git-require-edit' && e.groups !== undefined) writes++;
        } catch {}
      }
    }
  } catch {}
  stats['git-require-edit'] = { writes, clears: 0, activeNow };

  return stats;
}

export const observabilityRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: QueryParams }>('/overview', { preHandler: [parseDaysPreHandler] }, async (req) => {
    const obsReq = req as ObsRequest;
    return cachedResult(req.url, 300_000, () => {
      const { result, queryTimeMs } = timed(() => aggregateOverview(obsReq.telemetryEntries, obsReq.granularity));
      return { ...result, queryTimeMs };
    });
  });

  app.get<{ Querystring: QueryParams }>('/tools', { preHandler: [parseDaysPreHandler] }, async (req) => {
    const obsReq = req as ObsRequest;
    return cachedResult(req.url, 300_000, () => {
      const { result, queryTimeMs } = timed(() => aggregateTools(obsReq.telemetryEntries, obsReq.granularity));
      const ranked = result.ranked.map((t) => ({
        ...t,
        active: checkToolActive(t.name, t.lastUsed),
      }));
      return { ...result, ranked, queryTimeMs, totalRows: obsReq.telemetryEntries.length };
    });
  });

  app.get<{ Querystring: QueryParams }>('/hooks', { preHandler: [parseDaysPreHandler] }, async (req) => {
    const obsReq = req as ObsRequest;
    return cachedResult(req.url, 300_000, () => {
      const { result, queryTimeMs } = timed(() => aggregateHooks(obsReq.telemetryEntries, obsReq.granularity));

      // Merge self-reported hook events (for hooks on events Claude Code doesn't log)
      const days = rangeToDays(req.query.range) || rangeToDays(req.query.days ? `${req.query.days}d` : undefined) || 30;
      const startDate = new Date(Date.now() - days * 86400000).toISOString();
      const selfReported = readSelfReportedHookCounts(startDate);
      const rankedMap = new Map(result.ranked.map((h) => [h.command, h]));
      for (const [hook, { count, event }] of selfReported) {
        const existing = rankedMap.get(hook);
        if (existing) {
          existing.count = Math.max(existing.count, count);
          if (!existing.event) existing.event = event;
        } else {
          rankedMap.set(hook, { command: hook, event, count, avgMs: 0, p50Ms: 0, p95Ms: 0, blocks: 0, crashes: 0, fullCommand: hook });
        }
      }
      const merged = [...rankedMap.values()].sort((a, b) => b.count - a.count);

      const markerStats = readMarkerFileStats();
      const gatingStartDate = new Date(Date.now() - days * 86400000).toISOString();
      const gating = readHookGatingStats(gatingStartDate);
      const ranked = merged.map((h) => {
        const name = h.command.replace(/\.ts$/, '');
        const meta = HOOK_METADATA[name];
        return {
          ...h,
          active: h.fullCommand ? checkHookActive(h.fullCommand) : false,
          blocking: meta?.blocking ?? false,
          gate: meta?.gate,
          markerFile: meta?.markerFile,
          description: meta?.description,
          group: hookGroup(h.command),
        };
      });
      const registered = getRegisteredHooks();
      const normalize = (cmd: string) => cmd.replace(/\.(ts|sh)$/, '');
      const usedCommands = new Set(ranked.map(h => normalize(h.command)));
      const unused = registered.filter(h => !usedCommands.has(normalize(h.command))).map(h => {
        const meta = HOOK_METADATA[normalize(h.command)];
        return {
          ...h,
          blocking: meta?.blocking ?? false,
          gate: meta?.gate,
          markerFile: meta?.markerFile,
          description: meta?.description,
        };
      });
      const byEventMap = new Map<string, number>();
      for (const h of merged) {
        if (h.event) byEventMap.set(h.event, (byEventMap.get(h.event) || 0) + h.count);
      }
      const byEvent = [...byEventMap.entries()].map(([event, count]) => ({ event, count })).sort((a, b) => b.count - a.count);
      return { ...result, ranked, unused, markerStats, byEvent, gating, queryTimeMs };
    });
  });

  app.get<{ Querystring: QueryParams }>('/skills', { preHandler: [parseDaysPreHandler] }, async (req) => {
    const obsReq = req as ObsRequest;
    return cachedResult(req.url, 300_000, () => {
      const { result, queryTimeMs } = timed(() => aggregateSkills(obsReq.telemetryEntries, obsReq.granularity));
      const registeredSkills = new Set(getRegisteredSkills());
      const commandNames = getCommandNames();
      const usedNames = new Set(result.ranked.map(s => s.skill.replace(/^\//, '')));
      const unusedSkills = [...registeredSkills].filter(s => !usedNames.has(s)).map(s => ({ name: s, type: 'skill' as const }));
      const unusedCommands = [...commandNames].filter(s => !usedNames.has(s) && !registeredSkills.has(s)).map(s => ({ name: s, type: 'command' as const }));
      const unused = [...unusedSkills, ...unusedCommands];
      const ranked = result.ranked.map(s => {
        const bare = s.skill.replace(/^\//, '');
        const isSkill = registeredSkills.has(bare);
        const isCommand = commandNames.has(bare) && !isSkill;
        return {
          ...s,
          type: isCommand ? 'command' as const : 'skill' as const,
          registered: isCommand || isSkill,
        };
      });
      const typeMap = new Map<string, number>();
      for (const s of ranked) {
        typeMap.set(s.type, (typeMap.get(s.type) || 0) + s.count);
      }
      const byType = [...typeMap.entries()].map(([type, count]) => ({ type, count }));
      return { ...result, ranked, unused, byType, queryTimeMs };
    });
  });

  app.get<{ Querystring: QueryParams }>('/tokens', { preHandler: [parseDaysPreHandler] }, async (req) => {
    const obsReq = req as ObsRequest;
    return cachedResult(req.url, 300_000, () => {
      const { result, queryTimeMs } = timed(() => aggregateTokens(obsReq.telemetryEntries, obsReq.granularity));
      return { ...result, queryTimeMs };
    });
  });

  app.get<{ Querystring: QueryParams }>('/cost', { preHandler: [parseDaysPreHandler] }, async (req) => {
    const obsReq = req as ObsRequest;
    return cachedResult(req.url, 300_000, () => {
      const { result, queryTimeMs } = timed(() => aggregateCost(obsReq.telemetryEntries, obsReq.granularity));
      return { ...result, queryTimeMs };
    });
  });

  app.get<{ Querystring: QueryParams }>('/sessions', { preHandler: [parseDaysPreHandler] }, async (req) => {
    const obsReq = req as ObsRequest;
    return cachedResult(req.url, 300_000, () => {
      const { result, queryTimeMs } = timed(() => aggregateSessions(obsReq.telemetryEntries, obsReq.granularity));
      const gateMap = readSessionGateInfo();
      for (const session of result.sessions) {
        session.gateInfo = toGateInfo(gateMap.get(session.sessionId));
      }
      return { ...result, queryTimeMs };
    });
  });

  app.get<{ Params: { id: string }; Querystring: QueryParams }>(
    '/sessions/:id/trace',
    { preHandler: [parseDaysPreHandler] },
    async (req) => {
      const sessionId = decodeURIComponent(req.params.id);
      return cachedResult(req.url, 30_000, () => {
        const { result, queryTimeMs } = timed(() => aggregateSessionTrace((req as ObsRequest).telemetryEntries, sessionId));
        const gateMap = readSessionGateInfo();
        result.gateInfo = toGateInfo(gateMap.get(sessionId));
        return { ...result, queryTimeMs };
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/sessions/:id/context-files',
    async (req) => {
      const sessionId = decodeURIComponent(req.params.id);
      return cachedResult(req.url, 300_000, () => readContextFiles(sessionId));
    },
  );

  app.get<{ Params: { name: string }; Querystring: QueryParams }>(
    '/tools/:name',
    { preHandler: [parseDaysPreHandler] },
    async (req) => {
      const obsReq = req as ObsRequest;
      return cachedResult(req.url, 60_000, () => {
        const toolName = decodeURIComponent(req.params.name);
        const { result, queryTimeMs } = timed(() => aggregateToolDetail(obsReq.telemetryEntries, toolName));
        return { ...result, queryTimeMs };
      });
    },
  );

  app.get<{ Querystring: QueryParams }>('/hooks/events', { preHandler: [parseDaysPreHandler] }, async (req) => {
    const obsReq = req as ObsRequest;
    return cachedResult(req.url, 60_000, () => {
      const { result, queryTimeMs } = timed(() => aggregateHookEvents(obsReq.telemetryEntries));
      return { ...result, queryTimeMs };
    });
  });

  app.get<{ Params: { name: string }; Querystring: QueryParams }>(
    '/hooks/:name',
    { preHandler: [parseDaysPreHandler] },
    async (req) => {
      const obsReq = req as ObsRequest;
      return cachedResult(req.url, 60_000, () => {
        const hookName = decodeURIComponent(req.params.name);
        const { result, queryTimeMs } = timed(() => aggregateHookDetail(obsReq.telemetryEntries, hookName));
        const active = result.fullCommand ? checkHookActive(result.fullCommand) : false;
        const sourceCode = result.fullCommand ? readHookSource(result.fullCommand) : undefined;
        return { ...result, active, sourceCode, queryTimeMs };
      });
    },
  );

  app.get<{ Params: { name: string }; Querystring: QueryParams }>(
    '/skills/:name',
    { preHandler: [parseDaysPreHandler] },
    async (req) => {
      const obsReq = req as ObsRequest;
      return cachedResult(req.url, 60_000, () => {
        const skillName = decodeURIComponent(req.params.name);
        const { result, queryTimeMs } = timed(() => aggregateSkillDetail(obsReq.telemetryEntries, skillName));
        const projects = [...new Set(result.invocations?.map((i: { project: string }) => i.project) ?? [])];
        const sourceContent = findSkillSource(skillName, projects);
        const commandNames = getCommandNames();
        const bare = skillName.startsWith('/') ? skillName.slice(1) : skillName;
        const type = commandNames.has(bare) ? 'command' as const : 'skill' as const;
        return { ...result, sourceContent, type, queryTimeMs };
      });
    },
  );

  app.get<{ Querystring: QueryParams }>(
    '/memory/usage',
    { preHandler: [parseDaysPreHandler] },
    async (req) => {
      const obsReq = req as ObsRequest;
      return cachedResult(req.url, 60_000, () => {
        const { result, queryTimeMs } = timed(() => aggregateMemoryUsage(obsReq.telemetryEntries, obsReq.granularity));
        return { ...result, queryTimeMs };
      });
    },
  );

  app.get<{ Querystring: QueryParams }>(
    '/memory/searches',
    { preHandler: [parseDaysPreHandler] },
    async (req) => {
      const obsReq = req as ObsRequest;
      return cachedResult(req.url, 60_000, () => {
        const { result, queryTimeMs } = timed(() => aggregateMemorySearches(obsReq.telemetryEntries));
        return { ...result, queryTimeMs };
      });
    },
  );

  app.get<{ Querystring: { type?: string; tag?: string; q?: string; limit?: string } }>(
    '/memory/items',
    async (req) => {
      const dbPath = getMemoryDbPath();
      if (!existsSync(dbPath)) {
        return { items: [] };
      }

      const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10) || 50, 1), MAX_MEMORY_ITEMS);
      const conditions: string[] = [];
      const params: (string | number)[] = [];
      const useFts = !!req.query.q;

      if (req.query.type) {
        conditions.push('m.memory_type = ?');
        params.push(req.query.type);
      }
      if (req.query.tag) {
        // tags column has no FTS index; use instr to avoid LIKE wildcard interpretation
        conditions.push('instr(m.tags, ?) > 0');
        params.push(req.query.tag);
      }
      if (req.query.q) {
        // memory_content_fts is an FTS5 content table (trigram tokenizer) kept in sync
        // by triggers on the memories table. Join it instead of scanning content with LIKE.
        conditions.push('memory_content_fts MATCH ?');
        params.push(req.query.q);
      }

      const where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';
      // When FTS is active, join the virtual table so MATCH applies to the right context.
      const from = useFts
        ? 'memories m JOIN memory_content_fts ON memory_content_fts.rowid = m.id'
        : 'memories m';
      const sql = `SELECT m.id, m.content, m.memory_type, m.tags, m.created_at, m.updated_at FROM ${from}${where} ORDER BY m.created_at DESC LIMIT ?`;
      params.push(limit);

      let db: Database | null = null;
      try {
        db = new Database(dbPath, { readonly: true });
        const rows = db.query(sql).all(...params) as Array<Record<string, unknown>>;
        const items = rows.map((row) => ({
          ...row,
          created_at: typeof row.created_at === 'number'
            ? new Date(row.created_at * 1000).toISOString()
            : row.created_at,
          updated_at: typeof row.updated_at === 'number'
            ? new Date(row.updated_at * 1000).toISOString()
            : row.updated_at,
        }));
        return { items };
      } catch (err) {
        app.log.error(`memory/items query failed: ${(err as Error).message}`);
        return { items: [], error: 'query failed' };
      } finally {
        db?.close();
      }
    },
  );

  app.put<{ Params: { id: string }; Body: { content: string } }>(
    '/memory/:id',
    async (req) => {
      const dbPath = getMemoryDbPath();
      if (!existsSync(dbPath)) return { error: 'memory db not found' };
      const { id } = req.params;
      const { content } = req.body as { content: string };
      if (!content || typeof content !== 'string') return { error: 'content required' };
      let db: Database | null = null;
      try {
        db = new Database(dbPath);
        db.run(`UPDATE memories SET content = ?, updated_at = unixepoch() WHERE id = ?`, [content, id]);
        return { ok: true };
      } catch (err) {
        app.log.error(`memory update failed for id ${id}: ${(err as Error).message}`);
        return { error: 'Operation failed' };
      } finally {
        db?.close();
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/memory/:id',
    async (req) => {
      const dbPath = getMemoryDbPath();
      if (!existsSync(dbPath)) return { error: 'memory db not found' };
      const { id } = req.params;
      let db: Database | null = null;
      try {
        db = new Database(dbPath);
        db.run(`DELETE FROM memories WHERE id = ?`, [id]);
        return { ok: true };
      } catch (err) {
        app.log.error(`memory delete failed for id ${id}: ${(err as Error).message}`);
        return { error: 'Operation failed' };
      } finally {
        db?.close();
      }
    },
  );

  app.get<{ Querystring: QueryParams }>('/compaction', { preHandler: [parseDaysPreHandler] }, async (req) => {
    const obsReq = req as ObsRequest;
    return cachedResult(req.url, 60_000, () => {
      const { result, queryTimeMs } = timed(() => aggregateCompaction(obsReq.telemetryEntries, obsReq.granularity));
      return { ...result, queryTimeMs };
    });
  });

  app.get<{ Querystring: QueryParams }>('/api-duration', { preHandler: [parseDaysPreHandler] }, async (req) => {
    const obsReq = req as ObsRequest;
    return cachedResult(req.url, 60_000, () => {
      const { result, queryTimeMs } = timed(() => aggregateApiDuration(obsReq.telemetryEntries, obsReq.granularity));
      return { ...result, queryTimeMs };
    });
  });

  app.get<{ Querystring: QueryParams & { type?: string; search?: string; limit?: string; offset?: string } }>(
    '/events',
    { preHandler: [parseDaysPreHandler] },
    async (req) => {
      // Events are not cached — they're paginated and search-filtered, so the URL
      // key already differentiates pages/queries, but staleness of 5s is fine.
      return cachedResult(req.url, 5_000, () => {
        const limit = Math.min(Math.max(parseInt(req.query.limit || '100', 10) || 100, 1), 500);
        const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);
        const filters: { entryType?: string; search?: string } = {};
        if (req.query.type) filters.entryType = req.query.type;
        if (req.query.search) filters.search = req.query.search;
        const { result, queryTimeMs } = timed(() =>
          getRecentEvents((req as ObsRequest).telemetryEntries, limit, offset, filters),
        );
        return { ...result, queryTimeMs };
      });
    },
  );

  app.get('/memory', async () => {
    const rows = app.sqlite
      .query('SELECT taken_at, total, by_type, health, by_tag FROM obs_memory_snapshots ORDER BY taken_at DESC LIMIT 100')
      .all() as Array<{ taken_at: string; total: number; by_type: string; health: string; by_tag: string }>;

    return {
      snapshots: rows.map((r) => ({
        takenAt: r.taken_at,
        total: r.total,
        byType: JSON.parse(r.by_type),
        health: JSON.parse(r.health),
        byTag: JSON.parse(r.by_tag),
      })),
    };
  });

  app.get('/db-stats', async () => {
    const constructDbPath = dataPaths.db;
    const memoryDbPath = getMemoryDbPath();

    type DbInfo = {
      name: string;
      path: string;
      sizeBytes: number;
      walSizeBytes: number;
      tables: Array<{ name: string; rows: number }>;
    };

    function getDbInfo(name: string, dbPath: string): DbInfo | null {
      if (!existsSync(dbPath)) return null;
      const stat = statSync(dbPath);
      const walPath = dbPath + '-wal';
      const walSize = existsSync(walPath) ? statSync(walPath).size : 0;
      let db: Database | null = null;
      try {
        db = new Database(dbPath, { readonly: true });
        const tableNames = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
        const tables = tableNames.flatMap((t) => {
          try {
            const countRow = db!.query(`SELECT count(*) as c FROM "${t.name}"`).get() as { c: number };
            return [{ name: t.name, rows: countRow.c }];
          } catch { return []; }
        });
        return { name, path: dbPath, sizeBytes: stat.size, walSizeBytes: walSize, tables };
      } catch {
        return { name, path: dbPath, sizeBytes: stat.size, walSizeBytes: walSize, tables: [] };
      } finally {
        db?.close();
      }
    }

    const databases = [
      getDbInfo('construct', constructDbPath),
      getDbInfo('memory', memoryDbPath),
    ].filter(Boolean);

    return { databases };
  });

  app.get('/db-schema/:db/:table', async (request) => {
    const { db: dbName, table } = request.params as { db: string; table: string };
    const dbPath = dbName === 'construct' ? dataPaths.db : dbName === 'memory' ? getMemoryDbPath() : null;
    if (!dbPath || !existsSync(dbPath)) return { columns: [] };

    let db: Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true });
      const safeTable = table.replace(/[^a-zA-Z0-9_]/g, '');
      const columns = db.query(`PRAGMA table_info("${safeTable}")`).all() as Array<{
        cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number;
      }>;
      return { columns: columns.map(c => ({ name: c.name, type: c.type, notnull: !!c.notnull, pk: !!c.pk, defaultValue: c.dflt_value })) };
    } catch {
      return { columns: [] };
    } finally {
      db?.close();
    }
  });

  app.get<{ Params: { db: string; table: string }; Querystring: { limit?: string; offset?: string } }>(
    '/db-contents/:db/:table',
    async (request) => {
      const { db: dbName, table } = request.params;
      const limit = Math.min(Math.max(parseInt(request.query.limit || '50', 10) || 50, 1), 200);
      const offset = Math.max(parseInt(request.query.offset || '0', 10) || 0, 0);
      const dbPath = dbName === 'construct' ? dataPaths.db : dbName === 'memory' ? getMemoryDbPath() : null;
      if (!dbPath || !existsSync(dbPath)) return { rows: [], total: 0 };
      const safeTable = table.replace(/[^a-zA-Z0-9_]/g, '');
      let db: Database | null = null;
      try {
        db = new Database(dbPath, { readonly: true });
        const totalRow = db.query(`SELECT count(*) as c FROM "${safeTable}"`).get() as { c: number };
        const rows = db.query(`SELECT * FROM "${safeTable}" LIMIT ? OFFSET ?`).all(limit, offset);
        return { rows, total: totalRow.c };
      } catch (err) {
        app.log.error(`db table query failed for ${safeTable}: ${(err as Error).message}`);
        return { rows: [], total: 0, error: 'Operation failed' };
      } finally {
        db?.close();
      }
    },
  );

  app.get<{ Querystring: QueryParams }>('/subagents', { preHandler: [parseDaysPreHandler] }, async (req) => {
    const obsReq = req as ObsRequest;
    return cachedResult(req.url, 60_000, () => {
      const { result, queryTimeMs } = timed(() => aggregateSubagents(obsReq.telemetryEntries, obsReq.granularity));
      return { ...result, queryTimeMs };
    });
  });

  app.post('/memory/snapshot', async () => {
    const { execFileSync } = await import('child_process');
    try {
      const scriptPath = resolve(import.meta.dirname, '../../../../memory/obs-snapshot.ts');
      execFileSync('bun', [scriptPath], {
        timeout: 5000,
        stdio: 'pipe',
      });
      return { status: 'ok' };
    } catch (err) {
      app.log.error(`memory snapshot failed: ${String(err)}`);
      return { status: 'error', message: 'Internal error' };
    }
  });

  // ---------------------------------------------------------------------------
  // Evals
  // ---------------------------------------------------------------------------

  app.get('/evals', async () => {
    const evalsFile = resolve(dataPaths.root, 'evals', 'results.jsonl');
    if (!existsSync(evalsFile)) {
      return { evals: [], byDay: [], totalRuns: 0, overallPassAt3Rate: 0 };
    }

    let lines: string[];
    try {
      lines = readFileSync(evalsFile, 'utf-8').split('\n').filter(Boolean);
    } catch {
      return { evals: [], byDay: [], totalRuns: 0, overallPassAt3Rate: 0 };
    }

    // Parse all eval results
    type EvalEntry = { ts: string; evalName: string; attempt: number; passed: number; failed: number; passAt1: boolean };
    const entries: EvalEntry[] = [];
    for (const line of lines) {
      try { entries.push(JSON.parse(line)); } catch {}
    }

    // Group by eval name
    const byName = new Map<string, EvalEntry[]>();
    for (const e of entries) {
      if (!byName.has(e.evalName)) byName.set(e.evalName, []);
      byName.get(e.evalName)!.push(e);
    }

    // Calculate pass@k per eval
    const evals = [...byName.entries()].map(([name, runs]) => {
      const sorted = runs.sort((a, b) => a.ts.localeCompare(b.ts));
      const passAt1Runs = sorted.filter(r => r.passAt1).length;
      const passAt1Rate = Math.round((passAt1Runs / sorted.length) * 100);

      // pass@3: group consecutive runs of ≤3 and check if any succeed
      let pass3 = 0; let total3 = 0;
      for (let i = 0; i < sorted.length; i += 3) {
        const window = sorted.slice(i, i + 3);
        total3++;
        if (window.some(r => r.passed > 0 && r.failed === 0)) pass3++;
      }
      const passAt3Rate = total3 > 0 ? Math.round((pass3 / total3) * 100) : 0;

      // Trend: compare last 3 runs vs previous 3
      const recent3 = sorted.slice(-3);
      const prev3 = sorted.slice(-6, -3);
      const recentPassRate = recent3.filter(r => r.passAt1).length / Math.max(recent3.length, 1);
      const prevPassRate = prev3.length > 0 ? prev3.filter(r => r.passAt1).length / prev3.length : recentPassRate;
      const trend = prev3.length === 0 ? 'stable'
        : recentPassRate > prevPassRate + 0.1 ? 'improving'
        : recentPassRate < prevPassRate - 0.1 ? 'regressing'
        : 'stable';

      return { name, totalRuns: sorted.length, passAt1Rate, passAt3Rate, lastRun: sorted[sorted.length - 1].ts, trend };
    });

    // By day
    const dayMap = new Map<string, { runs: number; passes: number }>();
    for (const e of entries) {
      const day = e.ts.slice(0, 10);
      const cur = dayMap.get(day) ?? { runs: 0, passes: 0 };
      cur.runs++;
      if (e.passAt1) cur.passes++;
      dayMap.set(day, cur);
    }
    const byDay = [...dayMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, { runs, passes }]) => ({ date, runs, passRate: runs > 0 ? Math.round((passes / runs) * 100) : 0 }));

    const totalRuns = entries.length;
    const passAt3Rates = evals.map(e => e.passAt3Rate);
    const overallPassAt3Rate = passAt3Rates.length > 0
      ? Math.round(passAt3Rates.reduce((s, r) => s + r, 0) / passAt3Rates.length)
      : 0;

    return { evals, byDay, totalRuns, overallPassAt3Rate };
  });

  // ---------------------------------------------------------------------------
  // Eval scenario management
  // ---------------------------------------------------------------------------

  const SCENARIOS_DIR = resolve(import.meta.dirname, '../../../../eval/scenarios');
  const EVALS_RESULTS_FILE = resolve(dataPaths.root, 'evals', 'results.jsonl');

  app.get('/evals/scenarios', async () => {
    if (!existsSync(SCENARIOS_DIR)) return { scenarios: [] };
    const dirNames = listHookScenarios(SCENARIOS_DIR);
    const scenarios = [];
    for (const dirName of dirNames) {
      try {
        const s = loadScenario(resolve(SCENARIOS_DIR, dirName));
        scenarios.push({
          name: s.name,
          dirName,
          description: s.description,
          hook: s.hook,
          event: s.event,
          expect: s.expect,
          depth: s.setup.depth,
          trials: s.trials,
          prompt: s.setup.prompt.slice(0, 200),
          constraints: s.setup.constraints ?? [],
        });
      } catch (err) {
        // Skip malformed scenarios but log
        app.log.warn(`Failed to load scenario ${dirName}: ${(err as Error).message}`);
      }
    }
    return { scenarios };
  });

  app.get<{ Params: { name: string } }>('/evals/scenarios/:name', async (req, reply) => {
    const { name } = req.params;
    const scenarioDir = resolve(SCENARIOS_DIR, name);
    if (!existsSync(scenarioDir) || !existsSync(resolve(scenarioDir, 'scenario.yaml'))) {
      reply.code(404);
      return { error: `Scenario '${name}' not found` };
    }

    let scenario;
    try {
      scenario = loadScenario(scenarioDir);
    } catch (err) {
      app.log.error(`Failed to load scenario ${name}: ${(err as Error).message}`);
      reply.code(400);
      return { error: 'Failed to load scenario' };
    }

    const evalName = `hook:${scenario.name}`;
    const runs: Array<{
      ts: string;
      passed: number;
      failed: number;
      passAt1: boolean;
      hookName: string;
      expectedDecision: string;
      actualDecision: string | null;
      tier: number | null;
      graders: Array<{ type: string; result: string; decision?: string }>;
    }> = [];

    if (existsSync(EVALS_RESULTS_FILE)) {
      try {
        const lines = readFileSync(EVALS_RESULTS_FILE, 'utf-8').split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const entry = JSON.parse(line) as Record<string, unknown>;
            if (entry.evalName !== evalName) continue;
            runs.push({
              ts: entry.ts as string,
              passed: (entry.passed as number) ?? 0,
              failed: (entry.failed as number) ?? 0,
              passAt1: (entry.passAt1 as boolean) ?? false,
              hookName: (entry.hookName as string) ?? scenario.hook,
              expectedDecision: (entry.expectedDecision as string) ?? scenario.expect,
              actualDecision: (entry.actualDecision as string | null) ?? null,
              tier: (entry.tier as number | null) ?? null,
              graders: (entry.graders as Array<{ type: string; result: string; decision?: string }>) ?? [],
            });
          } catch {}
        }
      } catch {}
    }

    runs.sort((a, b) => b.ts.localeCompare(a.ts));
    return { scenario, runs };
  });

  app.post<{
    Body: {
      name: string;
      description: string;
      hook: string;
      event: string;
      expect: 'block' | 'advisory' | 'pass';
      setup: { depth: 'full' | 'quick'; prompt: string; constraints?: string[] };
      success: Array<{ type: string; expected?: string; description?: string }>;
      trials: number;
    };
  }>('/evals/scenarios', async (req, reply) => {
    const body = req.body;
    if (!body.name || typeof body.name !== 'string') {
      reply.code(400); return { error: 'name is required' };
    }
    if (!['block', 'advisory', 'pass'].includes(body.expect)) {
      reply.code(400); return { error: 'expect must be block|advisory|pass' };
    }
    if (!body.setup?.prompt) {
      reply.code(400); return { error: 'setup.prompt is required' };
    }
    if (!['full', 'quick'].includes(body.setup?.depth)) {
      reply.code(400); return { error: 'setup.depth must be full|quick' };
    }
    if (!Array.isArray(body.success) || body.success.length === 0) {
      reply.code(400); return { error: 'success must be a non-empty array' };
    }
    if (typeof body.trials !== 'number' || body.trials < 1) {
      reply.code(400); return { error: 'trials must be a positive number' };
    }

    const dirName = body.name.toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '');
    const scenarioDir = resolve(SCENARIOS_DIR, dirName);

    if (existsSync(scenarioDir)) {
      reply.code(409); return { error: `Scenario directory '${dirName}' already exists` };
    }

    const yamlContent = yamlStringify({
      name: body.name,
      description: body.description,
      hook: body.hook,
      event: body.event,
      expect: body.expect,
      setup: body.setup,
      success: body.success,
      trials: body.trials,
    });

    try {
      mkdirSync(scenarioDir, { recursive: true });
      writeFileSync(resolve(scenarioDir, 'scenario.yaml'), yamlContent, 'utf-8');
    } catch (err) {
      app.log.error(`Failed to write scenario ${dirName}: ${(err as Error).message}`);
      reply.code(500); return { error: 'Internal error' };
    }

    reply.code(201);
    return { created: true, dirName };
  });

  app.post<{ Params: { name: string } }>('/evals/run/:name', async (req, reply) => {
    const { name } = req.params;
    const scenarioDir = resolve(SCENARIOS_DIR, name);
    if (!existsSync(scenarioDir) || !existsSync(resolve(scenarioDir, 'scenario.yaml'))) {
      reply.code(404); return { error: `Scenario '${name}' not found` };
    }

    const runnerPath = resolve(import.meta.dirname, '../../../../eval/runner.ts');
    const projectRoot = resolve(import.meta.dirname, '../../../..');

    const child = spawn('bun', [runnerPath, '--hook-scenario', name], {
      detached: true,
      stdio: 'ignore',
      cwd: projectRoot,
    });
    child.unref();

    return { started: true, scenarioName: name, pid: child.pid };
  });

  app.get<{ Querystring: { scenario?: string; limit?: string; offset?: string } }>(
    '/evals/runs',
    async (req) => {
      if (!existsSync(EVALS_RESULTS_FILE)) {
        return { runs: [], total: 0 };
      }

      const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10) || 50, 1), 500);
      const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);
      const scenarioFilter = req.query.scenario;

      let lines: string[];
      try {
        lines = readFileSync(EVALS_RESULTS_FILE, 'utf-8').split('\n').filter(Boolean);
      } catch {
        return { runs: [], total: 0 };
      }

      type RunEntry = {
        ts: string;
        evalName: string;
        attempt: number;
        passed: number;
        failed: number;
        passAt1: boolean;
        hookName?: string;
        scenarioName?: string;
        expectedDecision?: string;
        actualDecision?: string;
        tier?: number;
        graders?: Array<{ type: string; result: string }>;
      };

      const all: RunEntry[] = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as RunEntry;
          if (scenarioFilter) {
            // Match by evalName "hook:<scenarioName>" or explicit scenarioName field
            const matchesName = entry.evalName === `hook:${scenarioFilter}` || entry.scenarioName === scenarioFilter;
            if (!matchesName) continue;
          }
          all.push(entry);
        } catch {}
      }

      // Sort newest first
      all.sort((a, b) => b.ts.localeCompare(a.ts));
      const total = all.length;
      const runs = all.slice(offset, offset + limit);

      return { runs, total };
    },
  );

  // ---------------------------------------------------------------------------
  // Verifications
  // ---------------------------------------------------------------------------

  app.get<{ Querystring: QueryParams }>('/verifications', { preHandler: [parseDaysPreHandler] }, async (req) => {
    const obsReq = req as ObsRequest;
    return cachedResult(req.url, 60_000, () => {
      const { result, queryTimeMs } = timed(() => aggregateVerifications(obsReq.telemetryEntries, obsReq.granularity));
      return { ...result, queryTimeMs };
    });
  });

  // ---------------------------------------------------------------------------
  // Learning & Compliance endpoints
  // ---------------------------------------------------------------------------

  app.get('/learning/loop', async (req: FastifyRequest<{ Querystring: QueryParams }>) => {
    const days = rangeToDays(req.query.range) ?? 30;
    return cachedResult(`/learning/loop?days=${days}`, 60_000, () => {
      // Memory count from the real sqlite DB, filtered to selected range
      let memoryCount = 0;
      try {
        const memDbPath = getMemoryDbPath();
        if (existsSync(memDbPath)) {
          const db = new Database(memDbPath, { readonly: true });
          const since = (Date.now() - days * 86400000) / 1000;
          const row = db.query<{ n: number }, [number]>(
            `SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NULL
             AND created_at >= ?
             AND (memory_type IN ('pattern','learning','feedback','decision','error')
                  OR tags LIKE '%preference%' OR tags LIKE '%correction%')`,
          ).get(since);
          memoryCount = row?.n ?? 0;
          db.close();
        }
      } catch { /* DB unavailable — leave 0 */ }

      // Provenance comes from telemetry memory_write events (one per stored memory).
      type LearningItem = {
        ts: string; sessionId: string; memoryId?: string;
        type: string; source: string; insight: string;
        content: string; tags: string;
      };
      const entries = parseSessionsForDays(days);
      const items: LearningItem[] = [];
      for (const e of entries) {
        if (e.kind !== 'memory_write' || !e.data) continue;
        items.push({
          ts: e.ts,
          sessionId: e.sid,
          memoryId: e.data.memoryId as string | undefined,
          type: (e.data.memoryType as string) ?? 'session',
          source: (e.data.source as string) ?? '',
          insight: (e.data.insight as string) ?? '',
          content: (e.data.content as string) ?? '',
          tags: (e.data.tags as string) ?? '',
        });
      }
      items.sort((a, b) => b.ts.localeCompare(a.ts));
      return { items: items.slice(0, 200), total: items.length, memoryCount };
    });
  });

  app.get('/learning/directives', async () => {
    return cachedResult('/learning/directives', 60_000, () => {
      type DirectiveEntry = { ts: string; sessionId: string; directives: string[]; promptWords?: number };
      const directives: DirectiveEntry[] = [];
      const depthCounts: Record<string, number> = {};
      const skillHits: Record<string, number> = {};
      const byDay: Record<string, { full: number; quick: number; total: number }> = {};

      for (const e of parseSessionsForDays(30)) {
        if (e.kind !== 'directive' || !e.data) continue;
        const dirArr = (e.data.directives as string[]) ?? [];
        directives.push({
          ts: e.ts,
          sessionId: e.sid,
          directives: dirArr,
          promptWords: e.data.promptWords as number | undefined,
        });
        const day = e.ts.slice(0, 10);
        if (day) {
          if (!byDay[day]) byDay[day] = { full: 0, quick: 0, total: 0 };
          byDay[day].total++;
        }
        for (const d of dirArr) {
          const upper = d.toUpperCase();
          if (upper.startsWith('FULL')) {
            depthCounts['FULL'] = (depthCounts['FULL'] ?? 0) + 1;
            if (day) byDay[day].full++;
          } else if (upper.startsWith('QUICK')) {
            depthCounts['QUICK'] = (depthCounts['QUICK'] ?? 0) + 1;
            if (day) byDay[day].quick++;
          }
          const skillMatch = d.match(/^(?:SKILL:|skill:)(.+)$/i);
          if (skillMatch) skillHits[skillMatch[1]] = (skillHits[skillMatch[1]] ?? 0) + 1;
        }
      }

      directives.sort((a, b) => b.ts.localeCompare(a.ts));
      const byDayArr = Object.entries(byDay).sort((a, b) => a[0].localeCompare(b[0])).map(([date, v]) => ({ date, ...v }));
      const topSkills = Object.entries(skillHits).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([skill, count]) => ({ skill, count }));
      return { directives: directives.slice(0, 200), total: directives.length, depthCounts, byDay: byDayArr, topSkills };
    });
  });

  app.get('/learning/feedback', async () => {
    return cachedResult('/learning/feedback', 60_000, () => {
      // Sentiment polarity → numeric score. Negative is flat; positive is graduated
      // by trigger word so "great" outweighs "thanks" in the avg rating display.
      function sentimentScore(polarity: string, trigger: string): number {
        if (polarity === 'negative') return 2;
        const t = trigger.toLowerCase().trim();
        if (/^(great|perfect|exactly|excellent|awesome|brilliant|nice work|love it|looks good)/.test(t)) return 9;
        if (/^(good|nice|cool|sweet|works|thanks)/.test(t)) return 7;
        return 8;
      }

      type FeedbackItem = {
        ts: string; sessionId: string;
        trigger: string; rating: number; type: 'sentiment' | 'numeric';
        priorText?: string; priorTools?: string[]; priorFiles?: string[];
        turnIndex?: number;
      };

      const items: FeedbackItem[] = [];
      const numericRatings: number[] = [];

      const entries = parseSessionsForDays(30);
      for (const e of entries) {
        if (!e.data) continue;
        if (e.kind === 'feedback') {
          const polarity = e.data.polarity as string | undefined;
          const triggerWord = ((e.data.trigger ?? e.data.prompt) as string | undefined) ?? '';
          items.push({
            ts: e.ts,
            sessionId: e.sid,
            trigger: ((e.data.prompt ?? e.data.trigger) as string | undefined) ?? '',
            rating: sentimentScore(polarity ?? '', triggerWord),
            type: 'sentiment',
            priorText: e.data.priorText as string | undefined,
            priorTools: e.data.priorTools as string[] | undefined,
            priorFiles: e.data.priorFiles as string[] | undefined,
            turnIndex: e.data.turnIndex as number | undefined,
          });
        } else if (e.kind === 'rating') {
          const rating = typeof e.data.rating === 'number' ? e.data.rating : 5;
          items.push({
            ts: e.ts,
            sessionId: e.sid,
            trigger: ((e.data.context ?? e.data.prompt ?? e.data.ratingType) as string | undefined) ?? 'rating',
            rating,
            type: 'numeric',
            priorText: e.data.priorText as string | undefined,
            priorTools: e.data.priorTools as string[] | undefined,
            priorFiles: e.data.priorFiles as string[] | undefined,
            turnIndex: e.data.turnIndex as number | undefined,
          });
          numericRatings.push(rating);
        }
      }

      items.sort((a, b) => b.ts.localeCompare(a.ts));
      const avgRating = numericRatings.length > 0
        ? numericRatings.reduce((s, r) => s + r, 0) / numericRatings.length
        : 0;

      return { items: items.slice(0, 200), avgRating, total: items.length };
    });
  });

  app.get('/gates/events', async () => {
    return cachedResult('/gates/events', 60_000, () => {
      type GateEvent = {
        ts: string; sessionId: string; hook: string;
        decision: 'pass' | 'block' | 'skip' | 'advisory';
        reason: string; editedFiles: string[];
        verifyPresent?: boolean; verifyMissing?: string[];
        verify?: Record<string, string | null>;
      };

      const events: GateEvent[] = [];
      for (const e of parseSessionsForDays(30)) {
        if (e.kind !== 'gate' || !e.data) continue;
        const rawDecision = (e.data.decision as string) ?? '';
        let decision: GateEvent['decision'] = rawDecision as GateEvent['decision'];
        const detail = (e.data.detail as string) ?? '';
        if (decision === 'pass' && detail.includes('user-affirmed')) {
          decision = 'skip';
        }
        events.push({
          ts: e.ts,
          sessionId: e.sid,
          hook: (e.data.hook as string) ?? '',
          decision,
          reason: detail,
          editedFiles: (e.data.editedFiles as string[]) ?? [],
          verifyPresent: e.data.verifyPresent as boolean | undefined,
          verifyMissing: e.data.verifyMissing as string[] | undefined,
          verify: e.data.verify as Record<string, string | null> | undefined,
        });
      }

      events.sort((a, b) => b.ts.localeCompare(a.ts));
      const passCount = events.filter(e => e.decision === 'pass').length;
      const blockCount = events.filter(e => e.decision === 'block').length;
      const skipCount = events.filter(e => e.decision === 'skip').length;
      const advisoryCount = events.filter(e => e.decision === 'advisory').length;

      return { events: events.slice(0, 200), total: events.length, passCount, blockCount, skipCount, advisoryCount };
    });
  });

  app.get<{ Querystring: { hook?: string; decision?: string; filePrefix?: string } }>(
    '/gates/pattern-events',
    async (req) => {
      const { hook: hookFilter, decision: decisionFilter, filePrefix: filePrefixFilter } = req.query;
      const cacheKey = `/gates/pattern-events?hook=${hookFilter}&decision=${decisionFilter}&filePrefix=${filePrefixFilter}`;
      return cachedResult(cacheKey, 60_000, () => {
        type GateEvent = {
          ts: string; sessionId: string; hook: string;
          decision: string; reason: string; editedFiles: string[];
          verifyPresent?: boolean; verifyMissing?: string[];
          verify?: Record<string, string | null>;
        };

        function computeFilePrefix(files: string[]): string {
          if (!files.length) return '';
          const parts = files[0].replace(/^\//, '').split('/');
          return parts.slice(0, 2).join('/') + '/';
        }

        const events: GateEvent[] = [];
        for (const e of parseSessionsForDays(30)) {
          if (e.kind !== 'gate' || !e.data) continue;
          const hook = (e.data.hook as string) ?? '';
          let decision = (e.data.decision as string) ?? '';
          const detail = (e.data.detail as string) ?? '';
          if (decision === 'pass' && detail.includes('user-affirmed')) decision = 'skip';
          if (decision === 'pass') continue;

          const editedFiles = (e.data.editedFiles as string[]) ?? [];
          if (hookFilter && hook !== hookFilter) continue;
          if (decisionFilter && decision !== decisionFilter) continue;
          if (filePrefixFilter !== undefined && computeFilePrefix(editedFiles) !== filePrefixFilter) continue;

          events.push({
            ts: e.ts,
            sessionId: e.sid,
            hook,
            decision,
            reason: detail,
            editedFiles,
            verifyPresent: e.data.verifyPresent as boolean | undefined,
            verifyMissing: e.data.verifyMissing as string[] | undefined,
            verify: e.data.verify as Record<string, string | null> | undefined,
          });
        }

        events.sort((a, b) => b.ts.localeCompare(a.ts));
        return { events };
      });
    },
  );

  app.get('/gates/patterns', async () => {
    return cachedResult('/gates/patterns', 60_000, () => {
      type PatternEntry = {
        hook: string; filePrefix: string; decision: 'block' | 'skip' | 'advisory';
        count: number; sessionIds: string[]; lastSeen: string;
        representativeReason: string; representativeFiles: string[];
      };

      type RawGate = {
        ts: string; sessionId: string; hook: string;
        decision: string; detail?: string; editedFiles?: string[];
        tier?: unknown;
      };

      const raw: RawGate[] = [];
      for (const e of parseSessionsForDays(30)) {
        if (e.kind !== 'gate' || !e.data) continue;
        const decision = (e.data.decision as string) ?? '';
        const detail = (e.data.detail as string) ?? '';
        let effectiveDecision = decision;
        if (effectiveDecision === 'pass' && detail.includes('user-affirmed')) effectiveDecision = 'skip';
        if (!['block', 'skip', 'advisory'].includes(effectiveDecision)) continue;

        raw.push({
          ts: e.ts,
          sessionId: e.sid,
          hook: (e.data.hook as string) ?? '',
          decision: effectiveDecision,
          detail,
          editedFiles: (e.data.editedFiles as string[]) ?? [],
          tier: e.data.tier,
        });
      }

      // Compute filePrefix (first 2 path segments) for each entry
      function filePrefix(files: string[]): string {
        if (!files.length) return '';
        const first = files[0];
        const parts = first.replace(/^\//, '').split('/');
        return parts.slice(0, 2).join('/') + '/';
      }

      // Group by (hook + decision + filePrefix)
      const groups = new Map<string, { entries: RawGate[]; prefixes: string[] }>();
      for (const entry of raw) {
        const prefix = filePrefix(entry.editedFiles ?? []);
        const key = `${entry.hook}||${entry.decision}||${prefix}`;
        if (!groups.has(key)) groups.set(key, { entries: [], prefixes: [] });
        groups.get(key)!.entries.push(entry);
        groups.get(key)!.prefixes.push(prefix);
      }

      const patterns: PatternEntry[] = [];
      for (const [key, { entries }] of groups) {
        if (entries.length < 2) continue;
        const [hook, decision, filePrefix] = key.split('||');
        const sessionIds = [...new Set(entries.map(e => e.sessionId))];
        const lastSeen = entries.map(e => e.ts).sort().reverse()[0];
        const rep = entries[0];
        patterns.push({
          hook,
          filePrefix,
          decision: decision as 'block' | 'skip' | 'advisory',
          count: entries.length,
          sessionIds,
          lastSeen,
          representativeReason: rep.detail ?? '',
          representativeFiles: rep.editedFiles ?? [],
        });
      }

      patterns.sort((a, b) => b.count - a.count);
      return { patterns };
    });
  });

  app.get<{ Params: { id: string } }>('/sessions/:id/gates', async (req) => {
    const sessionId = decodeURIComponent(req.params.id);
    return cachedResult(`/sessions/${sessionId}/gates`, 30_000, () => {
      type GateEvent = {
        ts: string; sessionId: string; hook: string;
        decision: 'pass' | 'block' | 'skip' | 'advisory';
        reason: string; editedFiles: string[];
        verifyPresent?: boolean; verifyMissing?: string[];
        verify?: Record<string, string | null>;
      };

      const events: GateEvent[] = [];
      for (const e of parseSessionsForDays(30)) {
        if (e.kind !== 'gate' || !e.data || e.sid !== sessionId) continue;
        const rawDecision = (e.data.decision as string) ?? '';
        let decision: GateEvent['decision'] = rawDecision as GateEvent['decision'];
        const detail = (e.data.detail as string) ?? '';
        if (decision === 'pass' && detail.includes('user-affirmed')) decision = 'skip';

        events.push({
          ts: e.ts,
          sessionId: e.sid,
          hook: (e.data.hook as string) ?? '',
          decision,
          reason: detail,
          editedFiles: (e.data.editedFiles as string[]) ?? [],
          verifyPresent: e.data.verifyPresent as boolean | undefined,
          verifyMissing: e.data.verifyMissing as string[] | undefined,
          verify: e.data.verify as Record<string, string | null> | undefined,
        });
      }

      events.sort((a, b) => b.ts.localeCompare(a.ts));
      const passCount = events.filter(e => e.decision === 'pass').length;
      const blockCount = events.filter(e => e.decision === 'block').length;
      const skipCount = events.filter(e => e.decision === 'skip').length;
      const advisoryCount = events.filter(e => e.decision === 'advisory').length;

      return { events, total: events.length, passCount, blockCount, skipCount, advisoryCount };
    });
  });

  app.get<{ Params: { id: string } }>('/sessions/:id/learning', async (req) => {
    const sessionId = decodeURIComponent(req.params.id);
    return cachedResult(`/sessions/${sessionId}/learning`, 30_000, () => {
      type LearningItem = {
        ts: string; sessionId: string; memoryId?: string;
        type: string; source: string; insight: string;
        content: string; tags: string;
      };
      type FeedbackItem = {
        ts: string; sessionId: string;
        trigger: string; polarity?: 'positive' | 'negative';
        rating?: number; type: 'sentiment' | 'numeric';
        priorText?: string; priorTools?: string[]; priorFiles?: string[];
      };

      const memories: LearningItem[] = [];
      const feedbackItems: FeedbackItem[] = [];
      const numericRatings: number[] = [];

      for (const e of parseSessionsForDays(30)) {
        if (e.sid !== sessionId || !e.data) continue;
        if (e.kind === 'memory_write') {
          memories.push({
            ts: e.ts,
            sessionId,
            memoryId: e.data.memoryId as string | undefined,
            type: (e.data.memoryType as string) ?? 'session',
            source: (e.data.source as string) ?? '',
            insight: (e.data.insight as string) ?? '',
            content: (e.data.content as string) ?? '',
            tags: (e.data.tags as string) ?? '',
          });
        } else if (e.kind === 'feedback') {
          feedbackItems.push({
            ts: e.ts,
            sessionId,
            trigger: (e.data.trigger as string) ?? '',
            polarity: e.data.polarity as 'positive' | 'negative' | undefined,
            type: 'sentiment',
            priorText: e.data.priorText as string | undefined,
            priorTools: e.data.priorTools as string[] | undefined,
            priorFiles: e.data.priorFiles as string[] | undefined,
          });
        } else if (e.kind === 'rating') {
          const rating = typeof e.data.rating === 'number' ? e.data.rating : undefined;
          feedbackItems.push({
            ts: e.ts,
            sessionId,
            trigger: (e.data.ratingType as string) ?? 'rating',
            rating,
            type: 'numeric',
          });
          if (rating !== undefined) numericRatings.push(rating);
        }
      }

      memories.sort((a, b) => b.ts.localeCompare(a.ts));
      feedbackItems.sort((a, b) => b.ts.localeCompare(a.ts));
      const avgRating = numericRatings.length > 0
        ? numericRatings.reduce((s, r) => s + r, 0) / numericRatings.length
        : 0;
      const positiveCount = feedbackItems.filter(f => f.polarity === 'positive').length;
      const negativeCount = feedbackItems.filter(f => f.polarity === 'negative').length;

      return { memories, feedback: feedbackItems, avgRating, positiveCount, negativeCount };
    });
  });

  // Pre-warm the cache for the most expensive endpoints on server start so the
  // first user request is always fast. Runs after all plugins are registered.
  app.addHook('onReady', (done) => {
    // Fire-and-forget background warmup — don't block server startup
    // URLs must match what the browser sends (granularity=day is omitted when default)
    const warmupUrls = [
      '/observability/tools?range=30d',
      '/observability/hooks?range=30d',
      '/observability/sessions?range=30d',
      '/observability/cost?range=30d',
      '/observability/tokens?range=30d',
      '/observability/overview?range=30d',
    ];
    for (const url of warmupUrls) {
      app.inject({ method: 'GET', url: `/api${url}` }).catch(() => {});
    }
    done();
  });
};
