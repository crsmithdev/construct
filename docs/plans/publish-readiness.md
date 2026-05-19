# Publish readiness checklist

Tracking for everything that must be scrubbed/decided before the Construct repo is shared publicly. Split out from `personal-data-isolation.md` so the items survive after that plan merges.

Each row is a discrete scrub. Tackle individually; none block any other. Mark with `[x]` when done.

## Identity leaks (deferred from personal-data-isolation)

- [x] **1. `package.json` `author` field** — already absent. No `author`/`bugs.email`/`repository` personal fields present.
- [x] **2. `soul.json`** — deleted; nothing read it and it pointed at a removed `IDENTITY.md`. Identity now lives in AGENTS/SOUL/STYLE base + user overrides.
- [x] **3. `src/agents/codebase-auditor.md` hard-coded paths** — replaced `/home/crsmi/construct` with relative `src/` and "run from repo root".
- [x] **4. `src/rules/docs/RULES.md:68` citation** — citation uses relative `.claude/CLAUDE.md` path.
- [x] **5. Comment-username leaks** — `observability.ts:291` and `format.ts:166-167` comments use generic `-home-user-project` example.
- [x] **6. `src/tests/e2e.test.ts:212` literal** — `projDir` now `-home-testuser-construct`; encoding logic still exercises the same code path.
- [x] **7. Fixture username leaks (broad sweep)** — `sed crsmi → testuser` across all `src/telemetry/__tests__/fixtures/`. 528 tests still green.
- [x] **8. `.claude/CLAUDE.md` workflow scrub** — audited. File is repo-dev guidance, not personal data. Only fix needed: tightened "user owns 3001" framing to "active human dev's working tree, not the agent's" so the role distinction is explicit rather than relying on an implicit personal-pronoun reading.
- [x] **9. Greenshot reference** — `src/commands/ss.md` generalized to `SHOTS_DIR` / `SHOTS_LATEST` env vars. Port numbers (3000/3001/3002) intentionally kept — they're Construct's actual architecture, not personal config.

## Other pre-publish concerns

- [ ] **10. Git history retention** — wipe before publish. Options: `git filter-repo` (surgical, keeps history shape) or orphan-branch nuke (destructive, removes all email/identity from commit objects). User-executed at publish time; agent does NOT force-push.
- [x] **11. Plugin user override-include resolution** — dissolved. Plugin distribution dropped (see "Distribution decision" below). The `bun install.ts` path always creates `~/.construct/identity/`, so the original concern no longer applies.
- [ ] **12. Trust-prompt UX on first external `@~/`** (V3 from personal-data interview) — resolved as one-time dialog, reversible via settings. Action: document the prompt in README/INSTALL.md so first-time users know what they're being asked. No code change needed.

## Distribution decision (2026-05-19)

Construct ships **CLI-only** via `bun install.ts`. The plugin packaging direction was abandoned after:

- Claude Code plugin lifecycle hooks (PreInstall/PostInstall) don't exist — feature request [#11240](https://github.com/anthropics/claude-code/issues/11240) closed as duplicate.
- SessionStart-as-installer workaround broken on first run for marketplace plugins ([#10997](https://github.com/anthropics/claude-code/issues/10997)).
- Plugins can't ship a UI bundle, run a daemon, write systemd units, or create the DB — Construct's backend (research worker, observability UI, memory MCP, goals) needs all of these.
- Dual distribution paths (plugin + CLI) doubled the maintenance and introduced drift risk without delivering anything the CLI couldn't.

`feat/plugin-packaging` branch killed locally; remote branch preserved on origin for revival if the lifecycle-hook situation changes. `dist-plugin.ts` is dead code wherever it appears.

## Find-and-confirm one-liners

Run these before claiming any row done — they catch peer instances of the same leak shape.

```bash
# Identity strings across code + docs + config
grep -rIn -E 'crsmi(thdev)?|/home/crsmi|Chris Smith' \
  --include='*.ts' --include='*.md' --include='*.json' \
  src/ install.ts test.ts package.json | grep -v node_modules

# Test fixtures specifically
grep -rIn -E 'crsmi(thdev)?' src/tests/ | head -40

# Port + Greenshot references
grep -rIn -E '\b(3000|3001|3002)\b|[Gg]reenshot' src/ .claude/ docs/
```

## How this list got here

`personal-data-isolation.md` covers the `identity/` directory (USER.md + SOUL/STYLE/AGENTS base-extend split) — the biggest single category. Everything above was explicitly out of scope of that plan but must be addressed before the repo is publish-clean. This file is the single tracker so items don't fall through after that plan merges.
