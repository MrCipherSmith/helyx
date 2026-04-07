// Manages SSE client connections and broadcasts events to all connected clients

type SSEClient = {
  id: string;
  send: (event: string, data: unknown) => void;
  close: () => void;
};

const clients = new Map<string, SSEClient>();

export function addSSEClient(client: SSEClient): void {
  clients.set(client.id, client);
  console.log(`[sse] client connected: ${client.id} (total: ${clients.size})`);
}

export function removeSSEClient(id: string): void {
  clients.delete(id);
  console.log(`[sse] client disconnected: ${id} (total: ${clients.size})`);
}

export function broadcast(event: string, data: unknown): void {
  if (clients.size === 0) return;
  for (const client of clients.values()) {
    try {
      client.send(event, data);
    } catch {
      // Client disconnected — will be cleaned up on next req.close event
    }
  }
}

export function getSSEClientCount(): number {
  return clients.size;
}
