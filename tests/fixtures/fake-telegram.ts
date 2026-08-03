/**
 * A recording stand-in for `channel/telegram.ts`.
 *
 * The permission handler does not receive its Telegram client through the
 * context — it imports the functions directly — so this replaces the module
 * rather than injecting a double. That is the one place a module mock is the
 * honest tool: the alternative is threading a client parameter through
 * production code for the sake of the test, which changes the design to suit
 * the test rather than the other way round.
 *
 * The real module's other exports are preserved. Replacing a module wholesale
 * would leave every export this file does not name as `undefined` for whatever
 * else imports it in the same process, and a test file that quietly breaks a
 * different test file is worse than no fixture at all.
 */

import { mock } from "bun:test";

const TELEGRAM_MODULE = "../../channel/telegram.ts";

export interface SentMessage {
  chatId: string;
  text: string;
  extra: Record<string, unknown>;
}

export interface EditedMessage {
  chatId: string;
  messageId: number;
  text: string;
}

export interface DeletedMessage {
  chatId: string;
  messageId: number;
}

export type SendResult = { ok: boolean; messageId: number | null; errorBody?: string };

export class FakeTelegram {
  readonly sent: SentMessage[] = [];
  readonly edits: EditedMessage[] = [];
  readonly deletes: DeletedMessage[] = [];

  /**
   * What the next send returns. Replaceable, because "Telegram refused the
   * message" is a branch the handler has — it auto-denies rather than polling
   * for ten minutes — and the only way to reach it is to say no.
   */
  sendResult: SendResult | ((text: string) => SendResult) = () => ({
    ok: true,
    messageId: this.nextMessageId++,
  });

  private nextMessageId = 1000;

  /** Texts sent, in order — the usual assertion. */
  texts(): string[] {
    return this.sent.map((m) => m.text);
  }

  /** Did any message contain this substring? */
  sentContaining(needle: string): SentMessage[] {
    return this.sent.filter((m) => m.text.includes(needle));
  }

  /** Did any edit contain this substring? */
  editedContaining(needle: string): EditedMessage[] {
    return this.edits.filter((m) => m.text.includes(needle));
  }
}

/**
 * Install the fake and return it, together with the function that puts the real
 * module back.
 *
 * Restoring matters: `mock.module` is process-wide, and `bun test` runs files
 * in one process.
 */
export async function installFakeTelegram(): Promise<{ telegram: FakeTelegram; restore: () => void }> {
  const actual = await import(TELEGRAM_MODULE);
  const telegram = new FakeTelegram();

  mock.module(TELEGRAM_MODULE, () => ({
    ...actual,
    sendTelegramMessage: async (
      _token: string,
      chatId: string,
      text: string,
      extra: Record<string, unknown> = {},
    ): Promise<SendResult> => {
      telegram.sent.push({ chatId, text, extra });
      const result = telegram.sendResult;
      return typeof result === "function" ? result(text) : result;
    },
    editTelegramMessage: async (_token: string, chatId: string, messageId: number, text: string) => {
      telegram.edits.push({ chatId, messageId, text });
      return { ok: true };
    },
    deleteTelegramMessage: (_token: string, chatId: string, messageId: number) => {
      telegram.deletes.push({ chatId, messageId });
    },
  }));

  return {
    telegram,
    restore: () => {
      mock.module(TELEGRAM_MODULE, () => actual);
    },
  };
}
