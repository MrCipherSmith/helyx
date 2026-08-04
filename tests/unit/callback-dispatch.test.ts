/**
 * The dispatch, not the table.
 *
 * `callback-route.test.ts` proves the table is right, and that is a different
 * claim from "the press reaches its handler". The switch that consumes the
 * table could send a route to the wrong case, or derive the wrong argument
 * from the data, and every test of the table would still pass — which is the
 * same trap this session has now fallen into three times.
 *
 * So these drive the real `handleCallbackQuery` with a recording handler map.
 */

import { describe, test, expect } from "bun:test";
import type { Context } from "grammy";
import { handleCallbackQuery, defaultCallbackHandlers, type CallbackHandlers } from "../../bot/callbacks.ts";
import { CALLBACK_ROUTES, routeCallback, callbackPayload, type CallbackRoute } from "../../utils/callback-route.ts";

interface Call {
  route: CallbackRoute;
  data: string;
}

/** A context that records the toast, and handlers that record the call. */
function press(data: string | undefined) {
  const calls: Call[] = [];
  const toasts: string[] = [];

  const handlers = Object.fromEntries(
    (Object.keys(defaultCallbackHandlers) as CallbackRoute[]).map((route) => [
      route,
      async (_ctx: Context, d: string) => {
        calls.push({ route, data: d });
      },
    ]),
  ) as CallbackHandlers;

  const ctx = {
    callbackQuery: data === undefined ? undefined : { data },
    answerCallbackQuery: async (options?: { text?: string }) => {
      toasts.push(options?.text ?? "");
      return true;
    },
  } as unknown as Context;

  return { ctx, handlers, calls, toasts };
}

describe("a press reaches its handler", () => {
  test("every route in the table has a handler, and it is the one called", () => {
    // Walked from the table itself, so a prefix added without a handler is a
    // failure here rather than a runtime crash on the operator's press.
    for (const [prefix, route] of CALLBACK_ROUTES) {
      expect([prefix, typeof defaultCallbackHandlers[route]]).toEqual([prefix, "function"]);
    }
  });

  test("each prefix calls exactly its own handler, once", async () => {
    for (const [prefix, route] of CALLBACK_ROUTES) {
      const data = `${prefix}payload`;
      const { ctx, handlers, calls } = press(data);

      await handleCallbackQuery(ctx, handlers);

      expect([prefix, calls]).toEqual([prefix, [{ route, data }]]);
    }
  });

  test("the handler is given the whole callback data", async () => {
    // Not the payload: `handleQuestionCallback` parses the full string, and
    // handing it a stripped one would break every answer.
    const { ctx, handlers, calls } = press("ask:a1b2:0:1");

    await handleCallbackQuery(ctx, handlers);

    expect(calls[0]!.data).toBe("ask:a1b2:0:1");
  });

  test("an unclaimed press is answered rather than ignored", async () => {
    // A button that does nothing at all reads as a broken bot, and the
    // operator presses it again.
    const { ctx, handlers, calls, toasts } = press("nonsense:1");

    await handleCallbackQuery(ctx, handlers);

    expect(calls).toEqual([]);
    expect(toasts).toEqual(["Unknown action"]);
  });

  test("a press with no data at all is answered too", async () => {
    const { ctx, handlers, calls, toasts } = press(undefined);

    await handleCallbackQuery(ctx, handlers);

    expect(calls).toEqual([]);
    expect(toasts).toEqual(["Unknown action"]);
  });
});

describe("the payload the handlers derive", () => {
  test("comes from the same table that matched it", () => {
    // It used to be a hand-written `"set_model:".length` — the prefix written
    // twice, in the table and in the arithmetic, with only one of the two
    // updated when a prefix changed.
    expect(callbackPayload("set_model:claude-opus-5")).toBe("claude-opus-5");
    expect(callbackPayload("poll_submit:9")).toBe("9");
    expect(callbackPayload("sess:delete:7")).toBe("7");
  });

  test("the longest matching prefix wins where they nest", () => {
    // `sess:delete:7` must not yield `delete:7` by matching some shorter
    // entry, and a skill save must not yield `save:deploy`.
    expect(callbackPayload("skill:save:deploy")).toBe("deploy");
    expect(callbackPayload("skill:deploy")).toBe("deploy");
  });

  test("a bare prefix has an empty payload, not an error", () => {
    expect(callbackPayload("menu:")).toBe("");
  });

  test("unclaimed data has no payload", () => {
    expect(callbackPayload("nonsense:1")).toBe("");
    expect(callbackPayload("")).toBe("");
    expect(callbackPayload(undefined)).toBe("");
  });

  test("a poll id survives the round trip as a number", async () => {
    // `Number("")` is 0 and `Number("x")` is NaN — both would reach the poll
    // handler as a session id and look for a session that cannot exist.
    expect(Number(callbackPayload("poll_submit:9"))).toBe(9);
    expect(Number.isNaN(Number(callbackPayload("poll_submit:x")))).toBe(true);
  });

  test("payload and route are derived from the same match", () => {
    // Walked across the whole table: any entry where the two disagree is a
    // handler acting on another prefix's payload.
    for (const [prefix, route] of CALLBACK_ROUTES) {
      const data = `${prefix}xyz`;
      expect([prefix, routeCallback(data), callbackPayload(data)]).toEqual([prefix, route, "xyz"]);
    }
  });
});
