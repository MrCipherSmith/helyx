# Plan

## The shape of the answer

A multi-select slot holds `{ picked: number[], done: boolean }` rather than an
index. `isAnswered` is true only when `done`, so a half-toggled question keeps
the call waiting — which is the whole difference between this and single
select.

## The toggle, without losing a tap

The existing single-select write is careful for a reason: reading the array and
writing it back loses an answer when two taps land at once. A toggle is
read-modify-write by nature, so the same care is needed and the same technique
applies — the toggle happens inside the statement, in SQL, so two taps on the
same question compose however they interleave rather than one overwriting the
other.

## The keyboard

Toggles show their state (`☑`/`☐`), and a submit row appears beneath. The
message is re-rendered on each tap so the operator can see what they have.

## The submit

Sets `done`. An empty selection is refused with a toast rather than recorded:
"none of these" is a real answer, but it is the free-text button's answer, not
an empty list.
