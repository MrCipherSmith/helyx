/**
 * Whether the dashboard this bot was told to serve is actually in the image.
 *
 * Two flags have to agree and nothing made them. `WITH_DASHBOARD` is a build
 * argument, false by default because the dashboard build stages are what take
 * the image from 256 MB to a gigabyte; when it is false the Dockerfile creates
 * the dist directories empty so the later `COPY` still resolves.
 * `ENABLE_DASHBOARD` is a runtime flag, and nothing checks it against what was
 * built.
 *
 * The operator's report was a Mini App showing `Not Found`. The route was fine,
 * the files were not there, and every layer answered correctly on the way to a
 * 404 that meant "no such route" when the truth was "this was never built".
 *
 * `docker-compose.yml` warns about the pairing in a comment. A comment is what
 * this replaces.
 */

/** What the process knows when it asks. */
export interface DashboardFacts {
  /** `ENABLE_DASHBOARD` — what the runtime was told to do. */
  enabled: boolean;
  /** Does `dashboard/dist` contain anything? */
  dashboardBuilt: boolean;
  /** Does `dashboard/webapp/dist` contain anything? */
  webappBuilt: boolean;
}

export interface Readiness {
  /** Nothing to say: either it is off, or it is on and present. */
  ok: boolean;
  /** What is missing, and what to do about it. Empty when `ok`. */
  message: string;
}

/**
 * The instruction, in full.
 *
 * Naming the flag and the command is the whole point. A message that says
 * "empty" and stops costs its reader the same search every time, and the reader
 * is usually someone whose Mini App just said `Not Found`.
 */
function instruction(missing: string): string {
  return (
    `Dashboard is enabled (ENABLE_DASHBOARD=true) but ${missing} in this image. ` +
    "It was built without it — WITH_DASHBOARD defaults to false. " +
    "Set WITH_DASHBOARD=true in .env and rebuild: docker compose up -d --build bot"
  );
}

/**
 * What, if anything, is wrong.
 *
 * The disabled case is silent on purpose: a bot that was told not to serve a
 * dashboard and has none is correct, and a warning about it would be noise on
 * every start of every small deployment.
 */
export function dashboardReadiness(facts: DashboardFacts): Readiness {
  if (!facts.enabled) return { ok: true, message: "" };

  if (!facts.dashboardBuilt && !facts.webappBuilt) {
    return { ok: false, message: instruction("neither the dashboard nor the Mini App is present") };
  }
  if (!facts.webappBuilt) {
    return { ok: false, message: instruction("the Mini App (dashboard/webapp/dist) is empty") };
  }
  if (!facts.dashboardBuilt) {
    return { ok: false, message: instruction("the dashboard (dashboard/dist) is empty") };
  }
  return { ok: true, message: "" };
}

/**
 * The two `.env` lines an install writes for the dashboard.
 *
 * Both, together, from one answer — which is the whole fix. The installer used
 * to write only `ENABLE_DASHBOARD`, so an install that said yes to the
 * dashboard produced a container built without one: `WITH_DASHBOARD` is a build
 * argument and its default is false.
 */
export function dashboardEnvLines(enableDashboard: boolean): string[] {
  return [
    `ENABLE_DASHBOARD=${enableDashboard}`,
    `WITH_DASHBOARD=${enableDashboard}`,
  ];
}

/**
 * Whether the Mini App button should be offered at all.
 *
 * A button that opens `Not Found` is worse than no button: it is a promise the
 * system cannot keep, and the operator presses it more than once.
 */
export function shouldOfferMiniApp(facts: DashboardFacts): boolean {
  return facts.enabled && facts.webappBuilt;
}
