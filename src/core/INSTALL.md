# construct-core — Post-install Checks

All paths relative to `~/.claude/`. Run every check. Do not skip or summarize.

## Files

- `CLAUDE.md` exists and contains `# Construct`
- `settings.json` exists and is valid JSON (`jq . settings.json`)
- `ccstatusline` is on PATH (`which ccstatusline`)
- Identity base files: `AGENTS.md`, `SOUL.md`, `STYLE.md` in `construct/core/identity/`
- Personal profile `USER.md` lives outside the install dir at `~/.construct/identity/USER.md` (user-managed; not deployed by installer)
- Optional user overrides at `~/.construct/identity/{AGENTS,SOUL,STYLE}.override.md` are loaded after each base via `@~/` includes

## Registration

- Hook registration structure is nested: `hooks.<Event>[].hooks[].command`. To verify a hook is registered, use: `jq '.hooks.<Event>[]?.hooks[]?.command' settings.json | grep '<filename>'`
- `settings.json` has a `statusLine` entry referencing `ccstatusline`

## Data

- Identity base files are non-empty (0 bytes = repo damage, not a user issue)
- `CLAUDE.md` retains user content above `# Construct` (if upgrading)
- `CLAUDE.md` under 300 lines (⚠ if over)
