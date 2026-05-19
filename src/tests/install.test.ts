#!/usr/bin/env bun
import { execSync } from "child_process";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { resolve } from "path";
import { check, createResults, printAndExit } from "../eval/harness.ts";

const ROOT = resolve(import.meta.dir, "../..");
const BUN = process.argv[0];
const r = createResults();

// ── Install preservation ─────────────────────────────────────────────────────

console.log("--- install preservation ---");

const sentinelPath = resolve(Bun.env.HOME!, ".construct/identity/TEST_SENTINEL.md");
const sentinelContent = "# Test Sentinel\n\nThis file tests user-side preservation across install.\n";
mkdirSync(resolve(Bun.env.HOME!, ".construct/identity"), { recursive: true });
writeFileSync(sentinelPath, sentinelContent);
check(r, "install: sentinel file created", existsSync(sentinelPath));

try {
  execSync(`${BUN} ${resolve(ROOT, "install.ts")}`, { encoding: "utf-8", timeout: 30000, cwd: ROOT, stdio: "pipe" });
  check(r, "install: user-side sentinel survived upgrade", existsSync(sentinelPath));
  check(r, "install: user-side sentinel content preserved", readFileSync(sentinelPath, "utf-8") === sentinelContent);
} catch (err: any) {
  check(r, "install: installer failed", false, err.message?.slice(0, 100));
}
try { unlinkSync(sentinelPath); } catch {}

// ── Identity files ──────────────────────────────────────────────────────────

console.log("\n--- identity files ---");

const identityDir = resolve(ROOT, "src/core/identity");
const expectedIdentity = ["AGENTS.md", "SOUL.md", "STYLE.md"];
for (const f of expectedIdentity) {
  const p = resolve(identityDir, f);
  check(r, `identity: ${f} exists`, existsSync(p));
  if (existsSync(p)) {
    const content = readFileSync(p, "utf-8");
    check(r, `identity: ${f} non-empty`, content.length > 10);
  }
}

// USER.md is user-side now — must NOT be in src or install dir
check(r, "identity: USER.md not in src (moved to ~/.construct/identity/)",
  !existsSync(resolve(identityDir, "USER.md")));

const installedIdentityDir = resolve(Bun.env.HOME!, ".claude/construct/core/identity");
if (existsSync(installedIdentityDir)) {
  for (const f of expectedIdentity) {
    const dst = resolve(installedIdentityDir, f);
    if (existsSync(dst)) {
      check(r, `identity: installed ${f} exists and non-empty`, readFileSync(dst, "utf-8").length > 10);
    }
  }
  check(r, "identity: installed USER.md absent (lives at ~/.construct/identity/)",
    !existsSync(resolve(installedIdentityDir, "USER.md")));
}

// ── Installed hooks ──────────────────────────────────────────────────────────

console.log("\n--- installed hooks ---");

const coreHooksDir = resolve(Bun.env.HOME!, ".claude/construct/core/hooks");
const memoryHooksDir = resolve(Bun.env.HOME!, ".claude/construct/memory/hooks");
const hooksJsonPath = resolve(coreHooksDir, "settings-hooks.json");

check(r, "hooks: settings-hooks.json installed", existsSync(hooksJsonPath));

if (existsSync(hooksJsonPath)) {
  let hooks: any;
  try { hooks = JSON.parse(readFileSync(hooksJsonPath, "utf-8")); } catch { hooks = null; }
  check(r, "hooks: settings-hooks.json valid JSON", hooks !== null);
  if (hooks?.hooks) {
    const groups = (Object.values(hooks.hooks) as Array<Array<{ hooks: Array<{ command: string }> }>>).flat();
    const entries = groups.flatMap(g => g.hooks ?? []);
    check(r, "hooks: at least 5 hooks registered", entries.length >= 5);
    check(r, "hooks: all commands reference .ts files", entries.every(h => h.command?.includes(".ts")));
  }
}

// ~/.claude/settings.json — merged output with path-rewritten commands
const settingsPath = resolve(Bun.env.HOME!, ".claude/settings.json");
if (existsSync(settingsPath)) {
  let settings: any;
  try { settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch { settings = null; }
  check(r, "settings.json: valid JSON", settings !== null);
  if (settings?.hooks) {
    const groups = (Object.values(settings.hooks) as Array<Array<{ hooks: Array<{ command: string }> }>>).flat();
    const entries = groups.flatMap(g => g.hooks ?? []);
    check(r, "settings.json: commands point to installed path", entries.every(h => !h.command?.includes(" src/")));
  }
}

const expectedCoreHooks = [
  "quality-format-edit.ts", "git-hygiene-stop.ts", "quality-check-stop.ts",
  "isolation-block-sql.ts", "security-scan-bash.ts", "quality-typecheck-edit.ts",
  "context-backup-precompact.ts", "context-monitor-stop.ts", "context-suggest-edit.ts",
  "git-require-edit.ts", "routing-classify-submit.ts",
];
for (const f of expectedCoreHooks) {
  check(r, `hooks: core/${f} installed`, existsSync(resolve(coreHooksDir, f)));
}

const expectedMemoryHooks = [
  "context-restore-start.ts", "rating-capture-submit.ts", "feedback-capture-submit.ts",
];
for (const f of expectedMemoryHooks) {
  check(r, `hooks: memory/${f} installed`, existsSync(resolve(memoryHooksDir, f)));
}

// ── Installed skills ─────────────────────────────────────────────────────────

console.log("\n--- installed skills ---");

const installedSkillsDir = resolve(Bun.env.HOME!, ".claude/construct/skills");
const skillRulesPath = resolve(installedSkillsDir, "skill-rules.json");
check(r, "skills: directory installed", existsSync(installedSkillsDir));
check(r, "skills: skill-rules.json installed", existsSync(skillRulesPath));
if (existsSync(skillRulesPath)) {
  let skillRules: any;
  try { skillRules = JSON.parse(readFileSync(skillRulesPath, "utf-8")); } catch { skillRules = null; }
  check(r, "skills: skill-rules.json valid JSON", skillRules !== null);
  check(r, "skills: has rules array with entries", Array.isArray(skillRules?.rules) && skillRules.rules.length > 0);
}

// ── Installed CLAUDE.md ──────────────────────────────────────────────────────

console.log("\n--- installed CLAUDE.md ---");

const claudeMdPath = resolve(Bun.env.HOME!, ".claude/CLAUDE.md");
check(r, "CLAUDE.md: exists", existsSync(claudeMdPath));
if (existsSync(claudeMdPath)) {
  const claudeMd = readFileSync(claudeMdPath, "utf-8");
  check(r, "CLAUDE.md: references @construct/core/CLAUDE.md", claudeMd.includes("@construct/core/CLAUDE.md"));
}

// ── Installed core CLAUDE.md identity chain ─────────────────────────────────

console.log("\n--- core CLAUDE.md identity chain ---");

const coreClaudeMdPath = resolve(Bun.env.HOME!, ".claude/construct/core/CLAUDE.md");
if (existsSync(coreClaudeMdPath)) {
  const coreMd = readFileSync(coreClaudeMdPath, "utf-8");
  check(r, "core CLAUDE.md: includes @identity/AGENTS.md", coreMd.includes("@identity/AGENTS.md"));
  check(r, "core CLAUDE.md: includes @identity/SOUL.md", coreMd.includes("@identity/SOUL.md"));
  check(r, "core CLAUDE.md: includes @identity/STYLE.md", coreMd.includes("@identity/STYLE.md"));
  check(r, "core CLAUDE.md: includes user-side USER.md via ~/", coreMd.includes("@~/.construct/identity/USER.md"));
}

printAndExit(r);
