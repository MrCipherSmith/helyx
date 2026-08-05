/**
 * Latin script the Russian voice can actually say.
 *
 * The Russian Piper model has no Latin phonemes: given `docker compose` it does
 * not read it badly, it reads it as nothing. Yandex handled mixed script, which
 * is why it was first in the chain — and when its key stopped working, every
 * tool name in every status message went silent.
 *
 * The prompt was asked to fix this first and measured: across five real
 * sentences, five models left between 33 and 124 Latin characters in, with the
 * instruction stated twice. So the prompt asks and this guarantees, and these
 * tests are about the guarantee.
 */

import { describe, test, expect } from "bun:test";
import { cyrillize, hasLatin, soundOut } from "../../utils/cyrillize.ts";

/** The sentences the benchmark ran on — this project's own traffic. */
const REAL = [
  "Пересобрал контейнер через docker compose up -d --build bot, но channel.ts на хосте остался на старом коде.",
  "Транскрипт лежит в 6b75d4e8.jsonl, читаю его через TranscriptTail.",
  "Yandex SpeechKit отдаёт 401 PermissionDenied, поэтому fallback ушёл на piper-ru.",
  "Добавил stack_up и full_restart в admin-daemon, health_checks заменил на process_health.",
  "Supervisor шлёт alert когда health endpoint молчит три probe подряд.",
];

describe("the invariant", () => {
  test("no Latin survives, on any real sentence", () => {
    for (const sentence of REAL) {
      expect(hasLatin(cyrillize(sentence))).toBe(false);
    }
  });

  test("including the shapes the models kept leaving in", () => {
    // Each of these came back untouched from at least one benchmarked model.
    for (const leftover of ["PermissionDenied", "ru_RU-irina-medium", "sup:stack_up", "channel.ts", "callback_data", "health_checks"]) {
      expect(hasLatin(cyrillize(leftover))).toBe(false);
    }
  });

  test("and on script it has no rule for", () => {
    expect(hasLatin(cyrillize("xyzzy qqq wjt"))).toBe(false);
  });
});

describe("what it must not touch", () => {
  test("Cyrillic passes through unchanged", () => {
    const russian = "Пересобрал контейнер, но код остался старым.";
    expect(cyrillize(russian)).toBe(russian);
  });

  test("digits are not words", () => {
    // The normalizer upstream decides how numbers are read; mangling them here
    // would silently undo that.
    expect(cyrillize("401")).toBe("401");
    expect(cyrillize("отдаёт 401 и 5 раз")).toBe("отдаёт 401 и 5 раз");
  });

  test("punctuation and structure survive", () => {
    const out = cyrillize("docker, compose — up!");
    expect(out).toContain(",");
    expect(out).toContain("—");
    expect(out).toContain("!");
  });
});

describe("sound, not meaning", () => {
  test("a term keeps the word the operator said", () => {
    // `commit` must not become `фиксация`: they say commit and need to hear it.
    expect(cyrillize("commit")).toBe("коммит");
    expect(cyrillize("build")).toBe("билд");
    expect(cyrillize("timeout")).toBe("таймаут");
    expect(cyrillize("fallback")).toBe("фоллбэк");
  });

  test("case does not change the word", () => {
    expect(cyrillize("Docker")).toBe("докер");
    expect(cyrillize("DOCKER".toLowerCase())).toBe("докер");
  });

  test("acronyms are spelled, not sounded", () => {
    // `ASM` sounded out is `асм`, which is not what anyone says out loud.
    expect(cyrillize("ASM")).toBe("эй-эс-эм");
    expect(cyrillize("XZ")).toBe("экс-зед");
  });

  test("but an acronym said as a word stays a word", () => {
    expect(cyrillize("API")).toBe("апи");
    expect(cyrillize("JSON")).toBe("джейсон");
  });

  test("camelCase is split before it is sounded", () => {
    // One long invented word is harder to recognise than two known ones.
    expect(cyrillize("TranscriptTail")).toBe("транскрипт тэйл");
    expect(cyrillize("stackUp")).toBe("стек ап");
  });

  test("the letter rules are longest-match", () => {
    // `sh` must win over `s`, and `tion` over `ti`.
    expect(soundOut("ship")).toBe("шип");
    expect(soundOut("action")).toBe("акшн");
    expect(soundOut("phone")).toBe("фоне");
  });
});

describe("what it does to a whole message", () => {
  test("a mixed sentence stays readable", () => {
    const out = cyrillize("Пересобрал через docker compose, но channel остался старым.");
    expect(out).toContain("докер");
    expect(out).toContain("компоуз");
    expect(out).toContain("чэннел");
    expect(out).toContain("Пересобрал через");
    expect(hasLatin(out)).toBe(false);
  });

  test("an empty string is not a special case", () => {
    expect(cyrillize("")).toBe("");
  });

  test("text with no Latin costs nothing and changes nothing", () => {
    const only = "просто русский текст без единого латинского слова";
    expect(cyrillize(only)).toBe(only);
  });
});
