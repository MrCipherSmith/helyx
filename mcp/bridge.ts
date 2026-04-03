import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Maps client_id (session UUID) -> McpServer instance
const mcpServers = new Map<string, McpServer>();

export function registerMcpSession(clientId: string, server: McpServer): void {
  mcpServers.set(clientId, server);
}

export function unregisterMcpSession(clientId: string): void {
  mcpServers.delete(clientId);
}

export function getMcpServer(clientId: string): McpServer | undefined {
  return mcpServers.get(clientId);
}

export async function sendNotificationToSession(
  clientId: string,
  chatId: string,
  fromUser: string,
  text: string,
  metadata?: Record<string, unknown>,
): Promise<boolean> {
  const server = mcpServers.get(clientId);
  if (!server) {
    console.error(`[bridge] no server for clientId=${clientId}, known keys: [${[...mcpServers.keys()].join(", ")}]`);
    return false;
  }

  try {
    // Use the experimental claude/channel notification — same as official Telegram plugin
    await server.server.notification({
      method: "notifications/claude/channel",
      params: {
        content: text,
        meta: {
          chat_id: chatId,
          user: fromUser,
          ts: new Date().toISOString(),
          ...(metadata?.messageId
            ? { message_id: String(metadata.messageId) }
            : {}),
        },
      },
    });
    return true;
  } catch (err) {
    console.error(`[bridge] failed to notify session ${clientId}:`, err);
    return false;
  }
}
