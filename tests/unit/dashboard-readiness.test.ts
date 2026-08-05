/**
 * A dashboard that was enabled and never built.
 *
 * The operator's report was a screenshot: the Mini App open, and `Not Found` in
 * it. The route was fine. The files were not there — `dashboard/webapp/dist` is
 * an empty directory inside the image, because `WITH_DASHBOARD` is a build
 * argument that defaults to false and the Dockerfile creates the dist
 * directories empty so its later `COPY` still resolves.
 *
 * `ENABLE_DASHBOARD` was true. Nothing compared the two, and every layer
 * answered correctly on the way to a 404 that meant "no such route" when the
 * truth was "this was never built". `docker-compose.yml` warns about the
 * pairing in a comment; a comment is what these tests replace.
 */

import { describe, test, expect } from "bun:test";
import type { IncomingMessage, ServerResponse } from "http";
import {
  dashboardReadiness,
  shouldOfferMiniApp,
  dashboardEnvLines,
  type DashboardFacts,
} from "../../utils/dashboard-readiness.ts";
import { handleDashboardRequest, setDashboardReadiness, getDashboardReadiness } from "../../mcp/dashboard-api.ts";

const facts = (over: Partial<DashboardFacts> = {}): DashboardFacts => ({
  enabled: true,
  dashboardBuilt: true,
  webappBuilt: true,
  ...over,
});

describe("what was enabled against what was built", () => {
  test("enabled and built is nothing to say", () => {
    expect(dashboardReadiness(facts())).toMatchObject({ ok: true, message: "" });
  });

  test("disabled and unbuilt is nothing to say either", () => {
    // The correct small deployment. A warning here would be noise on every
    // start of every host that answered "no" on purpose.
    expect(dashboardReadiness(facts({ enabled: false, dashboardBuilt: false, webappBuilt: false })).ok).toBe(true);
  });

  test("disabled but built is still nothing to say", () => {
    // An image that carries a dashboard nobody asked to serve is wasteful, not
    // broken, and this is not the place to say so.
    expect(dashboardReadiness(facts({ enabled: false })).ok).toBe(true);
  });

  test("enabled with neither present is the reported case", () => {
    const state = dashboardReadiness(facts({ dashboardBuilt: false, webappBuilt: false }));

    expect(state.ok).toBe(false);
    expect(state.message).toContain("neither");
  });

  test("enabled with only the Mini App missing names the Mini App", () => {
    const state = dashboardReadiness(facts({ webappBuilt: false }));

    expect(state.ok).toBe(false);
    expect(state.message).toContain("webapp/dist");
  });

  test("enabled with only the dashboard missing names the dashboard", () => {
    const state = dashboardReadiness(facts({ dashboardBuilt: false }));

    expect(state.ok).toBe(false);
    expect(state.message).toContain("dashboard/dist");
  });
});

describe("what the message has to say", () => {
  test("the flag to set and the command to run, not just the symptom", () => {
    // A message that says "empty" and stops costs its reader the same search
    // every time, and the reader is someone whose Mini App just said
    // `Not Found`.
    const { message } = dashboardReadiness(facts({ webappBuilt: false }));

    expect(message).toContain("WITH_DASHBOARD=true");
    expect(message).toContain("docker compose up -d --build bot");
    expect(message).toContain("ENABLE_DASHBOARD=true");
  });
});

describe("offering the Mini App button", () => {
  test("offered when it exists and is enabled", () => {
    expect(shouldOfferMiniApp(facts())).toBe(true);
  });

  test("not offered when it was never built", () => {
    // The button used to be set on the webhook URL alone. A button that opens
    // `Not Found` is worse than no button: it is a promise the system cannot
    // keep, and the operator presses it more than once.
    expect(shouldOfferMiniApp(facts({ webappBuilt: false }))).toBe(false);
  });

  test("not offered when the dashboard is switched off", () => {
    expect(shouldOfferMiniApp(facts({ enabled: false }))).toBe(false);
  });

  test("offered even when only the full dashboard is missing", () => {
    // They are separate builds and separate surfaces: the Mini App works
    // without the desktop SPA, and refusing the button for the other's absence
    // would take away a page that is there.
    expect(shouldOfferMiniApp(facts({ dashboardBuilt: false }))).toBe(true);
  });
});

describe("what an install writes", () => {
  test("saying yes writes both halves of the answer", () => {
    // The bug in one line: the installer wrote the runtime flag and not the
    // build one, so an install that enabled the dashboard produced a container
    // built without it.
    expect(dashboardEnvLines(true)).toEqual(["ENABLE_DASHBOARD=true", "WITH_DASHBOARD=true"]);
  });

  test("saying no writes both as no", () => {
    expect(dashboardEnvLines(false)).toEqual(["ENABLE_DASHBOARD=false", "WITH_DASHBOARD=false"]);
  });

  test("they cannot drift apart, whatever the answer", () => {
    for (const answer of [true, false]) {
      const values = dashboardEnvLines(answer).map((line) => line.split("=")[1]);
      expect(new Set(values).size).toBe(1);
    }
  });
});

describe("what the Mini App gets when it was never built", () => {
  /** A response that records what was written instead of writing it. */
  function recorder(): { res: ServerResponse; answer: { status: number; body: string } } {
    const answer = { status: 0, body: "" };
    const res = {
      writeHead(status: number) { answer.status = status; return res; },
      setHeader() {},
      write(chunk: string) { answer.body += chunk; return true; },
      end(chunk?: string) { if (chunk) answer.body += chunk; },
      on() { return res; },
    } as unknown as ServerResponse;
    return { res, answer };
  }

  const request = (path: string) => ({
    method: "GET",
    url: path,
    headers: { host: "localhost:3847" },
    on(event: string, cb: () => void) { if (event === "end") cb(); return this; },
  } as unknown as IncomingMessage);

  test("the sentence that names the flag, not a bare 404", async () => {
    // A 404 says "no such route" and the route is fine. The operator staring at
    // `Not Found` in a Mini App has no way to learn the difference from it.
    const restore = setDashboardReadiness(dashboardReadiness({ enabled: true, dashboardBuilt: false, webappBuilt: false }));
    const { res, answer } = recorder();

    try {
      const handled = await handleDashboardRequest(request("/webapp/"), res, new URL("http://localhost:3847/webapp/"));

      expect(handled).toBe(true);
      expect(answer.status).toBe(503);
      expect(answer.body).toContain("WITH_DASHBOARD=true");
    } finally {
      restore();
    }
  });

  test("a bot that was built correctly is not touched by any of this", async () => {
    // The other half of the rule: on a machine where the files are there, the
    // request is served as it always was and nothing new happens.
    const restore = setDashboardReadiness({ ok: true, message: "" });
    const { res, answer } = recorder();

    try {
      await handleDashboardRequest(request("/webapp/"), res, new URL("http://localhost:3847/webapp/"));

      expect(answer.status).not.toBe(503);
    } finally {
      restore();
    }
  });

  test("the answer is worked out once, not per request", async () => {
    // A rebuild is the only thing that can change it, and a rebuild restarts
    // the process. Reading two directories per hit would be a syscall for an
    // answer already known.
    const restore = setDashboardReadiness({ ok: false, message: "seeded" });

    try {
      expect((await getDashboardReadiness()).message).toBe("seeded");
      expect((await getDashboardReadiness()).message).toBe("seeded");
    } finally {
      restore();
    }
  });
});
