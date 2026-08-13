import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { installFakeFetch, installNetworkGuard } from "../fixtures/fake-fetch.ts";
import { synthesize } from "../../utils/tts.ts";

/**
 * E1 — the reply text must not leave for a remote synthesiser (Yandex/Groq/
 * OpenAI) when the external-boundary scan blocks it; it is synthesised locally
 * instead, and the reply is never withheld (A1.3). These cases drive the real
 * `synthesize()` and assert, from the outside, that no remote *synthesis*
 * endpoint was called when a secret is present — and that one is attempted when
 * the text is clean.
 *
 * The scan is the real `keryx` binary (a local spawn, not a network call), so
 * these skip where it is absent, exactly like external-boundary-scan.test.ts.
 * The normaliser's own LLM call is left unprogrammed on purpose: with no fake
 * response it throws, and normalizeForSpeech returns the original text — so the
 * secret survives into the text the boundary actually scans.
 */
describe.skipIf(Bun.which("keryx") === null)("tts E1 external boundary", () => {
  let http: ReturnType<typeof installFakeFetch>["http"];
  let restore: () => void;

  const YANDEX_TTS = "tts.api.cloud.yandex.net";
  const REMOTE_SPEECH = "/audio/speech"; // Groq and OpenAI TTS synthesis

  beforeEach(() => {
    ({ http, restore } = installFakeFetch());
  });
  afterEach(() => {
    restore();
    installNetworkGuard();
  });

  it("does not send a secret-bearing reply to any remote synthesiser (A1.3)", async () => {
    const secret = "My AWS key is AKIAIOSFODNN7EXAMPLE and it must stay on this machine.";
    const result = await synthesize(secret);

    // No remote synthesis endpoint was reached — the crossing was withheld.
    expect(http.count(REMOTE_SPEECH)).toBe(0);
    expect(http.count(YANDEX_TTS)).toBe(0);
    // Local synthesis has no binary in the test env, so the voice is simply
    // absent — which is the fail-closed cost. The reply itself is unaffected;
    // it is not produced here.
    expect(result).toBeNull();
  });

  it("does attempt a remote synthesiser for clean text (regression)", async () => {
    // Groq TTS returns some bytes; the normaliser call is left to throw and fall
    // back to the original text, which is clean and passes the scan.
    http.program(REMOTE_SPEECH, { text: "FAKEWAVBYTES" });

    const clean = "The deployment finished and every check is green.";
    await synthesize(clean);

    // A remote synthesis endpoint was reached — the crossing was allowed.
    expect(http.count(REMOTE_SPEECH)).toBeGreaterThanOrEqual(1);
  });
});
