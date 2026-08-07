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

Each file starts with a short header naming its tone and its suggested image or
carousel; the post copy itself begins after the `---`.

## The images

All are 1200×630 — LinkedIn's link-preview and single-image ratio — rendered at
device scale 2, so the exported PNG is 2400×1260 and survives LinkedIn's
re-encoding.

| File | What it shows |
|---|---|
| `01-architecture` | Telegram → queue → sessions, and what lives on the host |
| `02-features` | Six capabilities, one card each |
| `03-telegram` | A topic mid-turn: voice in, live status, answer, spoken recap |
| `04-numbers` | Counts taken from the repository, and the stack |
| `05-control` | Memory recalled unprompted, and a tool call refused from the phone |
| `06-projects` | The forum list — eleven projects, one live session each |

### The carousel for the first post

`02-story` opens on eleven projects and a lost context, so it ships as three
frames in this order:

1. `06-projects` — the claim in the first line, made visible. Eleven topics, one
   session each, six of them working while nobody is looking.
2. `03-telegram` — one of them opened: a question asked by voice, the work
   visible as it happens, the answer, and the spoken recap.
3. `05-control` — the two things that are not a chat wrapper: memory recalled
   without being asked, and a destructive migration refused from the phone,
   after which the session rewrites it additively.

Three is the limit worth using. A reader gives a carousel about as much
attention as a post, and the fourth frame is where they stop swiping.

`03-telegram`, `05-control` and `06-projects` carry no explanatory column: the
words belong to the post the image ships with, and saying them twice reads as a
slideshow of the caption. They are the interface and nothing else.

### These three are mockups

`03-telegram`, `05-control` and `06-projects` are **drawn, not captured**. The
message structure is real — the status header, the `🧩` subagent line, the expandable quote, the
stats line, the `🔊` recap as a collapsed quote, and the `🔐 Allow?` prompt with
its `✅ Yes / ✅ Always / ❌ No` row all follow what `utils/status-render.ts`,
`channel/tools.ts` and `channel/permissions.ts` actually render — but the
conversations in them are written.

**A real screenshot beats all three at launch**, even a scruffier one: an
audience can tell the difference, and a drawn interface invites the question of
what else was drawn. Take one from a live topic and put it beside these; the
mockups are the fallback for frames a screenshot cannot stage, not the preferred
option. Whatever you do, do not caption a mockup as a screenshot — the honesty
is worth more than the polish.

## Re-rendering

The images are generated from `assets/src/*.html`. Each page holds both
languages and picks one from `?lang=`, so wording cannot be changed in English
and forgotten in Russian.

```bash
CHROME=~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome
for f in 01-architecture 02-features 03-telegram 04-numbers 05-control 06-projects; do
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
