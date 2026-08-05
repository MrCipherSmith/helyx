# A deleted forum topic silently misdelivers every reply

Status: formalized
Source: user description → package `docs/requirements/self-observability-2026-08-05` (defect D4)

## Problem

Telegram does not reject `sendMessage` with a `message_thread_id` whose forum
topic has been deleted. It accepts the message, drops the thread and files it in
General, and answers `ok`.

Observed on 2026-08-05: the `keryx` topic (thread `1159`) was deleted from a
Telegram client. `projects.forum_topic_id` stayed `1159`, so every reply that
project sent went to the hub's General topic. Nothing errored and nothing
logged. Verified against the live API — `1159` returned `ok: true` with no
`message_thread_id`, live threads `1158`/`1160` echoed theirs back, and a
never-existent `999999` returned `message thread not found`.

`/forum_clean` exists to clear exactly this stale mapping and could not: its
`validateTopicExists` probed with `sendChatAction`, which answers `ok` for
`999999` too. The check reported every topic valid, always.

## Expected Outcome

- A send that asked for a thread and did not get it is reported at error level,
  naming the requested topic and where the message landed.
- `validateTopicExists` distinguishes a live topic from a deleted one, so
  `/forum_clean` can do its job.
- Neither change alters the success contract of a send: Telegram delivered the
  message, and reporting failure would make the channel resend it.

## Out of Scope

- Recreating deleted topics automatically. The keryx topic was recreated by
  hand through the existing `ForumService.createTopicForProject` path.
- Alerting to Telegram on a thread miss. The error log is the deliverable here;
  routing log errors to the operator is defect D2 of the same package and a
  separate flow.
- Recovering messages deleted from Telegram — impossible, and out of reach.
