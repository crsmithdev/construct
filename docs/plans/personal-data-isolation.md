# Personal data isolation

Narrow scope: move the author's personal-profile content (USER.md and the personalized parts of SOUL/STYLE/AGENTS) out of the repo, replace with `@`-include chains that load user-side files from `~/.construct/identity/`. Necessary but not sufficient for public ship — the "What this does NOT address" list below names other identity leaks (`soul.json`, `package.json`, `codebase-auditor.md` paths, fixture usernames) that each need their own scrub before the repo is publish-clean. This plan handles the largest single source: the identity/ directory.

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
| **V3 (P0 ship blocker)** | Does Claude Code prompt to approve first external `@~/` import, and does decline persist? | Fresh project with `@~/.construct/identity/USER.md`, accept-then-decline cycle to find remediation | If decline is sticky with no escape hatch, the whole `@~/`-include design is non-viable — fall back to `install.ts` rewriting includes to absolute paths inside `~/.claude/construct/` (which then needs the per-user override files copied/symlinked into the install dir). Resolve V3 before writing any code in step 2 or 3. |

## Steps

Five real steps. Each is one or two commits.

### 1. install.ts fixes

Three changes needed before the move can land safely. Without these, the migration is silently undone or fails on first run.

- **Drop identity files from `discoverAllCapsMd` preserve list** (`install.ts:82-87` + `:280` + `:344-353`). Currently the installer backs up every ALL-CAPS `.md` in `~/.claude/construct/core/identity/`, syncs from src, then restores the backups — silently undoing any trim in src. After this fix, identity files are not auto-preserved.
- **Verify cleanDst (`install.ts:113-124`) does the right thing post-removal.** This is the second delete path: after we `git rm src/core/identity/USER.md`, cleanDst removes `~/.claude/construct/core/identity/USER.md` from the deploy on next install — which is what we want, but only because the user-side copy lives in `~/.construct/identity/`, not in the install tree. No code change here, but the test in step 5 must exercise this path end-to-end (install → confirm deploy USER.md is gone → confirm user-side USER.md untouched).
- **Create `~/.construct/identity/`** in the mkdir block at `install.ts:263-267`. Without it, step 2's manual `cp` fails ENOENT.

These changes are independent of the rest. Land first. Test by running `bun install.ts` and confirming `~/.construct/identity/` exists and a manually-placed file isn't clobbered.

### 2. USER.md migration

Not atomic — this is a three-phase migration with one commit, gated by step 1 being deployed to the live install first.

**Pre-conditions (must hold before this commit):**
- Step 1 is committed AND `bun install.ts` has been run, so the live install no longer auto-preserves identity files. If you commit step 2 before deploying step 1, the next install run silently restores `~/.claude/construct/core/identity/USER.md` from backup, and `@~/.construct/identity/USER.md` resolves to a separate user file — you now have two USER.mds, one stale.
- V1 + V3 from the verify table are resolved. If `@~/`-includes don't work, the new reference in src/core/CLAUDE.md points at nothing.

**Manual prep (outside the commit, before staging):**
1. `cp ~/.claude/construct/core/identity/USER.md ~/.construct/identity/USER.md` — copy from the **live deployed copy**, not src. The src copy may be stale relative to the installed one.
2. Confirm `~/.construct/identity/USER.md` exists and content matches the original.

**The commit:**
3. `git rm src/core/identity/USER.md`
4. Add `src/core/identity/USER.md` to `.gitignore` (defense against future resurrection)
5. Change `src/core/CLAUDE.md:4` from `@identity/USER.md` to `@~/.construct/identity/USER.md` (or `@$HOME/.construct/...` per V1)

**Post-commit verification (before declaring done):**
6. Run `bun install.ts` — confirm `~/.claude/construct/core/identity/USER.md` is removed by cleanDst and `~/.construct/identity/USER.md` is untouched.
7. Start a fresh Claude Code session, run `/memory` — confirm `~/.construct/identity/USER.md` appears in the loaded chain.

### 3. SOUL/STYLE/AGENTS base + extend

Three sub-steps, one per file. Each is its own commit.

For each of AGENTS, SOUL, STYLE:

1. Walk the file, classify each line as "core to Construct's behavior" or "personal preference"
2. User manually populates `~/.construct/identity/<NAME>.override.md` with the personal lines (the "diff," not a copy of the base — full-copy locks the user out of future base updates per BMAD's documented anti-pattern)
3. Remove the personal lines from `src/core/identity/<NAME>.md`
4. Add `@~/.construct/identity/<NAME>.override.md` to `src/core/CLAUDE.md` (after the existing base @-includes)

The AGENTS.md walkthrough was done this session: extract lines 80 ("Don't ask 'shall I proceed?'"), 93-99 (Haiku/Sonnet/Opus model table), 109-112 (Daily rhythm), 131 ("Squash when merging"). SOUL and STYLE walkthroughs still pending — do them before the corresponding sub-step.

USER.md asymmetry: kept as bare `USER.md` (no `.override` suffix) since it has no repo base — it's primary, not an override.

### 4. ~~dist-plugin.ts author scrub~~

Moot. Plugin distribution dropped (see `docs/plans/publish-readiness.md` → "Distribution decision"). `dist-plugin.ts` and the `feat/plugin-packaging` branch are dead.

### 5. Test + doc drift fix

- `src/tests/install.test.ts:36` hardcodes `expectedIdentity = ["SOUL.md", "STYLE.md", "USER.md"]`. After step 2, USER.md is no longer in `src/core/identity/`, so this assertion either fails or needs updating to `["AGENTS.md", "SOUL.md", "STYLE.md"]`. Pick the latter — the test should pin the *new* shape, not the old.
- `src/tests/install.test.ts:131` asserts `claudeMd.includes("@construct/core/identity/AGENTS.md") || claudeMd.includes("@construct/core/CLAUDE.md")` — the OR clause masks step 2/3 breakage. Tighten to `&&` or replace with an explicit chain check that asserts each expected `@-include` line is present.
- Add a new test case: after install, `~/.claude/construct/core/identity/USER.md` does NOT exist, and `~/.construct/identity/USER.md` (if user populated it) is preserved.
- `src/core/INSTALL.md:10` and `src/core/README.md:16,27` reference USER.md at its old location. Update.

## Verification

Pre-checks (file-system level — necessary but not sufficient):

```bash
# 1. USER.md gone from repo, present in user dir
test ! -f src/core/identity/USER.md && test -f ~/.construct/identity/USER.md
echo "USER.md migrated"

# 2. install roundtrip preserves user-side files
bun install.ts && bun test.ts

# 3. install runs don't clobber the user's override files
diff -q ~/.construct/identity/USER.md <(echo "$KNOWN_CONTENT")
```

### Final gate: startup-load test

Files existing on disk and the install passing tests are not the same as the identity chain *actually loading into a session*. Before declaring this plan complete, prove the chain loads end-to-end.

**Setup.** In each user-side override file, drop a unique marker on a fresh line:

```bash
echo "STARTUP_LOAD_MARKER_USER_a1b2"   >> ~/.construct/identity/USER.md
echo "STARTUP_LOAD_MARKER_AGENTS_c3d4" >> ~/.construct/identity/AGENTS.override.md
echo "STARTUP_LOAD_MARKER_SOUL_e5f6"   >> ~/.construct/identity/SOUL.override.md
echo "STARTUP_LOAD_MARKER_STYLE_g7h8"  >> ~/.construct/identity/STYLE.override.md
```

**Test (non-interactive, repeatable):**

```bash
cd ~/construct
unset ANTHROPIC_API_KEY  # so OAuth keychain is used
claude -p "From your loaded CLAUDE.md chain, list every STARTUP_LOAD_MARKER_* string you see. One per line. Nothing else." \
  | tee /tmp/identity-load.out
```

**Assertion.** Output must contain all four markers:

```bash
for m in USER_a1b2 AGENTS_c3d4 SOUL_e5f6 STYLE_g7h8; do
  grep -q "STARTUP_LOAD_MARKER_$m" /tmp/identity-load.out || { echo "MISSING: $m"; exit 1; }
done
echo "all four override files loaded into session"
```

**Interactive companion (also confirm):** start a real `claude` session in `~/construct/`, run `/memory`, and verify each of the four `~/.construct/identity/*.md` paths appears in the loaded chain list. The non-interactive test above is the gate; this one catches the trust-prompt UX (V3) — first run will show the external-include approval dialog. Approve.

**Cleanup:** remove the marker lines from each override file once the test passes.

**What this catches that pre-checks don't:**

- `@~/`-include expansion silently failing (V1 regression — covered by V1 verify, but this re-confirms in production layout)
- Override files existing but Claude Code refusing to load them (V3 decline state stuck)
- Wrong `@-include` line in `src/core/CLAUDE.md` (typo, wrong path, missing `~/`)
- `discoverAllCapsMd` regression silently restoring an old USER.md to the deploy and shadowing the user-side one (this would show USER content but from the wrong location — verify the marker is from `~/.construct/identity/USER.md`, not the deploy copy, by `grep STARTUP_LOAD_MARKER ~/.claude/construct/core/identity/*.md` returning nothing)

## What this does NOT address

Tracked in `docs/plans/publish-readiness.md` — the single living checklist for everything else that must be scrubbed before publish. Highlights of what lives there:

- Other identity surfaces: `package.json`, `soul.json`, `codebase-auditor.md` paths, doc citations, comment usernames, test fixtures, `.claude/CLAUDE.md` workflow lines
- Port-number + Greenshot generalization
- Git history wipe (destructive, user-executed at publish time)
- Plugin-side override resolution (Phase 2 F-4)
- V3 trust-prompt documentation (resolved as one-time + reversible — needs README mention only)

Listed there, not here, so they don't get archived when this plan merges.
