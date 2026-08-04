# Plan

## The button

Every question message gains one more button: `✏️ Свой ответ`, encoded as
`ask:<id>:<q>:t`. `parseAnswerCallback` returns a discriminated result — an
option index, or a request to type.

## The waiting state

A column on `question_requests`: `awaiting_question INT`. Set when the button
is pressed, cleared when the text arrives or the request ends. One at a time
per request, because the operator types one message at a time and a second
press replaces the first.

## The text

`bot/text-handler.ts` already decides what to do with an incoming message. It
asks first whether this chat has a request awaiting text; if so the message
becomes that answer and is not forwarded. The decision is pure and tested
separately from the plumbing that acts on it.

## The answer

An answer slot holds either an option index or a string. `allAnswered` treats a
string as answered. `formatAnswers` prints it as the operator's own words
rather than as an option label, so Claude cannot mistake it for one of the
choices it offered.
