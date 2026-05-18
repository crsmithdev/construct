# Personal data isolation

**Why this is its own plan:** Red-team finding F-1 against `docs/plans/plugin-packaging.md` flagged six files in `src/` that ship author-identifying data (names, emails, hard-coded `/home/crsmi/` paths). The repo is on a public GitHub remote and the planned plugin distribution makes it worse — every external user would receive Chris's identity verbatim, plus model-facing instructions hard-coded to his filesystem.

This is gating both the plugin-packaging work and any further public-facing artifact. Resolving it cleanly also fixes a long-standing problem with the existing `bun install.ts` install path: Construct's identity layer is currently tangled together with its behavioral defaults, making it impossible to ship one without leaking the other.

**Out of scope:** rewriting git history. PII already in past commits stays there unless the user separately runs `git filter-repo` after this plan lands. That's a one-line follow-up, not part of the structural fix.

---

## 1. Leak inventory

Verified by `grep -rln "crsmi\|Chris Smith\|crsmithdev\|/home/crsmi" src/` on `main` at commit `2455bd3`.

| File | What leaks | Severity | Surface |
|---|---|---|---|
| `src/core/identity/USER.md` | full personal profile — name, email, env, project context, working/comm prefs, git prefs | high | loaded into every Construct session via `@`-include |
| `src/core/identity/soul.json` | `"name": "Chris Smith"` field | high | metadata file, shipped intact |
| `src/agents/codebase-auditor.md:12,16` | hard-codes `/home/crsmi/construct/src/` as audit scope and `/home/crsmi/construct` as working directory | medium | **model-facing instruction** — agent will literally try to operate against that path |
| `src/rules/docs/RULES.md:68` | absolute path citation `/home/crsmi/construct/.claude/CLAUDE.md:18` | low | rule provenance citation |
| `src/ui/web/src/utils/format.ts:166` | inline comment shows `"-home-crsmi-construct" → "crsmi/construct"` as transformation example | low | code comment |
| `src/ui/api/src/routes/observability.ts:291` | same pattern in a comment | low | code comment |

The two `low` items are docstring examples — they exist because Chris's username is the natural fixture for explaining what a session-dir-name transformer does. Worth scrubbing, not load-bearing.

---

## 2. Proposed structure

Extend the existing `~/.construct/` user-data convention to cover identity and codebase-specific context.

```
~/.construct/
├── identity/
│   ├── USER.md                  # personal profile (was in repo)
│   ├── SOUL.local.md            # optional override of repo default
│   ├── STYLE.local.md           # optional override of repo default
│   └── AGENTS.local.md          # optional override of repo default
├── contexts/
│   ├── construct/CONTEXT.md     # auto-load when cwd basename matches
│   ├── some-other-repo/CONTEXT.md
│   └── ...
└── (existing: construct.db, sessions/, signals/, memory/, backups/)
```

**Repo ships only:**

| File | What it contains |
|---|---|
| `src/core/identity/SOUL.md` | generic behavior philosophy (already generic — no scrub needed) |
| `src/core/identity/STYLE.md` | generic communication style (already generic — no scrub needed) |
| `src/core/identity/AGENTS.md` | generic workflow rules (already generic — no scrub needed) |
| `src/core/identity/USER.template.md` | sanitized placeholders (`Name: <your name>`, etc.) |
| `src/core/identity/soul.json` | schema/version only — no `name` field |

`src/core/identity/USER.md` removed. The four currently shipped identity files are kept as defaults; what changes is that `USER.md` becomes user-provided rather than repo-provided, and the other three become user-overridable.

---

## 3. Loader

A single hook reads from `~/.construct/identity/` and `~/.construct/contexts/` and emits the concatenated content as `additionalContext` on `SessionStart`. Works identically for both install paths:

- `bun install.ts` install — hook fires from `~/.claude/settings.json` `hooks.SessionStart`
- Plugin install — hook fires from plugin `hooks/hooks.json` `SessionStart`

Read order (each step optional, missing files skipped silently):

1. Repo defaults from `${ROOT}/core/identity/{SOUL,STYLE,AGENTS}.md` — where `${ROOT}` is `~/.claude/construct/` for dev install, `${CLAUDE_PLUGIN_ROOT}/` for plugin
2. User overrides from `~/.construct/identity/{SOUL,STYLE,AGENTS}.local.md` — each one *replaces* the corresponding default (decision O2)
3. User profile from `~/.construct/identity/USER.md`
4. Codebase context from `~/.construct/contexts/<basename(cwd)>/CONTEXT.md`

If `~/.construct/identity/` is empty (fresh user, never set up), the loader emits just the repo defaults. Construct still functions; the personal profile is just absent.

**Implementation note:** the existing `src/memory/hooks/context-restore-start.ts` already runs on SessionStart. The identity loader can extend it rather than adding a second hook. One hook, one read pass, one `additionalContext` emission.

---

## 4. Migration

For the only currently affected user (Chris) — the existing `bun install.ts` install has `src/core/identity/USER.md` deployed at `~/.claude/construct/core/identity/USER.md`. The migration is one-time:

1. `install.ts` on next run: if `~/.construct/identity/USER.md` doesn't exist AND `~/.claude/construct/core/identity/USER.md` does, `cp` the latter to the former, then proceed normally.
2. After that run, the repo's `src/core/identity/USER.md` is deleted in a separate commit (so the migration step has something to copy *from* during the transition).
3. Subsequent installs are no-ops on this path.

For new users (post-scrub): `install.ts` creates `~/.construct/identity/` and copies `USER.template.md` to `~/.construct/identity/USER.md` if and only if no file exists there. User fills it in.

**Git history:** PII in past commits is unaffected by this restructure. If history scrub matters:

```bash
git filter-repo --path src/core/identity/USER.md --invert-paths
git filter-repo --replace-text <(echo 'crsmi==>USER')
git push --force-with-lease
```

Treat as a separate decision after this plan lands. Force-push to `main` is destructive and needs explicit go-ahead.

---

## 5. Phases

| Phase | What lands | Verification |
|---|---|---|
| **P1 — Repo scrub** (no behavior change) | Remove `name` from `soul.json`; parameterize `codebase-auditor.md` scope (default to cwd or first arg); make `rules/docs/RULES.md` citation relative; sanitize comments in `format.ts` + `observability.ts` | `grep -rln "crsmi\|Chris Smith\|crsmithdev\|/home/crsmi" src/` returns only `src/core/identity/USER.md` (handled in P3) |
| **P2 — Loader + override mechanism** | Extend `context-restore-start.ts` (or add a dedicated hook) to read `~/.construct/identity/` + `~/.construct/contexts/<basename(cwd)>/`. Add `~/.construct/identity/` + `~/.construct/contexts/` dir creation to `install.ts` | Fresh Claude Code session shows SOUL/STYLE/AGENTS injected from defaults; a populated `~/.construct/identity/STYLE.local.md` replaces the default |
| **P3 — USER.md migration** | Add `USER.template.md`. `install.ts` migrates existing `~/.claude/construct/core/identity/USER.md` → `~/.construct/identity/USER.md` if absent. Remove `src/core/identity/USER.md` from repo. Update `src/core/CLAUDE.md` to drop the `@USER.md` `@`-include — the loader handles it now | After install: `~/.construct/identity/USER.md` exists with current contents; repo has no `USER.md`; session still has personal profile in context |
| **P4 — Verification gate** | Full leak sweep + both install paths exercised | `grep -rln "crsmi\|Chris Smith\|crsmithdev\|/home/crsmi" src/` returns no hits; `bun test.ts` passes; `claude plugin validate dist/plugin` passes (in the plugin worktree) |

P1 is non-breaking and can land first. P2 + P3 are the structural change and should land together (otherwise USER.md is missing from sessions between commits). P4 is the gate.

---

## 6. Open design choices

These are the three questions the previous turn raised. Recommended defaults below; the implementation will use these unless redirected.

| # | Choice | Default | Rationale |
|---|---|---|---|
| **O1** | Codebase-context matcher: `basename(cwd)`, full-path slug, or both? | **basename(cwd)** | Simple. Collides only if two repos share a name (rare). Full-path slug breaks if the repo moves. |
| **O2** | `*.local.md` semantics: override (replace) or append? | **override** | The user is opting into "my version, not yours." Append is more flexible but the user has to remember what they're adding to. |
| **O3** | Existing `USER.md` migration: `install.ts` bootstrap, manual move, or in-repo sanitize? | **`install.ts` bootstrap** | Zero-touch for the existing dev install. One-time copy-then-delete. The other two require coordinated manual steps. |

---

## 7. What this unblocks

After P4 ships:

- Plugin packaging (Phase 2 of `construct-public-face.md`) can resume — the fatal F-1 finding is resolved
- The repo is safe to link from a resume / blog / GitHub Pages
- Phase 1 of `construct-public-face.md` (README rewrite) becomes safer to land publicly
- Future codebase-specific notes (working in `~/some-other-repo/`) work for free via the contexts mechanism

---

## 8. Verification

Leak sweep:

```bash
grep -rln "crsmi\|Chris Smith\|crsmithdev\|/home/crsmi" src/ | grep -v __tests__ | grep -v fixtures
# expected: empty
```

Loader smoke test (after P2):

```bash
# Fresh-ish ~/.construct/ with no identity dir
rm -rf /tmp/test-construct && CONSTRUCT_DATA_ROOT=/tmp/test-construct \
  bun src/memory/hooks/context-restore-start.ts <<<'{"session_id":"test","cwd":"/tmp"}'
# expected: emits SOUL+STYLE+AGENTS, no USER, no CONTEXT

# With a populated identity dir
mkdir -p /tmp/test-construct/identity
echo "Name: Test User" > /tmp/test-construct/identity/USER.md
CONSTRUCT_DATA_ROOT=/tmp/test-construct \
  bun src/memory/hooks/context-restore-start.ts <<<'{"session_id":"test","cwd":"/tmp"}'
# expected: emits SOUL+STYLE+AGENTS+USER
```

Install roundtrip (after P3):

```bash
bun install.ts && bun test.ts
# expected: USER.md migrated to ~/.construct/identity/, src/core/identity/USER.md absent, all tests pass
```

Plugin validate (after P3, in the plugin worktree):

```bash
bun dist-plugin.ts && claude plugin validate dist/plugin
# expected: passes; no USER.md in dist/plugin/core/identity/
```
