/**
 * The remote posture line (adoption area A1.10): whether remote TTS and
 * remote transcription are active must be visible from the status surface
 * without reading .env. `renderStatus` is pure — it only renders what
 * `StatusParts.remoteTts` / `remoteTranscription` hand it, and the actual
 * derivation from CONFIG lives in `utils/external-boundary-scan.ts`'s
 * `remotePosture()`, exercised by its own tests.
 */

import { describe, test, expect } from "bun:test";
import { renderStatus } from "../../utils/status-render.ts";

const base = { stage: "working", elapsed: "2m 26s" };

describe("the remote posture line", () => {
  test("shows TTS on and transcription off", () => {
    const out = renderStatus({ ...base, remoteTts: true, remoteTranscription: false });
    expect(out).toContain("🌐 remote: TTS on · transcription off");
  });

  test("shows TTS off and transcription on", () => {
    const out = renderStatus({ ...base, remoteTts: false, remoteTranscription: true });
    expect(out).toContain("🌐 remote: TTS off · transcription on");
  });

  test("both fields undefined renders no posture line at all", () => {
    expect(renderStatus({ ...base })).not.toContain("🌐");
  });

  test("it sits above the work block, where trimming cannot reach it", () => {
    const stage = Array.from({ length: 400 }, (_, i) => `● line ${i} ${"x".repeat(200)}`).join("\n");
    const out = renderStatus({ ...base, stage, remoteTts: true, remoteTranscription: false });
    expect(out.indexOf("🌐")).toBeLessThan(out.indexOf("<blockquote"));
  });
});
