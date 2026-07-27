# Flows

Each directory is one flow: `<NNN>-<YYYY-MM-DD>-<slug>/`.

A flow is a story's journey from initialization to completion, managed by the
Task Manager module (`gd-metapro flow ...`). flow.json is CLI-owned state -
do not edit it by hand. Acceptance criteria are checksum-frozen after
`flow freeze`.

Statuses: initializing -> ready -> in-progress -> implemented -> completing ->
done (+ blocked). See `.metaproject/skills/flow/SKILL.md`.
