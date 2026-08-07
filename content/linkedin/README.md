# LinkedIn launch kit

Post copy and images for announcing Helyx. Nothing here is imported by the
application — it is content, kept in the repository so the claims in it can be
checked against the code that makes them.

## What is here

```
posts/en/     four variants in English, different tones
posts/ru/     the same four in Russian
assets/en/    rendered images, English
assets/ru/    rendered images, Russian
assets/src/   the HTML the images are rendered from
```

## The four post variants

| File | Tone | Use when |
|---|---|---|
| `01-technical` | For engineers. What it is, how it is built. | The audience is developers and the architecture is the interesting part. |
| `02-story` | First person, quiet. | Default choice — stories are read to the end, feature lists are not. |
| `03-problem` | Problem first, then the answer. | The audience is wider than engineers. |
| `04-short` | ~90 words. | The image carries the message and the whole post should fit above "see more". |

Each file starts with a short header naming its tone and its suggested image;
the post copy itself begins after the `---`.

## The images

All are 1200×630 — LinkedIn's link-preview and single-image ratio — rendered at
device scale 2, so the exported PNG is 2400×1260 and survives LinkedIn's
re-encoding.

| File | What it shows |
|---|---|
| `01-architecture` | Telegram → queue → sessions, and what lives on the host |
| `02-features` | Six capabilities, one card each |
| `03-telegram` | What a topic looks like mid-turn: voice in, live status, answer, spoken recap |
| `04-numbers` | Counts taken from the repository, and the stack |

`03-telegram` is an **illustration**, not a screenshot. The message structure in
it — the status header, the `🧩` subagent line, the expandable quote, the stats
line, the `🔊` recap as a collapsed quote — follows what `utils/status-render.ts`
and `channel/tools.ts` actually render, but the conversation in it is written for
the picture. If you want a real screenshot, take one from a live topic and drop
it in beside this file; do not relabel this one.

## Re-rendering

The images are generated from `assets/src/*.html`. Each page holds both
languages and picks one from `?lang=`, so wording cannot be changed in English
and forgotten in Russian.

```bash
CHROME=~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome
for f in 01-architecture 02-features 03-telegram 04-numbers; do
  for l in en ru; do
    $CHROME --headless --disable-gpu --no-sandbox --hide-scrollbars \
      --force-device-scale-factor=2 --window-size=1200,630 \
      --screenshot="content/linkedin/assets/$l/$f.png" \
      "file://$PWD/content/linkedin/assets/src/$f.html?lang=$l"
  done
done
```

## Numbers used, and where they come from

Check these before posting if the repository has moved on — a public claim that
does not match the repo is worse than no claim.

| Claim | Source |
|---|---|
| 1902 unit tests, 109 files | `bun test tests/unit/` |
| 18 stdio MCP tools, 19 HTTP | `channel/tools.ts`, `mcp/tools.ts` |
| 62 Telegram commands | `b.command(` registrations in `bot/handlers.ts` |
| 49 schema migrations | `memory/db.ts` |
| v1.55.2 | `package.json` |
