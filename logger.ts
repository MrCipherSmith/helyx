import pino from "pino";

/**
 * Shared structured logger. Uses LOG_LEVEL env var (default: info).
 * In MCP stdio mode (channel processes), use channelLogger which writes to stderr.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
});

/**
 * Logger for channel subprocess — writes to stderr (fd 2) so stdout
 * remains clean for the MCP JSON-RPC transport.
 */
export const channelLogger = pino(
  { level: process.env.LOG_LEVEL ?? "info" },
  pino.destination(2),
);

export type Logger = pino.Logger;
