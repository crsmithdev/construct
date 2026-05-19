# Construct

Claude Code-native personal AI infrastructure. Skills, hooks, agents, an autonomous research engine, persistent memory, goal/todo tracking, and an observability UI — all running locally inside your Claude Code environment.

**Install target:** `~/.claude/construct/` · **User data:** `~/.construct/` (preserved across upgrades) · **DB:** `~/.construct/construct.db`

---

## What you get

- **~19 polished skills** — code review, design review, docs review, agent review, debugging, planning, sketching, interview, red-team, git workflow, audit orchestration, and more (`src/skills/`).
- **~19 hooks** wired into Claude Code's lifecycle — quality gates, skill routing, context backup, security scans, memory capture, telemetry (`src/core/hooks/`, `src/memory/hooks/`).
- **Autonomous research engine** — multi-threaded workers that run long-form research jobs against your choice of LLM providers (`src/research/`).
- **Persistent memory** — semantic memory store with consolidation and recall hooks (`src/memory/`).
- **Goals + todos** — a small personal goal/todo system with its own MCP server and slash commands (`src/goals/`).
- **Observability UI** — Fastify + React SPA showing sessions, telemetry, costs, memory, goals, research runs (`src/ui/`).
- **Telemetry** — JSONL session parser, token/cost aggregator, pricing tables (`src/telemetry/`).
- **Eval harness** — Agent SDK-driven evals for skill performance and hook compliance (`src/eval/`).

---

## Quick start

```bash
git clone <repo-url> ~/construct
cd ~/construct
bun install.ts          # deploys to ~/.claude/construct/, sets up systemd, verifies DB
bun run dev             # optional: hot-reload dev server at http://localhost:3001
```

Prod is served by `systemctl --user start construct-ui` on port 3000 (set up automatically by the installer).

Full installation, upgrade, and verification: [INSTALL.md](INSTALL.md).

---

## Requirements

- **Bun** (primary runtime)
- **Claude Code** CLI
- **Linux** or **WSL2 on Windows** (full systemd-backed install, observability UI as a service)
- **macOS** works for skills/hooks/agents/commands; the systemd service setup will no-op silently — run `bun run dev` manually if you want the UI

API keys (optional, set in `.env` at repo root):

- `OPENROUTER_API_KEY` — required for research workers
- `ANTHROPIC_API_KEY` — fallback / direct
- `TAVILY_API_KEY`, `BRAVE_SEARCH_API_KEY`, `JINA_API_KEY` — research providers

---

## Layout

```
src/
├── core/         CLAUDE.md, hooks/, identity/ (AGENTS.md, SOUL.md, STYLE.md)
├── memory/       hooks, semantic memory store
├── skills/       skill-rules.json, 19 skill directories
├── agents/       agent persona definitions
├── commands/     slash command .md files
├── data/         shared SQLite persistence + path resolution
├── telemetry/    JSONL parser, aggregator, pricing
├── eval/         Agent SDK eval harness
├── goals/        goal/todo domain logic + MCP server
├── research/     autonomous research engine + workers
├── logger/       structured logger
├── rules/        canonical rule sets (code/docs/design/agent/security)
└── ui/           Fastify API + React SPA (web/)

install.ts        installer
test.ts           test runner
docs/             specs, plans, mockups, references
```

Personal user data lives **outside** the install tree at `~/.construct/`:

```
~/.construct/
├── construct.db              shared SQLite (goals, todos, telemetry, memory metadata)
├── identity/                 USER.md + optional AGENTS/SOUL/STYLE overrides
├── sessions/                 captured session summaries
├── signals/                  rating + feedback signals
├── memory/                   semantic memory store
└── backups/                  rolling DB backups (kept: 5)
```

This separation means upgrades never touch your data, and personal identity (USER.md, overrides) never gets shipped back to the repo.

---

## Modules

| Module | Depends on | Provides |
|---|---|---|
| `core` | — | CLAUDE.md chain, settings.json, statusline, identity base files |
| `data` | — | Shared SQLite persistence, path resolution |
| `memory` | core | Session hooks, semantic memory, ratings, signals |
| `skills` | core | Skill routing, quality hooks, 19 skill playbooks |
| `logger` | — | Structured logger used across modules |
| `rules` | — | Canonical rule sets (code, docs, design, agent, security) |
| `telemetry` | data | JSONL parser, aggregator, pricing |
| `eval` | — | Agent SDK eval harness + scenarios |
| `goals` | data | Goal/todo domain logic, MCP server, slash commands |
| `research` | data | Autonomous research engine + worker supervisor |
| `ui` | data, goals, telemetry, research, memory | Fastify API + React SPA |

---

## Hooks

19 hooks across SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, and PreCompact events. They handle quality gates, skill routing, security scans, context backup, memory capture, and telemetry signals. Full list and behavior: [docs/specs/HOOKS.md](docs/specs/HOOKS.md).

---

## Skills

19 skill playbooks under `src/skills/<name>/SKILL.md`. The skill router reads `skill-rules.json` and activates matching skills based on prompt keywords; skills can also be invoked explicitly via `Skill()` or a slash-command alias. Highlights:

- **Review** — `code-review`, `design-review`, `docs-review`, `agent-review`
- **Quality** — `audit`, `debug`, `red-team`, `dogfood`, `code-suggest`
- **Workflow** — `git`, `code-test`, `ralph-loop`
- **Design** — `sketch`, `interview`, `skill-creator`
- **Knowledge** — `search`, `address`, `context-compact`

Full catalog: [docs/specs/SKILLS.md](docs/specs/SKILLS.md).

---

## Identity layering

Construct's CLAUDE.md chain is layered:

| File | Source | Purpose |
|---|---|---|
| `src/core/identity/AGENTS.md` | repo | Workflow rules, skill priority, decision-making |
| `src/core/identity/SOUL.md` | repo | Purpose, values, mental models |
| `src/core/identity/STYLE.md` | repo | Output formatting, voice |
| `~/.construct/identity/USER.md` | user-side | Personal profile, tech stack, environment |
| `~/.construct/identity/{AGENTS,SOUL,STYLE}.override.md` | user-side | Personal additions to each base — optional |

User-side files load via `@~/.construct/identity/...` in `src/core/CLAUDE.md`. Override files are optional and additive (just the lines you want on top — not a copy of the base).

**First-run note:** Claude Code will prompt once to approve external `@~/` includes. Approve to load the user-side identity chain. The decision is reversible via Claude Code settings.

---

## Running

### Dev (hot-reload)

```bash
bun run dev             # API + Vite middleware, http://localhost:3001
```

### Prod (systemd)

```bash
systemctl --user start construct-ui                  # port 3000
systemctl --user start construct-research-worker     # research worker
journalctl --user -u construct-ui -f                 # tail logs
```

Both are deployed by `bun install.ts`.

### Tests

```bash
bun test.ts             # unit + integration, gated at ≥90% pass
bun run ui:smoke        # headless Chromium walk of every UI route
```

### Upgrade

```bash
git pull && bun install.ts
```

Identity base files in `src/core/identity/` are sourced from the repo; `~/.construct/` is never touched. User-side overrides survive upgrades automatically.

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `API_PORT` | 3001 dev / 3000 prod | UI server port |
| `OPENROUTER_API_KEY` | — | Required for research workers |
| `ANTHROPIC_API_KEY` | — | Optional fallback |
| `WORKER_COUNT` | 3 | Research worker count |
| `CONSTRUCT_DATA_ROOT` | `~/.construct/` | Override data root |
| `CONSTRUCT_DB_PATH` | `~/.construct/construct.db` | Override DB path |

Place secrets in `.env` at the repo root.

---

## Documentation

| Document | Contents |
|---|---|
| [INSTALL.md](INSTALL.md) | Installation, upgrade, verification |
| [docs/specs/SPEC.md](docs/specs/SPEC.md) | Core + UI behavioral spec |
| [docs/specs/HOOKS.md](docs/specs/HOOKS.md) | Hook scripts, events, behavior |
| [docs/specs/SKILLS.md](docs/specs/SKILLS.md) | Skills, commands, routing |
| [docs/specs/RESEARCH.md](docs/specs/RESEARCH.md) | Research module spec |
| [docs/specs/TELEMETRY.md](docs/specs/TELEMETRY.md) | Telemetry spec |
| [docs/specs/EVAL.md](docs/specs/EVAL.md) | Eval harness spec |
| [docs/specs/TESTS.md](docs/specs/TESTS.md) | Test suite listing |
| [src/rules/design/](src/rules/design/) | Design rule set — typography, accessibility, css templates, Construct-specific design system |

---

## Status

Construct is the author's daily-driver personal AI setup. It's public, MIT-licensed, and built to be readable and forkable, but it's not packaged as a finished product. Expect rough edges, opinionated defaults, and a steady stream of changes on `main`. File issues and PRs welcome.
