# Media arrives from Telegram through an untested path

Status: formalized
Source: package `docs/requirements/io-layer-coverage-2026-08-05` (C4, the `bot/media.ts` half)

## Problem

`bot/media.ts` is 5.59% covered — 405 uncovered lines. It is how every picture,
voice note, document and video reaches a session.

Its central decision is `deliverMedia`: a file that arrived goes either into a
CLI session's queue, as a message with an attachment, or into a standalone
chat, where an image is inlined into the prompt and anything else is
acknowledged. That branch has already been wrong in a way that mattered — a
document arriving as `image/png` was inlined for one path and not for the
other, and one of the two had no size limit at all, so a forty-megabyte picture
went into a request whole.

The decision about *what* to inline lives in `utils/media-attachment.ts` and is
tested. The wiring that acts on it is not.

## Expected Outcome

- Both halves of the branch are driven: a file delivered to a CLI session lands
  in the queue with its attachment, and a file delivered to a standalone chat
  is inlined when it is an image and acknowledged when it is not.
- A failure to inline degrades to the acknowledgement rather than losing the
  file silently.

## Out of Scope

- `handleVoice`, whose transcription path deserves its own flow rather than the
  tail of this one.
- The download itself, which is `utils/files.ts`.
