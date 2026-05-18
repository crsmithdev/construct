# Construct: going public

One plan for everything required to take this repo from "personal substrate" to "a link a stranger can open without context."

Synthesizes two source sketches in `~/.construct/sketches/`:
- `construct-as-portfolio-showcase.md` — how the repo reads to a senior engineer arriving from a link (the *perception* layer)
- `construct-as-a-product.md` — how Construct gets installed by someone who isn't the author (the *distribution* layer)

Plus the work already done this session:
- Plugin-packaging research, mapping, and skeleton (on branch `feat/plugin-packaging`)
- Personal-data isolation design (this branch — now folded in below as Phase 1.3)
- Two rounds of red-team across both pieces

---

## Sequencing

```
Phase 0  ────►  Phase 1  ────►  Phase 2  ────►  Phase 3
                   │                │
                   └──► Phase 4 (gated on Phase 0.3 audit)
```

| Phase | What | Effort | Blocking? |
|---|---|---|---|
| 0 — Positioning + audit | 4 decisions, no code | 1–2 days | Yes — cascades into all downstream phases |
| 1 — Public-ready repo | README, SPEC, personal-data scrub, demo, code-quality signals | ~1 week | Yes for ship; phases 2-4 only land after this |
| 2 — Plugin packaging | Claude Code plugin + marketplace | ~1 week | No — independent of 3 and 4 |
| 3 — Menubar shell | Tauri wrapper around `src/ui` | ~1 month | No — optional |
| 4 — Public deploy | Live read-only instance or static export | 2–5 days | Gated on Phase 0.3 |

**Minimum viable shippable slice:** Phase 0 + Phase 1. ~1 week, no infra, repo-link-ready.

---

## Phase 0 — Positioning + audit (1–2 days)

Decisions that block downstream work. None require code changes. Output: a one-page `docs/positioning.md` capturing the four decisions so Phase 1 doesn't relitigate them.

| # | Decision | Default | Why it matters |
|---|---|---|---|
| 0.1 | Positioning label | TBD — pick from: "Claude Code infrastructure", "personal AI substrate", "agentic development substrate" | Drives README headline + marketplace listing + search discoverability |
| 0.2 | SPEC.md shape: one file or per-module | Per-module (`docs/spec/<module>.md`) | Per-module = lower drift cost; monolithic = more impressive standalone artifact |
| 0.3 | Privacy audit of `src/ui` routes | Walk every route, list data exposure | Gates Phase 4 entirely; nothing public ships without this |
| 0.4 | Distribution lead: plugin (Phase 2) or menubar (Phase 3) | Plugin | Faster + cheaper to maintain; menubar is more visceral but month-long |

---

## Phase 1 — Public-ready repo (~1 week)

Everything required before the repo can be linked from a resume or blog. Independent of Phases 2–4.

### 1.1 README rewrite

Current `README.md` is install-first (271 lines, leading with `bun install.ts`). Target shape:

```
# Construct

One paragraph: what problem, who has it, what this does about it.

## What's interesting here
- Hook architecture: <one line on why it's designed that way>
- Skill router: <one line on the classification model>
- Eval harness: falsifiable quality bar, not vibes
- Research engine: branching loops with budgeted exploration
- Verify gate: structured proof-of-work before any "done" claim

## Structure
Annotated directory map — each module gets one line on what and why.

## Running it
One block, three commands. Detail in INSTALL.md.
```

The "What's interesting here" section is the portfolio signal. Each bullet names a real file or two. The reader's question is "did the author understand what they were building" — bullets that say *why* a design decision was made answer it.

**Touch files:** `README.md` (rewrite), `INSTALL.md` (extend with anything README sheds).

### 1.2 SPEC.md

Behavior-oriented spec is a portfolio artifact on its own — proves the system was thought about as a system. Currently absent. Must cover:

- Every hook: trigger event, input contract (stdin JSON shape), output contract, error behavior
- Every skill: trigger keywords, what it does, what it explicitly doesn't
- Eval targets and pass/fail criteria
- Verify gate contract (the `[verify]` block schema)

Per 0.2 decision, lands as one file or per-module. Phase 1 generates content either way.

**Touch files:** `SPEC.md` or `docs/spec/*.md`. Drives content from `src/core/hooks/settings-hooks.json`, `src/skills/skill-rules.json`, `src/eval/`.

### 1.3 Personal-data scrub

The minimum required to make the repo safe to link. The earlier draft of this plan ran 15 steps; the red-team showed most of it was either scope creep (publish-readiness, not privacy per se) or rendered moot by the history wipe at step 4 below. The right-shaped version is below.

**Why this matters:** repo is on a public remote; ship-state currently leaks the author's name, email, env, hard-coded paths. Plugin distribution (Phase 2) would re-publish all of it.

**Leak inventory** (`grep -rni "crsmi\|chris\|smith\|crsmithdev\|/home/\|~/construct\|pacific\|wsl\|windows 11" src/ package.json`):

| Source | Severity |
|---|---|
| `src/core/identity/USER.md` — full personal profile | high |
| `src/core/identity/soul.json` — `author.name`, `displayName`, `description`, `tags`, `category` | high |
| `package.json` — `author` field | high |
| `src/telemetry/__tests__/fixtures/e2e/session*/*.jsonl` — real session transcripts with `cwd`, slugs, prompts, tool I/O | high |
| `src/agents/codebase-auditor.md:12,16` — model-facing hard-coded path | medium |
| `src/data/src/paths.ts:32` + `src/memory/hooks/memory-extract-stop.ts:26-28` — user-tool layouts (uv, mcp-memory) | medium |
| `src/skills/ss/`, `src/commands/{ss,sketch,install}.md` — Greenshot workflow, `~/construct/` paths, port 3000/3001 | medium |
| `src/rules/docs/RULES.md:68` — absolute path citation | low |
| `src/ui/web/src/utils/format.ts:166-167`, `src/ui/api/src/routes/observability.ts:291` — username in code-comment examples | low |
| `src/telemetry/__tests__/e2e.test.ts:212` — literal `-home-crsmi-construct` | low |
| `.claude/CLAUDE.md` — committed dev-only file, author workflow + path citations | low |

**Steps** (in order):

1. **Verify `@`-include behavior on `~/`.** 5-minute test: drop a CLAUDE.md with `@~/foo.md` and confirm Claude Code expands the tilde. If not, `install.ts` will need to rewrite `~/` → `$HOME` at install time. Docs show `@~/.claude/my-project-instructions.md` as an example, so likely works.

2. **Modify `install.ts` preserve list** to NOT auto-restore identity files. Red-team finding F-1 (round 2): `discoverAllCapsMd` at `install.ts:82` matches `/^[A-Z_]+$/` and preserves USER/SOUL/STYLE/AGENTS across installs. After we trim them in step 5, the preserve cycle silently undoes the trim. Drop identity-file preservation OR allowlist only files that still exist in `src/`.

3. **Modify `install.ts` to create `~/.construct/identity/`.** Add to the mkdir block at `install.ts:263-267`. Without this, the manual `cp` in step 4 fails ENOENT on any clean machine.

4. **Move USER.md out of the repo.** `cp src/core/identity/USER.md ~/.construct/identity/USER.md` (manual, once, by the user). Then in one atomic commit: `git rm src/core/identity/USER.md`, `.gitignore src/core/identity/USER.md` (defense against resurrection), change `src/core/CLAUDE.md:4` from `@identity/USER.md` to `@~/.construct/identity/USER.md`.

5. **Extract personal lines from SOUL/STYLE/AGENTS via the base + extend pattern.** Repo ships full base versions minus the personal bits. User-side override files at `~/.construct/identity/{AGENTS,SOUL,STYLE}.override.md` are SHORT (just the diff). `src/core/CLAUDE.md` chains the includes — bases first, overrides append.

   The `.override.md` suffix matches the AGENTS.md ecosystem spec; USER.md stays bare-named since it has no repo base. Override discipline: the user file is the diff, not a copy (BMAD's documented anti-pattern: full-copy locks the user out of future base updates).

   From the AGENTS.md walkthrough done this session, 4 lines extract: "Don't ask 'shall I proceed?'" (line 80), Haiku/Sonnet/Opus model table (lines 93–99), Daily rhythm (lines 109–112), "Squash when merging" (line 131). SOUL.md and STYLE.md need their own walkthroughs to identify extracts.

6. **Scrub the remaining leaks at tip.** `package.json` author; `soul.json` (drop everything but schema/version); `codebase-auditor.md` (parameterize scope to cwd/`$1`); `rules/docs/RULES.md:68` (make citation relative); comments in `format.ts` and `observability.ts`; `e2e.test.ts:212`. These are needed at tip even with history wipe because the published repo's working tree must be clean.

7. **Fixture redaction.** `src/telemetry/__tests__/fixtures/e2e/session*/*.jsonl` contain author username in `cwd`, slugs, prompts, tool outputs. Redact in place — replace identifiers with neutral placeholders. Alternative: regenerate fixtures from a sanitized session.

8. **History wipe at publish time.** User confirmed history is disposable. Two options, user picks:
   - **(a) Surgical:** `git filter-repo --path src/core/identity/USER.md --invert-paths` + `.mailmap` for email + force-push. Keeps structure. **Caveat:** `.mailmap` is a presentation filter, not a rewrite — `git cat-file -p <sha>` still shows the original email. Co-authored-by trailers in commit bodies are NOT rewritten.
   - **(b) Nuclear:** new orphan branch, squash everything to one commit, anonymize author, reset main, force-push. Single commit, all metadata gone, including co-author trailers. Actually addresses the email leak at the byte level.

   The user executes this — agent does not force-push. Step 8 invalidates all open branches (`feat/plugin-packaging`, `docs/public-face-plan`) — each needs `git rebase --onto <new-main>` before merging.

**Verification:**

```bash
# Working tree sweep — should return empty
grep -rni "crsmi\|chris smith\|crsmithdev\|/home/crsmi\|~/construct" src/ package.json .claude/

# @-include actually resolves the override
# Inside a fresh Claude Code session: /memory should list ~/.construct/identity/USER.md

# Plugin builder produces clean output (after Phase 2 is in scope)
cd .worktrees/plugin && bun dist-plugin.ts && claude plugin validate dist/plugin
# expected: passes; no USER.md in dist/plugin/core/identity/
```

**What this still doesn't solve:** `~/.construct/backups/` (user-local, never in repo) + `~/.local/share/mcp-memory/sqlite_vec.db` (user-local). Both stay user-local; awareness only.

### 1.4 Code-quality signals visible to a scanner

A senior engineer's repo scan is fast and pattern-based. Make the patterns visible:

- CI badge at top of README (badge for `bun test.ts` on `main`)
- One-line eval-harness summary in README (pass rate, last-run date) — pull from `src/eval/` output
- Git log audit after step 8: ensure rebased/squashed history is clean and readable
- `bun test.ts` output referenced in the README's "What's interesting here" → "eval harness" bullet

### 1.5 Demo recording

90 seconds, no narration, timestamped captions only. One scenario, not three. Strongest candidate: **the verify gate blocking a Stop and the agent recovering** — visual, novel, shows the system thinking. Alternative: a skill route classify → dispatch → execute trace.

Host: GitHub-hosted MP4 in README (no external dependency, no link rot).

---

## Phase 2 — Claude Code plugin packaging (~1 week)

**Status:** research + skeleton built on `feat/plugin-packaging` branch. Full implementation reference at `docs/plans/plugin-packaging.md` on that branch.

**What's done:**
- Plugin format reference (manifest, layout, hook config, MCP config, namespacing rules)
- Component mapping (17 skills, 7 agents, 16 commands, 19 hooks, 1 MCP server)
- `dist-plugin.ts` builder generates `dist/plugin/` from `src/`
- Validates with `claude plugin validate`; smoke-tested 3/19 hooks

**Open issues from red-team that need closing before this phase ships:**

| # | Issue | Where to fix |
|---|---|---|
| F-1 | `${CLAUDE_PLUGIN_ROOT}` in `.mcp.json` `args[]` — confirmed supported by spec (was filed as open question Q1) | Update plan; no code change |
| F-2 | MCP server (`src/goals/mcp/`) imports `@construct/data` workspace dep — pre-bundle `node_modules` in builder | `dist-plugin.ts` |
| F-3 | `src/data/src/paths.ts:5-7` hard-codes `~/.claude/construct/` paths used by 17 files — break inside plugin cache | `src/data/src/paths.ts` (env-derive paths) |
| F-4 | 5 of 7 agents instruct model to `Read ~/.claude/construct/skills/<X>/SKILL.md` — ENOENT in plugin install | `src/agents/*.md` (parameterize) |
| F-5 | Skill router substring match: `/construct:git` doesn't contain `/git` substring; ~40 skill-rules patterns starting with `/` become unreachable | `src/core/hooks/routing-classify-submit.ts` (strip namespace prefix before matching) |

**Marketplace:** same repo, `.claude-plugin/marketplace.json`, plugin source = `"./plugin"` (corrected from earlier "own marketplace repo" assumption — verified against `code.claude.com/docs/en/plugin-marketplaces`).

**User-data init (Phase 2.5 from original):** addressed by Phase 1.3 above — `~/.construct/identity/` is created by `install.ts`, and the same mkdir block can also cover the plugin install scenario via a postinstall hook or `SessionStart` bootstrap.

**UI:** does not ship in the plugin (no plugin slot for a Fastify+systemd daemon). Stays a separate `bun install.ts` path until Phase 3 replaces it.

---

## Phase 3 — Menubar shell (~1 month, optional)

Largest investment. Highest "feels like a product" payoff but lowest portfolio-pure ROI. Defer until Phase 2 has landed and the plugin has external users. Skip entirely if Phase 0.4 picks plugin as the lead.

### 3.1 Scaffolding

- Tauri 2.x app wrapping `src/ui/web` verbatim — no React rewrite
- Bun backend runs as a sidecar — external dep first, document `bun` as prereq, revisit packaging if friction warrants
- Bundle target: macOS first (largest Claude Code power-user audience), Linux `.deb` second, Windows last

### 3.2 Native affordances

- OS notifications on long-running task completion (research loop done, verify gate fired)
- Global hotkey to open the UI
- Tray icon with status (active loops, recent completions)
- Auto-update via Tauri updater + GitHub releases

### 3.3 Systemd story

If menubar hosts the backend, the systemd unit from `install.ts` becomes redundant for menubar users. Document both paths; don't force migration. Headless WSL2 / server users keep systemd; menubar users get a single binary.

---

## Phase 4 — Public deploy (optional, gated on Phase 0.3)

Gated on the privacy audit. If the UI exposes data the author wouldn't want public, fix that first.

Two options:

1. **GitHub Pages static export of a sample session.** No backend. Captures the visual story without running anything. Cheap, link-stable.
2. **Live read-only instance at `construct.crsmi.dev`.** Higher signal — proves the system runs in production. Requires hosting, scrubbed sample data, no auth surface, no user data leakage. Re-deploy on every push to `main`.

Default: skip both until Phase 1 ships and feedback indicates otherwise.

---

## Open questions (consolidated)

| # | Question | Default |
|---|---|---|
| Q1 | Positioning label? | TBD (Phase 0.1) |
| Q2 | SPEC.md: one file or per-module? | Per-module |
| Q3 | Demo hosting: GitHub MP4, YouTube unlisted, Loom? | GitHub MP4 |
| Q4 | Personal domain + landing page, or polished GitHub repo enough? | Polished repo first |
| Q5 | Marketplace: own repo or submit to `anthropics/claude-plugins-official`? | Own repo first (corrected: same repo as plugin source) |
| Q6 | Tauri sidecar Bun packaging vs external dependency? | External dep first |
| Q7 | Systemd survival once menubar exists? | Both supported, no forced migration |
| Q8 | History scrub: filter-repo (a) or orphan nuke (b)? | (b) — only option that actually removes email from commit objects |
| Q9 | SOUL/STYLE walkthroughs (analogous to the AGENTS.md walkthrough done this session) | Land before Phase 1.3 step 5 |

---

## What's already done this session

For context — work that has landed on branches but not main:

| Branch | State | What's there |
|---|---|---|
| `docs/public-face-plan` | original v1 of this plan | superseded by this doc |
| `feat/plugin-packaging` | skeleton + 5 commits | `dist-plugin.ts`, plugin-packaging.md, MCP config; pending the F-1 through F-5 fixes above |
| `feat/personal-data-isolation` | this branch | Phase 1.3 work-in-progress; this consolidated plan |

When this consolidated plan lands on main, `docs/public-face-plan` can be deleted (already merged in content). `feat/plugin-packaging` rebases onto post-Phase-1 main once Phase 1.3 ships.
