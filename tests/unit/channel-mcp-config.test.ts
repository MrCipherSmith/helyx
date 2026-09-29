import { describe, test, expect } from "bun:test";
import { channelMcpConfig } from "../../utils/channel-mcp-config.ts";

describe("channelMcpConfig", () => {
  test("shapes a stdio server entry --mcp-config can load", () => {
    const cfg = channelMcpConfig("/home/altsay/bots/helyx", "postgres://x", "http://localhost:11434", "bot-token");

    expect(cfg).toEqual({
      mcpServers: {
        "helyx-channel": {
          type: "stdio",
          command: "bun",
          args: ["/home/altsay/bots/helyx/channel.ts"],
          env: {
            DATABASE_URL: "postgres://x",
            OLLAMA_URL: "http://localhost:11434",
            TELEGRAM_BOT_TOKEN: "bot-token",
          },
        },
      },
    });
  });

  test("the server key is exactly what --dangerously-load-development-channels server:helyx-channel names", () => {
    // run-cli.sh references this server by that literal name; a rename here
    // without a matching rename there is a session that never connects.
    const cfg = channelMcpConfig("/x", "d", "o", "t");
    expect(Object.keys(cfg.mcpServers)).toEqual(["helyx-channel"]);
  });
});
