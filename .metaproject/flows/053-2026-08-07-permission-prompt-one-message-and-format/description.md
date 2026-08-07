# Permission prompt: one message, and formatting that survives the tap

Status: formalized
Source: user description (operator review of a promo carousel)

## Problem

A permission prompt reaches the operator as **two messages**
(`channel/permissions.ts:252-275`): a preview carrying the last two path
segments and the change in a `<pre><code class="language-diff">` block, then a
second message with `🔐 Allow?`, the tool description, and the three buttons.
The change and the question it is asking about are separated by a message
boundary, and on a phone often by a scroll.

Then the tap makes it worse. `bot/callbacks.ts:350-357` edits the prompt in
place using `ctx.callbackQuery.message.text` — the **plain** text of the
message, with every entity stripped — and sends it back without a `parse_mode`.
An inline diff survives the question and does not survive the answer: after
`❌ No` the monospace is gone, the alignment collapses, and what is left reads
as prose that happens to start with minus signs.

`descMain` also carries the full absolute path, while the preview message
directly above it already shortens the same path to its last two segments. The
operator reads the same file named two different ways, in two messages, one
after the other.

The keyboard is defined twice — `channel/permissions.ts:270-274` and
`scripts/tmux-watchdog.ts:332-334` — so any change to it has to be made in two
places or it silently applies to one path only.

## Expected Outcome

- One message: the header, the tool line, the change, and the buttons together.
- The change stays formatted after the tap, on every outcome.
- One path spelling, one keyboard definition.
- A prompt too large for a single Telegram message still arrives, by falling
  back to the current two-message split rather than failing to send.

## Out of Scope

- Any `@@ -a,b +c,d @@` hunk header. `buildDetail` composes old/new lines with
  `-`/`+` prefixes and has no line numbers to work from; inventing them to look
  more like a diff would be inventing data.
- The auto-approve write path behind `✅ Always` (`bot/callbacks.ts:306-348`).
- Redesigning the status message or the recap.
