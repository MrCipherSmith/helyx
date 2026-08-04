# Plan

## The attachment

`utils/media-attachment.ts`: given what is known about a file — description,
mime type, byte length — return the attachment Claude receives. Pure, so the
threshold is a named constant with a test either side of it rather than a
number in the middle of an async function.

`deliverMedia` calls it and keeps the reading of bytes, which is the part that
has to touch the disk.

## The window and the bars

`utils/admin-format.ts`: `parseDaysArg`, `percentOf`, `histogramBar`.

`parseDaysArg` refuses what is not a positive number rather than handing it to
`make_interval`. The current code lets a negative through and the operator is
told there is no data, which is the worst of the three possible answers: wrong,
confident, and quiet.
