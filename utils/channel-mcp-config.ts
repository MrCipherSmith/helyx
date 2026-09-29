/**
 * The helyx-channel MCP server's config, as an `--mcp-config` file rather
 * than a Claude Code global (`-s user`) registration.
 *
 * Extracted from cli.ts (which cannot be imported — it ends in a top-level
 * switch on process.argv) so this shape is pinned by a test rather than only
 * by reading it.
 */
export interface ChannelMcpConfig {
  mcpServers: {
    "helyx-channel": {
      type: "stdio";
      command: "bun";
      args: [string];
      env: { DATABASE_URL: string; OLLAMA_URL: string; TELEGRAM_BOT_TOKEN: string };
    };
  };
}

export function channelMcpConfig(botDir: string, dbUrl: string, ollamaUrl: string, botToken: string): ChannelMcpConfig {
  return {
    mcpServers: {
      "helyx-channel": {
        type: "stdio",
        command: "bun",
        args: [`${botDir}/channel.ts`],
        env: { DATABASE_URL: dbUrl, OLLAMA_URL: ollamaUrl, TELEGRAM_BOT_TOKEN: botToken },
      },
    },
  };
}
