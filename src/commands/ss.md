---
description: Read the user's latest screenshot from their screenshot drop directory and optionally answer a question about it
---

Resolve the most recent screenshot by running `${SHOTS_LATEST:-$HOME/.local/bin/latest-shot}` (default one-liner: `ls -t "${SHOTS_DIR:-$HOME/shots}"/*.png | head -1`). Then Read the resulting path so the image is in context.

Configure via env vars:

- `SHOTS_DIR` — directory your screenshot tool writes to (default `~/shots`)
- `SHOTS_LATEST` — optional custom resolver script (default `~/.local/bin/latest-shot`)

If `$ARGUMENTS` is non-empty, treat it as the user's question about the screenshot and answer it directly after reading.

If the resolver returns nothing, say so plainly — don't fabricate.
