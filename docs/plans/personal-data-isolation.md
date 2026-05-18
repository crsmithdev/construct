# Personal data isolation

Narrow scope: move the author's personal-profile content (USER.md and the personalized parts of SOUL/STYLE/AGENTS) out of the repo, replace with `@`-include chains that load user-side files from `~/.construct/identity/`. Required for the repo to ship publicly without leaking identity. Three rounds of red-team trimmed the scope from sprawling-public-face-plan back to this one focused doc.

## Out of scope (separate plans, separate concerns)

- README rewrite — just a commit when the time comes, not a plan
- Plugin packaging — on branch `feat/plugin-packaging`, has its own plan
- General publishability scrubs (port numbers, Greenshot, `.claude/CLAUDE.md`, citation paths, etc.) — publish-readiness polish, not personal data
- Git history wipe — separate destructive op, user-executed at publish time
- Phase 3/4 work from the deleted umbrella (menubar, public deploy) — file when relevant

## What's in scope

- `src/core/identity/USER.md` — out of repo, into `~/.construct/identity/USER.md`
- `src/core/identity/SOUL.md`, `STYLE.md`, `AGENTS.md` — base in repo + user-side `.override.md` chain
- `src/core/CLAUDE.md` — the `@`-include source that wires the chain
- `install.ts` — the changes that prevent the install-cycle bugs found in red-team

## Verify first (5 minutes, before any code change)

These are unknowns that change the design. Test before committing to a path.

| # | Question | How to test | What changes if "no" |
|---|---|---|---|
| V1 | Does Claude Code's `@`-include expand `~/` literal? | Drop `@~/foo.md` in a test CLAUDE.md, observe whether `/memory` lists it expanded | `install.ts` must rewrite `~/` → `$HOME` in `src/core/CLAUDE.md` at install time |
| V2 | What does Claude Code do on a missing `@`-include? | Reference a non-existent path, observe (silent skip / warning / error / literal text) | Affects fresh-install UX — empty `~/.construct/identity/` produces 4 broken includes |
| V3 | Does Claude Code prompt to approve first external `@~/` import? | Try a fresh project with a tilde import | If yes and user declines, overrides disabled forever (no remediation) |

## Steps

Five real steps. Each is one or two commits.

### 1. install.ts fixes

Two changes needed before the move can land safely. Without these, the migration is silently undone.

- **Drop identity files from `discoverAllCapsMd` preserve list** (`install.ts:82-87` + `:280` + `:344`). Currently the installer backs up every ALL-CAPS `.md` in `~/.claude/construct/core/identity/`, syncs from src, then restores the backups — silently undoing any trim in src. After this fix, identity files are not auto-preserved.
- **Create `~/.construct/identity/`** in the mkdir block at `install.ts:263-267`. Without it, step 2's manual `cp` fails ENOENT.

These two changes are independent of the rest. Land first. Test by running `bun install.ts` and confirming `~/.construct/identity/` exists and a manually-placed file isn't clobbered.

### 2. USER.md migration

One atomic commit. Sequence inside the commit:

1. User manually runs `cp ~/.claude/construct/core/identity/USER.md ~/.construct/identity/USER.md` (from the live deployed copy, not src — the src copy may be stale relative to the installed one)
2. `git rm src/core/identity/USER.md`
3. Add `src/core/identity/USER.md` to `.gitignore` (defense against future resurrection)
4. Change `src/core/CLAUDE.md:4` from `@identity/USER.md` to `@~/.construct/identity/USER.md` (or `@$HOME/.construct/...` per V1)

Pre-condition: step 1 of this plan must be deployed first. Otherwise install.ts wipes USER.md from the deploy mid-migration.

### 3. SOUL/STYLE/AGENTS base + extend

Three sub-steps, one per file. Each is its own commit.

For each of AGENTS, SOUL, STYLE:

1. Walk the file, classify each line as "core to Construct's behavior" or "personal preference"
2. User manually populates `~/.construct/identity/<NAME>.override.md` with the personal lines (the "diff," not a copy of the base — full-copy locks the user out of future base updates per BMAD's documented anti-pattern)
3. Remove the personal lines from `src/core/identity/<NAME>.md`
4. Add `@~/.construct/identity/<NAME>.override.md` to `src/core/CLAUDE.md` (after the existing base @-includes)

The AGENTS.md walkthrough was done this session: extract lines 80 ("Don't ask 'shall I proceed?'"), 93-99 (Haiku/Sonnet/Opus model table), 109-112 (Daily rhythm), 131 ("Squash when merging"). SOUL and STYLE walkthroughs still pending — do them before the corresponding sub-step.

USER.md asymmetry: kept as bare `USER.md` (no `.override` suffix) since it has no repo base — it's primary, not an override.

### 4. dist-plugin.ts author scrub

The plugin builder at `dist-plugin.ts:55-58` hard-codes `{"name": "Chris Smith", "url": "..."}` into the manifest emitter. Even after USER.md moves, every plugin build re-leaks the author via `dist/plugin/.claude-plugin/plugin.json`. Either read from env (`CONSTRUCT_AUTHOR_NAME`, `CONSTRUCT_AUTHOR_URL`) or drop the author field entirely.

Lives on `feat/plugin-packaging` worktree. Either land there, or coordinate after this plan's branch merges.

### 5. Test + doc drift fix

- `src/tests/install.test.ts:131` asserts `claudeMd.includes("@construct/core/identity/AGENTS.md") || claudeMd.includes("@construct/core/CLAUDE.md")` — the OR clause masks step 2/3 breakage. Update the test to require both clauses, or replace with a freshness check.
- `src/core/INSTALL.md:10` and `src/core/README.md:16,27` reference USER.md at its old location. Update.

## Verification

```bash
# 1. USER.md gone from repo, present in user dir
test ! -f src/core/identity/USER.md && test -f ~/.construct/identity/USER.md
echo "USER.md migrated"

# 2. @-include chain resolves correctly inside a real session
# (Run `/memory` inside Claude Code; confirm ~/.construct/identity/USER.md appears in the list)

# 3. install roundtrip preserves user-side files
bun install.ts && bun test.ts

# 4. install runs don't clobber the user's override files
diff -q ~/.construct/identity/USER.md <(echo "$KNOWN_CONTENT")
```

## What this does NOT address

These are real but separate concerns. Each gets its own commit / plan when relevant.

- `package.json` `author` field, `soul.json` `name/displayName/etc`, `codebase-auditor.md` hard-coded paths, `rules/docs/RULES.md:68` citation, comment-username leaks in `format.ts` / `observability.ts`, `e2e.test.ts:212` literal, fixture username leaks, `.claude/CLAUDE.md` workflow scrub, Greenshot/port-number generalization
- Git history retention (handle at publish time, separate destructive op)
- Plugin user override-include resolution (per Phase 2 F-4 from prior red-teams — plugin install creates no `~/.construct/identity/`, so plugin users get broken `@~/.construct/...` includes; handle in `feat/plugin-packaging` work)
- Trust-prompt UX on first external `@~/` import (per V3 — if this is a problem, address when implementing, not now)

These are listed so the plan doesn't pretend to do more than it does, not because the plan should grow to cover them.
