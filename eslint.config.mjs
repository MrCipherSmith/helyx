import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// Flat config. `keryx health` runs `eslint . --format json` with no extra
// flags, so every exclusion has to live here rather than on a command line.
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/*.d.ts",
      // Generated or vendored, not authored here.
      ".metaproject/**",
      "graphify-out/**",
      "piper/**",
      "assets/**",
      // Runtime state, not source.
      "logs/**",
      "downloads/**",
      "sessions/**",
      ".auth/**",
      ".empty/**",
      "tmux-projects.json/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // Unused bindings are a real signal, but a leading underscore is the
      // established way to say "deliberately unused" — and an unused caught
      // error is idiomatic in the many `catch {}` swallows below.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],

      // `any` is a strictness goal, not a defect. 213 of them exist today;
      // erroring would bury every genuine finding under them, so it warns
      // (health scores warnings P2) and the count can come down over time.
      "@typescript-eslint/no-explicit-any": "warn",

      // An empty catch is how this codebase says "best effort, never fatal" —
      // TTS, Telegram edits, pane reads. Other empty blocks stay errors.
      "no-empty": ["error", { allowEmptyCatch: true }],

      // The bot parses tmux panes and ANSI-coloured CLI output; control
      // characters in a regex are the job, not a mistake.
      "no-control-regex": "off",

      // `ok ? done() : fail()` is the wizard's house style for a step result.
      // Short-circuits are the same idea. Bare expressions stay errors.
      "@typescript-eslint/no-unused-expressions": [
        "error",
        { allowTernary: true, allowShortCircuit: true },
      ],

      // Warn, not error. In classes like [a-zA-Z0-9._\-\/~^:] the backslash
      // before `-` is what stops `_` and `/` being read as a range — dropping
      // it turns a path-validation regex into a SyntaxError. The rule cannot
      // see that, and these regexes guard path traversal.
      "no-useless-escape": "warn",

      // Warn, not error: the rule misreads `let x = null` followed by a
      // try/catch that reassigns it — the initializer is exactly what the
      // catch path falls back to. Left visible because the genuine cases
      // (a value computed and then thrown away) are worth seeing.
      "no-useless-assignment": "warn",
    },
  },
);
