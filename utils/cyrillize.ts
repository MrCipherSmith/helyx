/**
 * Latin script, written the way the Russian voice can say it.
 *
 * The Russian Piper model has no Latin letters in its phoneme inventory. Given
 * `docker compose`, it does not read it badly — it reads it as nothing, or
 * spells the characters, or drops the word. Which is why a status message full
 * of tool names came out as mush the moment Yandex stopped answering: Yandex
 * handled mixed script, and it was first in the chain for exactly that reason.
 *
 * ## Why this is code and not a prompt rule
 *
 * The prompt was tried first, and measured. Across five real sentences from the
 * operator's own traffic:
 *
 *   llama-3.1-8b-instant   162ms   124 Latin characters left, and it translated
 *                                  `--build` into `--строить`
 *   qwen3.6-27b            153ms    47 left
 *   llama-3.3-70b          273ms    33 left, plus one Arabic character
 *   gpt-oss-20b            789ms    68 left
 *   gemma4:e4b (local)   11413ms   119 left
 *
 * Not one of them cleared the text, and the instruction telling them to was
 * explicit and repeated. An invariant that must hold every time does not belong
 * in a sampled process. The model keeps the job it is good at — paths,
 * camelCase, structure, prose — and this guarantees what has to be guaranteed.
 *
 * It is also free and local, which is what the model measurements said the
 * alternative was not: the fastest local option was seventy times slower than
 * the remote one and still left the Latin in.
 *
 * ## What it is not
 *
 * Not a translation. `commit` becomes `коммит`, never `фиксация` — the operator
 * says these words in English and needs to hear the word they said. Not a
 * transcription standard either; the target is one listener hearing a term they
 * already know, so a rough phonetic match beats a scholarly one.
 */

/**
 * Terms worth spelling by hand.
 *
 * Everything here would otherwise go through the letter rules below and come
 * out wrong in a specific, recognisable way — `docker` reads as `доскер`,
 * `commit` as `комммит`. These are the words this project actually says.
 */
const TERMS: Record<string, string> = {
  // Containers and infrastructure
  docker: "докер", compose: "компоуз", container: "контейнер", image: "имидж",
  postgres: "постгрес", postgresql: "постгрескуэль", redis: "редис", nginx: "энджинкс",
  systemd: "системди", daemon: "демон", host: "хост", localhost: "локалхост",
  // Git
  commit: "коммит", branch: "бранч", merge: "мёрдж", rebase: "ребейз",
  push: "пуш", pull: "пул", repo: "репо", repository: "репозиторий", diff: "дифф",
  // Runtime
  build: "билд", deploy: "деплой", restart: "рестарт", timeout: "таймаут",
  fallback: "фоллбэк", cache: "кэш", queue: "очередь", buffer: "буфер",
  status: "статус", health: "хелс", probe: "проба", alert: "алерт",
  process: "процесс", service: "сервис", server: "сервер", client: "клиент",
  config: "конфиг", update: "апдейт", check: "чек", checks: "чекс",
  worker: "воркер", port: "порт", full: "фул", start: "старт", stop: "стоп",
  monitor: "монитор", supervisor: "супервайзер", watchdog: "вотчдог",
  session: "сешн", channel: "чэннел", transcript: "транскрипт", token: "токен",
  // Code
  bot: "бот", script: "скрипт", test: "тест", tests: "тесты", prompt: "промпт",
  callback: "колбэк", endpoint: "эндпоинт", request: "реквест", response: "респонс",
  error: "эрор", warning: "ворнинг", log: "лог", logs: "логи", debug: "дебаг",
  patch: "патч", stack: "стек", trace: "трейс", thread: "тред", chunk: "чанк",
  // Products
  telegram: "телеграм", yandex: "яндекс", claude: "клод", anthropic: "антропик",
  piper: "пайпер", groq: "грок", ollama: "оллама", openai: "оупенэйай",
  github: "гитхаб", speechkit: "спичкит", whisper: "виспер",
  // Acronyms that are said as words, not spelled
  api: "апи", json: "джейсон", jsonl: "джейсонэль", url: "урл", tts: "тэ-тэ-эс",
  id: "айди", db: "бэдэ", sql: "эскьюэль", http: "эйч-ти-ти-пи", https: "эйч-ти-ти-пи-эс",
  mcp: "эм-си-пи", cli: "си-эл-ай", ui: "юай", ok: "окей",
  // Common short words that the letter rules mangle
  up: "ап", down: "даун", now: "нау", new: "нью", one: "уан", to: "ту", the: "зэ",
  file: "файл", name: "нейм", time: "тайм", type: "тайп", key: "кей", value: "вэлью",
};

/** How a Latin letter is named when an unknown acronym is spelled out. */
const LETTER_NAMES: Record<string, string> = {
  a: "эй", b: "би", c: "си", d: "ди", e: "и", f: "эф", g: "джи", h: "эйч",
  i: "ай", j: "джей", k: "кей", l: "эл", m: "эм", n: "эн", o: "оу", p: "пи",
  q: "кью", r: "ар", s: "эс", t: "ти", u: "ю", v: "ви", w: "дабл-ю",
  x: "экс", y: "уай", z: "зед",
};

/**
 * Sound rules, longest first.
 *
 * English spelling is not phonetic, so this is an approximation and is meant to
 * be one: the listener already knows the word and needs a recognisable shape,
 * not a correct one. Order is the whole mechanism — `tion` must be consumed
 * before `ti`, and `sh` before `s`.
 */
const SOUNDS: Array<[string, string]> = [
  ["tion", "шн"], ["sion", "жн"], ["ough", "аф"], ["igh", "ай"],
  ["tch", "ч"], ["sch", "ск"], ["shi", "ши"],
  ["ch", "ч"], ["sh", "ш"], ["ph", "ф"], ["th", "т"], ["ck", "к"], ["qu", "кв"],
  ["wh", "в"], ["gh", "г"], ["kn", "н"], ["wr", "р"],
  ["oo", "у"], ["ee", "и"], ["ea", "и"], ["ie", "и"], ["oa", "оу"],
  ["ou", "ау"], ["ow", "ау"], ["ai", "эй"], ["ay", "эй"], ["ey", "эй"],
  ["oi", "ой"], ["oy", "ой"], ["au", "о"], ["aw", "о"], ["ew", "ю"],
  ["ing", "инг"], ["age", "идж"], ["ure", "ур"],
  ["ss", "с"], ["ll", "л"], ["tt", "т"], ["mm", "м"], ["nn", "н"], ["pp", "п"],
  ["ff", "ф"], ["cc", "к"], ["dd", "д"], ["gg", "г"], ["bb", "б"], ["rr", "р"],
  ["zz", "з"], ["ce", "с"], ["ci", "си"], ["ge", "дж"], ["gi", "джи"],
  ["a", "а"], ["b", "б"], ["c", "к"], ["d", "д"], ["e", "е"], ["f", "ф"],
  ["g", "г"], ["h", "х"], ["i", "и"], ["j", "дж"], ["k", "к"], ["l", "л"],
  ["m", "м"], ["n", "н"], ["o", "о"], ["p", "п"], ["q", "к"], ["r", "р"],
  ["s", "с"], ["t", "т"], ["u", "у"], ["v", "в"], ["w", "в"], ["x", "кс"],
  ["y", "й"], ["z", "з"],
];

/** One Latin word, by sound. Assumes lowercase input with no Cyrillic in it. */
export function soundOut(word: string): string {
  let out = "";
  let i = 0;
  outer: while (i < word.length) {
    for (const [pattern, sound] of SOUNDS) {
      if (word.startsWith(pattern, i)) {
        out += sound;
        i += pattern.length;
        continue outer;
      }
    }
    // Not a Latin letter — a digit or a mark that survived the split.
    out += word[i];
    i++;
  }
  return out;
}

/**
 * An all-caps run is an acronym, and acronyms are spelled, not sounded.
 *
 * `ASM` read by the sound rules becomes `асм`, which is not what anyone says.
 * Two letters is the floor: a single capital is more often the start of a name.
 */
function isAcronym(word: string): boolean {
  return word.length >= 2 && word.length <= 6 && /^[A-Z]+$/.test(word);
}

function spellOut(word: string): string {
  return word.toLowerCase().split("").map((c) => LETTER_NAMES[c] ?? c).join("-");
}

/**
 * Split a camelCase or PascalCase run into its words.
 *
 * The normalizer is asked to do this and usually does; this is here for what
 * reaches us anyway, because `TranscriptTail` sounded out as one word is worse
 * than two.
 */
function splitCamel(word: string): string[] {
  return word.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" ").filter(Boolean);
}

/**
 * Rewrite every Latin word in `text` as Cyrillic.
 *
 * Digits, punctuation and existing Cyrillic pass through untouched — this only
 * ever replaces runs of `[A-Za-z]`, so a number stays a number and the
 * normalizer's work upstream is not undone.
 */
export function cyrillize(text: string): string {
  // An underscore joining two words is a word boundary that the voice reads as
  // silence in the middle of a term — `стек_ап` comes out as two fragments. The
  // normalizer is asked to do this and mostly does; `stack_up` and
  // `callback_data` came back untouched from the models that were measured.
  return text.replace(/(\w)_(\w)/g, "$1 $2").replace(/[A-Za-z]+/g, (word) => {
    const known = TERMS[word.toLowerCase()];
    if (known) return known;

    if (isAcronym(word)) return spellOut(word);

    const parts = splitCamel(word);
    if (parts.length > 1) {
      return parts.map((p) => TERMS[p.toLowerCase()] ?? (isAcronym(p) ? spellOut(p) : soundOut(p.toLowerCase()))).join(" ");
    }

    return soundOut(word.toLowerCase());
  });
}

/** Whether any Latin letter is left. The invariant this module exists to hold. */
export function hasLatin(text: string): boolean {
  return /[A-Za-z]/.test(text);
}
