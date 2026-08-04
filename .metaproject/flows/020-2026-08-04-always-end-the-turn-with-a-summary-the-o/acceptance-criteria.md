# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A turn that ends without any reply produces a summary message in the project's forum topic, carrying the final assistant text from the transcript.
- AC2: A turn that already sent a reply produces no second summary — the operator is not told the same thing twice.
- AC3: The summary is sent to the topic from projects.forum_topic_id for the project path, never to the forum's General.
- AC4: The summary is marked as bot-forwarded, so it cannot be mistaken for something the session chose to send.
- AC5: A transcript with no assistant text, an unreadable transcript, or an unknown project path produces no message and no crash.
- AC6: The response guard does not announce silence while a question is open for that session; it re-arms quietly instead.
- AC7: The guard still announces silence when no question is open — the fix narrows the alarm rather than disabling it.
- AC8: Interactive prompt lines and the "Enter to select" footer do not appear in the status pane.
- AC9: Ordinary terminal output containing a numbered list is not mistaken for a prompt and still reaches the pane.
- AC10: Every new test was checked by reintroducing the bug it covers, and each one failed.
- AC11: Full gate green: bun test, typecheck, eslint 0 errors, dupes unchanged.
