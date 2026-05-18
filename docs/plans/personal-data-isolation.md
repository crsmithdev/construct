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
3. **History gets wiped before public release.** The user has confirmed git history is disposable. Working-tree cleanup happens first (so the eventual published state has no PII at tip), then history is nuked in a single step before going public. This removes the "privacy theater" concern from the v1 plan — there will be no history left to leak from.

---

## 3. Decisions to resolve before P1 lands

| # | Question | Default | Why |
|---|---|---|---|
| **D1** | SOUL.md / STYLE.md / AGENTS.md — what ships in the repo? | **Base + extend** | Repo ships full base versions (real working content, minus personal bits). User files at `~/.construct/identity/{SOUL,STYLE,AGENTS}.md` are SHORT — just the diff from base. `src/core/CLAUDE.md` chains the @-includes: base loads first, user override appends. Fresh install gets a fully-functional baseline; the author's overrides are small and clearly scoped. AGENTS.md analysis (from session walkthrough): the four personal lines to extract are "Don't ask 'shall I proceed?'" (line 80), the Haiku/Sonnet/Opus model table (lines 93-99 — keep the principle, move the specific allocation), Daily rhythm (lines 109-112), and "Squash when merging" (line 131). SOUL.md and STYLE.md need their own walkthroughs to identify the extract list. **Open sub-question:** does Claude Code's @-include expand `~/`? If not, `install.ts` rewrites `~/` → `$HOME` at install time. |
| **D2** | Fixtures under `src/telemetry/__tests__/fixtures/` — redact `cwd`/`slug`/prompts, or accept the leak and move on? | **Redact in P1** | Fixtures get redistributed via `git clone` from the wiped-and-republished repo; redacting them costs an afternoon and removes a recurring source of "oh, his username is in this file too" findings. Accept means a future README rewrite still ships them. |

These are blocking — implementation diverges by choice. (History-scrub timing question from v1 is removed; user confirmed history will be wiped before publication.)

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
| 8 | Per D1: extract personal lines from SOUL/STYLE/AGENTS (keep the rest as the base). Add three more @-includes to `src/core/CLAUDE.md` pointing at `~/.construct/identity/{SOUL,STYLE,AGENTS}.md`. Verify @-include `~/` expansion; if not supported, add path-rewrite to `install.ts`. Place the extracted personal content into `~/.construct/identity/{SOUL,STYLE,AGENTS}.md` so the user's override loads. Must land atomically (same commit removes from base AND adds chain include) or the override file must exist before the base is trimmed. | `src/core/identity/SOUL.md`, `STYLE.md`, `AGENTS.md`, `src/core/CLAUDE.md`, possibly `install.ts` |
| 9 | Decide on D2; if redact, walk every JSONL fixture and replace `cwd`, `slug`, prompt content, author email | `src/telemetry/__tests__/fixtures/` |
| 10 | `cp src/core/identity/USER.md ~/.construct/identity/USER.md` (manual, once). `git rm src/core/identity/USER.md`. Change `src/core/CLAUDE.md:4` from `@identity/USER.md` to `@~/.construct/identity/USER.md`. Add `src/core/identity/USER.md` to `.gitignore` so a future regression can't re-introduce it | `src/core/CLAUDE.md`, `.gitignore`, `src/core/identity/USER.md` (deletion) |
| 11 | Scrub user-tool path defaults: `src/data/src/paths.ts:32` and `src/memory/hooks/memory-extract-stop.ts:26-28` — default to a config-derived path or fail loudly without env var | `src/data/src/paths.ts`, `src/memory/hooks/memory-extract-stop.ts` |
| 12 | Hard-coded Greenshot workflow in `src/skills/ss/` and `src/commands/ss.md` — either parameterize via env (`CONSTRUCT_SCREENSHOT_DIR`) or move under `examples/skills/` as opt-in | `src/skills/ss/`, `src/commands/ss.md` |
| 13 | Scrub `.claude/CLAUDE.md` (project-local dev rules) — generic port numbers, generic paths, drop the `/home/crsmi/...` citation | `.claude/CLAUDE.md` |
| 14 | Hard-coded port numbers (3000/3001) in `src/commands/install.md`, `src/skills/code-test/`, `src/skills/design-review/references/verification.md` — pull from env or document as overridable | various |
| 15 | Wipe history once tip is clean. Two options, user picks at publish time: (a) `git filter-repo --path src/core/identity/USER.md --invert-paths` + `.mailmap` for email + force-push (keeps commit structure, scrubs specific things). (b) Nuclear: new orphan branch with one squashed commit, reset main to it, force-push (no history at all). Option (b) is simpler and addresses every metadata leak (author, committer, co-authored-by, all prior content). **User executes this; agent does not force-push.** | git history |

Steps 1–14 are non-destructive — feature branch, normal PR, normal merge. Step 15 is destructive but explicitly authorized in principle — execution still requires the user's go-ahead at publish time.

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
git log --all --format='%H %an <%ae>' | head
# expected (option a): no commits touching USER.md, .mailmap-rewritten email only
# expected (option b): single commit, anonymized author/email
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

After steps 1–15 the repo content and git history are clean. Two surfaces remain, both user-local and never in the repo:

- **`~/.construct/backups/`** — captured pre-migration sessions with personal context. If the user shares a debug bundle for a bug report, the PII rides along.
- **`~/.local/share/mcp-memory/sqlite_vec.db`** — memory MCP storage contains memory entries verbatim.

Neither is on the path to becoming public; just worth being aware of. If a clone of the repo is made *before* step 15 fires (e.g., a fork, a GitHub Actions cache snapshot), that clone retains the pre-scrub state. Step 15 should fire close in time to the first public link.

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
