# Personal data isolation

**v2** — replaces an earlier draft that was 5× this size. The earlier version invented a `~/.construct/contexts/<basename>/CONTEXT.md` loader, an `*.local.md` override mechanism, and a `USER.template.md` bootstrap — a red-team panel pointed out that (a) per-project context is what Claude Code's built-in `<cwd>/CLAUDE.md` already does, (b) no current consumer asked for overrides, and (c) USER.md relocation is one line of `@`-include change, not a hook. This version is what's actually needed.

**Why this is its own plan:** Plugin-packaging red-team finding F-1 (`docs/plans/plugin-packaging.md` on `feat/plugin-packaging`) flagged personal data in `src/`. The repo is public; the planned plugin distribution would re-publish it. Resolving this gates plugin work and unblocks linking the repo externally.

---

## 1. Leak inventory

`grep -rni "crsmi\|chris\|smith\|crsmithdev\|/home/\|~/construct\|pacific\|wsl\|windows 11" src/ package.json` — **no `-v` filters**. The earlier inventory filtered out `__tests__/` and `fixtures/`, which is exactly where some of the largest leaks live.

| Source | What leaks | Severity |
|---|---|---|
| `src/core/identity/USER.md` | full personal profile (name, email, OS, env, port preferences, tech stack, working style, git prefs) | high |
| `src/core/identity/soul.json` | `author.name`, `displayName`, `description`, `tags`, `category` — all personalized | high |
| `package.json` `author` field | `"name": "Chris Smith"` (and possibly email) | high |
| `src/telemetry/__tests__/fixtures/e2e/session*/*.jsonl` | committed JSONL transcripts — `cwd:"/home/crsmi/construct"`, real session UUIDs + slugs, real prompts Chris typed, real tool inputs/outputs | high |
| `src/agents/codebase-auditor.md:12,16` + `description:` frontmatter | hard-codes `/home/crsmi/construct/` AND names "Construct" in model-facing prose | medium |
| `src/skills/ss/SKILL.md` + `src/commands/ss.md` | hard-coded `~/.local/bin/latest-shot`, `~/shots/*.png` (Greenshot workflow) | medium |
| `src/commands/sketch.md` | `~/construct/docs/sketches/` user path in model-facing command | medium |
| `src/data/src/paths.ts:32` | `MEMORY_DB_PATH` defaults to `~/.local/share/mcp-memory/sqlite_vec.db` (encodes uv install layout) | medium |
| `src/memory/hooks/memory-extract-stop.ts:26-28` | `MEMORY_VENV_PYTHON` default encodes uv tool layout | medium |
| `src/rules/docs/RULES.md:68` | absolute path citation `/home/crsmi/construct/.claude/CLAUDE.md:18` | low |
| `src/ui/web/src/utils/format.ts:166-167` | comment examples: `"-home-crsmi-construct" → "crsmi/construct"` | low |
| `src/ui/api/src/routes/observability.ts:291` | same | low |
| `src/telemetry/__tests__/e2e.test.ts:212` | production test uses `"-home-crsmi-construct"` as literal | low |
| `.claude/CLAUDE.md` (project-local dev rules, committed) | encodes author's workflow, dev port assumptions, references `/home/crsmi/construct/.claude/CLAUDE.md:18` | low |

Counts (from red-team):
- 5 commits touch `src/core/identity/USER.md` (`d603b65`, `8684e50`, `1cbe4fd`, `c0e71d9`, `89bd480`) plus pre-rename history under `construct/core/identity/USER.md` (`b779f48`).
- Author email `crsmithdev@gmail.com` is in every commit's `git log --format='%ae'`.
- Test fixtures contain 764 grep hits for `crsmi` across 8 files.

**Counter-claim corrected:** the v1 plan asserted SOUL.md, STYLE.md, AGENTS.md were "already generic — no scrub needed." That's wrong. SOUL.md hard-codes "Construct" as the assistant's identity and codifies personal boundaries ("Health/medical reminders are suggestions"). STYLE.md is Chris's personal communication contract. AGENTS.md contains a `<SUBAGENT-STOP>` directive and the "1% rule" — Construct-specific harness wiring. These are author's preferences shipped as universal defaults. They aren't PII but they aren't neutral either — see §3 decision D1.

---

## 2. Approach

Three principles. Each replaces a heavier mechanism from v1.

1. **Move user-specific files outside the repo. Reference them with `@`-include.** No new loader. `src/core/CLAUDE.md` line 4 becomes `@~/.construct/identity/USER.md` (or absolute). Claude Code's `@`-include resolves it. No SessionStart hook, no `additionalContext` plumbing, no `~/.construct/identity/` schema.
2. **Per-codebase context: use `<cwd>/CLAUDE.md`.** Already a Claude Code built-in. Auto-loads, walks parents, no basename collisions, no convention to teach. The v1 `~/.construct/contexts/<basename>/` mechanism is removed entirely.
3. **History scrub is part of the plan, not "out of scope."** Scrubbing the working tree without scrubbing history is privacy theater — the email and USER.md content remain a `git log` away. Force-push to `main` is destructive and needs explicit go-ahead, but the steps are included rather than punted.

---

## 3. Decisions to resolve before P1 lands

| # | Question | Default | Why |
|---|---|---|---|
| **D1** | SOUL.md / STYLE.md / AGENTS.md — rewrite as actually-generic, or move to `examples/identity/` as opt-in? | **Move to `examples/identity/`** | Rewriting takes hours and arguably destroys the value (they ARE opinionated; that's the point). Moving them under `examples/` makes the bias explicit — a user opts in by `cp examples/identity/STYLE.md ~/.construct/identity/STYLE.md`. The repo ships with no default identity at all, which is the only honest "generic." |
| **D2** | Fixtures under `src/telemetry/__tests__/fixtures/` — redact `cwd`/`slug`/prompts, or accept the leak and move on? | **Redact in P1** | Fixtures get redistributed via `git clone`; redacting them costs an afternoon and removes a recurring source of "oh, his username is in this file too" findings. Accept means a future README rewrite still ships them. |
| **D3** | Git history scrub: do it now (force-push to main), or after every leak is fixed at tip? | **After P1 tip-clean**, scrub once. | Force-push rewrites every commit hash. Doing it incrementally invalidates every open branch repeatedly. Do it once after the working tree is clean. |

These are blocking — implementation diverges by choice.

---

## 4. Steps

Single phase, ~10 commits. P1-style numbering for clarity, not for sequencing into phases.

| # | Change | Files |
|---|---|---|
| 1 | Broaden the audit grep, run it, fix every hit | (audit script in commit message — no committed file) |
| 2 | Scrub `package.json` `author` field | `package.json` |
| 3 | Rewrite `soul.json` to schema-only (drop `name`, `displayName`, `description`, `tags`, `category`; fix the dead `IDENTITY.md` reference noted in red-team) | `src/core/identity/soul.json` |
| 4 | Parameterize `codebase-auditor.md` — scope from `$1` or cwd; rewrite `description:` frontmatter to not name "Construct" | `src/agents/codebase-auditor.md` |
| 5 | Make `rules/docs/RULES.md:68` citation relative | `src/rules/docs/RULES.md` |
| 6 | Sanitize comments in `format.ts` and `observability.ts` (use `acme/project` not `crsmi/construct` as the example transformation) | `src/ui/web/src/utils/format.ts`, `src/ui/api/src/routes/observability.ts` |
| 7 | Fix `src/telemetry/__tests__/e2e.test.ts:212` literal `-home-crsmi-construct` — use a fixture-derived value, not a hardcoded string | `src/telemetry/__tests__/e2e.test.ts` |
| 8 | Decide on D1; either rewrite SOUL/STYLE/AGENTS or `git mv` to `examples/identity/` and update `src/core/CLAUDE.md` @-includes accordingly | `src/core/identity/` or `examples/identity/`, `src/core/CLAUDE.md` |
| 9 | Decide on D2; if redact, walk every JSONL fixture and replace `cwd`, `slug`, prompt content, author email | `src/telemetry/__tests__/fixtures/` |
| 10 | `cp src/core/identity/USER.md ~/.construct/identity/USER.md` (manual, once). `git rm src/core/identity/USER.md`. Change `src/core/CLAUDE.md:4` from `@identity/USER.md` to `@~/.construct/identity/USER.md`. Add `src/core/identity/USER.md` to `.gitignore` so a future regression can't re-introduce it | `src/core/CLAUDE.md`, `.gitignore`, `src/core/identity/USER.md` (deletion) |
| 11 | Scrub user-tool path defaults: `src/data/src/paths.ts:32` and `src/memory/hooks/memory-extract-stop.ts:26-28` — default to a config-derived path or fail loudly without env var | `src/data/src/paths.ts`, `src/memory/hooks/memory-extract-stop.ts` |
| 12 | Hard-coded Greenshot workflow in `src/skills/ss/` and `src/commands/ss.md` — either parameterize via env (`CONSTRUCT_SCREENSHOT_DIR`) or move under `examples/skills/` as opt-in | `src/skills/ss/`, `src/commands/ss.md` |
| 13 | Scrub `.claude/CLAUDE.md` (project-local dev rules) — generic port numbers, generic paths, drop the `/home/crsmi/...` citation | `.claude/CLAUDE.md` |
| 14 | Hard-coded port numbers (3000/3001) in `src/commands/install.md`, `src/skills/code-test/`, `src/skills/design-review/references/verification.md` — pull from env or document as overridable | various |
| 15 | History scrub (D3): `git filter-repo --path src/core/identity/USER.md --invert-paths`; `.mailmap` rewrite for author email; `git push --force-with-lease origin main`. **User executes this; agent does not force-push.** | git history |

Steps 1–14 are non-destructive — feature branch, normal PR, normal merge. Step 15 is destructive and requires explicit user authorization (see §6).

---

## 5. Verification

The v1 verification grep filtered out `__tests__/` and `fixtures/`. v2 does not.

```bash
# Working tree sweep — should return empty
grep -rni "crsmi\|chris smith\|crsmithdev\|/home/crsmi\|~/construct" src/ package.json .claude/ \
  | grep -v "examples/identity/"   # opt-in surface; allowed if D1 picks "move"
```

```bash
# History sweep — after step 15
git log --all --source --remotes --pretty=format:'%H %an <%ae>' -- 'src/core/identity/USER.md'
# expected: empty
git log --all --format='%ae' | sort -u
# expected: anonymized email only
```

```bash
# Install roundtrip — USER.md still loaded via @-include
bun install.ts && cat ~/.claude/construct/core/CLAUDE.md | head -5
# expected: line 4 reads "@~/.construct/identity/USER.md"; ~/.construct/identity/USER.md exists and contains the moved content
```

```bash
# Per-codebase context — verify Claude Code's built-in works
# (Trivial: create ./CLAUDE.md in any project dir; start Claude Code; it loads.)
```

```bash
# Plugin packaging — after this lands, switch to plugin worktree and re-run
cd ../plugin && bun dist-plugin.ts && claude plugin validate dist/plugin
# expected: validate passes; dist/plugin/core/identity/ has no USER.md
```

---

## 6. What this STILL does not solve

Naming the gaps the red-team surfaced, so this plan doesn't pretend to do more than it does.

- **Commit author/committer is permanent metadata.** `.mailmap` rewrites display in `git log`, but the underlying `author/committer` bytes in the commit objects stay. Anyone with write access to the bare repo or a careful inspection sees the original. Only fix is filter-repo, which is destructive — covered in step 15.
- **GitHub UI caches commit author, blame, and Issues/PRs** that referenced personal data. Even after force-push, GitHub's edge cache (and any fork/clone made before the rewrite) retains it. The plan cannot fix this; the user should consider whether the GitHub history is worth preserving at all (alternative: new repo, clean history, archive the old one private).
- **Backups under `~/.construct/backups/`** captured pre-migration sessions with personal context. These are user-local, never committed — but if the user shares a debug bundle for a bug report, the PII rides along. Out of scope.
- **Memory MCP storage at `~/.local/share/mcp-memory/sqlite_vec.db`** contains the user's memory entries verbatim. Not in the repo, not on the path to becoming so, but a separate privacy surface to be aware of.

If the goal is "this repo + clone history is acceptable to link from a resume," steps 1–15 are sufficient. If the goal is "every trace of authorship is gone," that's a bigger conversation and probably warrants a new repo rather than rewriting this one.

---

## 7. What this unblocks

- **Plugin packaging** (`docs/plans/plugin-packaging.md`) — F-1 cleared.
- **Phase 1 of `construct-public-face.md`** — README rewrite + SPEC.md + demo can land without re-publishing PII.
- **Per-codebase context** — already works via `<cwd>/CLAUDE.md`; no new infrastructure needed. The user puts notes for `~/some-other-repo/` in `~/some-other-repo/CLAUDE.md` and Claude Code loads them when launched from that cwd.

---

## 8. Open coordination

This plan and the plugin-packaging branch (`feat/plugin-packaging`) cross-depend:
- This must land first (F-1 gate).
- Plugin's `dist-plugin.ts` ships `src/core/identity/` verbatim — after step 10, the builder produces a plugin with no USER.md (correct). Re-validate plugin output after this plan lands.
- If D1 picks "move to `examples/identity/`," `dist-plugin.ts` should also skip `examples/`. Add to SKIP_DIRS.
