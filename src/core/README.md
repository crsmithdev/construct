# construct-core

Foundation module. Provides CLAUDE.md, settings.json, statusline, and the identity base files (AGENTS/SOUL/STYLE) plus the user-side override chain at `~/.construct/identity/`.

**Depends on:** nothing (always required)

## Contents

- `CLAUDE.md` — framework rules and behavior (installed at `~/.claude/CLAUDE.md`)
- `settings.json` — hooks, statusline, permissions (installed at `~/.claude/settings.json`)
- `ccstatusline` — external binary for status bar (model, branch, dir, context %, tokens)
- `identity/` — semantic identity layer (base, repo-managed):
  - `AGENTS.md` — workflow rules, skill priority, agent personas
  - `SOUL.md` — purpose, values, mental models
  - `STYLE.md` — output formatting, voice conventions

## Usage

The statusline appears automatically at the bottom of Claude Code, showing model, git branch, directory, and context usage. No interaction needed.

Identity is layered. Base files in `core/identity/` ship with the repo; personal additions live outside the install at `~/.construct/identity/` and load on top:

| User-side file | Loaded by `core/CLAUDE.md` | Purpose |
|---|---|---|
| `USER.md` | `@~/.construct/identity/USER.md` | Personal profile, environment, tech stack |
| `AGENTS.override.md` | `@~/.construct/identity/AGENTS.override.md` | Personal workflow tweaks layered onto `AGENTS.md` |
| `SOUL.override.md` | `@~/.construct/identity/SOUL.override.md` | Personal values/traits layered onto `SOUL.md` |
| `STYLE.override.md` | `@~/.construct/identity/STYLE.override.md` | Personal voice tweaks layered onto `STYLE.md` |

Override files are optional — missing ones are silently skipped. To customize, create `~/.construct/identity/<NAME>.override.md` with just the lines you want added; do not copy the whole base. Changes take effect on the next session.

## Verification

Post-install checks: see [INSTALL.md](INSTALL.md).
