# Publish readiness checklist

Tracking for everything that must be scrubbed/decided before the Construct repo is shared publicly. Split out from `personal-data-isolation.md` so the items survive after that plan merges.

Each row is a discrete scrub. Tackle individually; none block any other. Mark with `[x]` when done.

## Identity leaks (deferred from personal-data-isolation)

- [ ] **1. `package.json` `author` field** — drop, or set to `"Construct"`. Check for other personal fields (`bugs.email`, `repository.url` if a personal URL).
- [ ] **2. `soul.json`** — `name`, `displayName`, `description`, `tags`, `category`. Either genericize or move user-specific values to the override mechanism.
- [ ] **3. `src/agents/codebase-auditor.md` hard-coded paths** — replace `~/construct/` and `/home/crsmi/` literals with relative / discovered paths.
- [ ] **4. `src/rules/docs/RULES.md:68` citation** — strip or generalize the personal citation example.
- [ ] **5. Comment-username leaks** — `src/format.ts`, `src/observability.ts`. Grep for `crsmi`/`crsmithdev`, scrub.
- [ ] **6. `src/tests/e2e.test.ts:212` literal** — replace hardcoded string with a fixture/generic value.
- [ ] **7. Fixture username leaks (broad sweep)** — grep all fixtures for `crsmi*`, replace with `testuser` (or similar).
- [ ] **8. `.claude/CLAUDE.md` workflow scrub** — personal workflow lines (e.g. "port 3001 belongs to user"). Decide what's repo-dev guidance vs personal preference; trim personal.
- [ ] **9. Port numbers + Greenshot references** — `3000/3001/3002` and Greenshot mentions in docs/code. Move to config or doc as examples, not mandates.

## Other pre-publish concerns

- [ ] **10. Git history retention** — wipe before publish. Options: `git filter-repo` (surgical, keeps history shape) or orphan-branch nuke (destructive, removes all email/identity from commit objects). User-executed at publish time; agent does NOT force-push.
- [ ] **11. Plugin user override-include resolution** (Phase 2 F-4 from prior red-team) — plugin install creates no `~/.construct/identity/`, so plugin users get broken `@~/.construct/...` includes from the shipped base CLAUDE.md chain. Handle inside `feat/plugin-packaging` work — likely the plugin installer should create the user-side dir on first run.
- [ ] **12. Trust-prompt UX on first external `@~/`** (V3 from personal-data interview) — resolved as one-time dialog, reversible via settings. Action: document the prompt in README/INSTALL.md so first-time users know what they're being asked. No code change needed.

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
