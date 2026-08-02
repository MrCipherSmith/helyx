import { describe, test, expect } from "bun:test";
import {
  sessionProblemKey,
  restartCallbackData,
  paneCallbackData,
  forceDeliverCallbackData,
  startByPidCallbackData,
  ackCallbackData,
  parseSupervisorCallback,
} from "../../utils/supervisor-callbacks.ts";

/**
 * The `sup:` button protocol. Two failures motivate these tests.
 *
 * The restart button threw "project <n> not found" on every click because the
 * alert put a session id into a payload the handler reads as a project id —
 * two numbers, same shape, nothing to catch the swap. The round-trip tests
 * below assert which id each payload carries.
 *
 * The mute button derived its key with a fixed two-segment slice, so a project
 * name containing a colon produced a key matching no alert and silenced
 * nothing, silently.
 */

describe("round trip — which id each button carries", () => {
  test("restart carries a project id", () => {
    expect(parseSupervisorCallback(restartCallbackData(42))).toEqual({
      action: "restart_session",
      projectId: 42,
    });
  });

  test("pane carries a project id", () => {
    expect(parseSupervisorCallback(paneCallbackData(7))).toEqual({
      action: "pane",
      projectId: 7,
    });
  });

  test("start_by_pid carries a project id", () => {
    // Built by scripts/run-cli.sh when the restart cap trips.
    expect(parseSupervisorCallback(startByPidCallbackData(3))).toEqual({
      action: "start_by_pid",
      projectId: 3,
    });
  });

  test("force_deliver carries a session id", () => {
    expect(parseSupervisorCallback(forceDeliverCallbackData(11))).toEqual({
      action: "force_deliver",
      sessionId: 11,
    });
  });

  test("the shell-built start_by_pid payload parses identically", () => {
    // run-cli.sh writes this string by hand; if the format drifts the button dies.
    expect(parseSupervisorCallback("sup:start_by_pid:3")).toEqual(
      parseSupervisorCallback(startByPidCallbackData(3)),
    );
  });
});

describe("ack key agrees with the dedup key", () => {
  test("the mute button yields exactly the key the alert deduplicated under", () => {
    const parsed = parseSupervisorCallback(ackCallbackData("helyx", 3));
    expect(parsed).toEqual({ action: "ack", key: sessionProblemKey("helyx") });
  });

  test("the trailing id does not leak into the key", () => {
    const a = parseSupervisorCallback(ackCallbackData("helyx", 3));
    const b = parseSupervisorCallback(ackCallbackData("helyx", 999));
    expect(a).toEqual(b);
  });

  test("a project name containing a colon still produces the right key", () => {
    const project = "acme:web";
    const parsed = parseSupervisorCallback(ackCallbackData(project, 5));
    expect(parsed).toEqual({ action: "ack", key: sessionProblemKey(project) });
  });

  test("a project name with several colons survives too", () => {
    const project = "a:b:c";
    const parsed = parseSupervisorCallback(ackCallbackData(project, 1));
    expect(parsed).toEqual({ action: "ack", key: "session_problem:a:b:c" });
  });

  test("distinct projects never collapse to one key", () => {
    const helyx = parseSupervisorCallback(ackCallbackData("helyx", 1));
    const keryx = parseSupervisorCallback(ackCallbackData("keryx", 1));
    expect(helyx).not.toEqual(keryx);
  });
});

describe("payloads that carry nothing", () => {
  test.each(["ignore", "bounce", "noop"])("%s parses to just the action", (action) => {
    expect(parseSupervisorCallback(`sup:${action}`)).toEqual({ action } as never);
  });
});

describe("malformed input", () => {
  test("an unknown action is reported as unknown, with the payload kept", () => {
    expect(parseSupervisorCallback("sup:teleport:1")).toEqual({
      action: "unknown",
      raw: "sup:teleport:1",
    });
  });

  test("an empty payload does not throw", () => {
    expect(parseSupervisorCallback("")).toEqual({ action: "unknown", raw: "" });
  });

  test("a missing id becomes 0 rather than NaN", () => {
    // NaN would reach enqueueRestart and fail somewhere less obvious.
    expect(parseSupervisorCallback("sup:restart_session")).toEqual({
      action: "restart_session",
      projectId: 0,
    });
  });

  test("a non-numeric id becomes 0 rather than NaN", () => {
    expect(parseSupervisorCallback("sup:restart_session:abc")).toEqual({
      action: "restart_session",
      projectId: 0,
    });
  });

  test("an ack with no trailing id keeps the whole remainder as the key", () => {
    expect(parseSupervisorCallback("sup:ack:session_problem")).toEqual({
      action: "ack",
      key: "session_problem",
    });
  });
});
