import WebSocket from "ws";

export const MAX_WEBSOCKET_BUFFERED_BYTES = 1_048_576;
const SLOW_CONSUMER_TERMINATION_MS = 1_000;
const closingSlowConsumers = new WeakSet<WebSocket>();

function closeSlowConsumer(ws: WebSocket): void {
  if (closingSlowConsumers.has(ws)) return;
  closingSlowConsumers.add(ws);
  try {
    ws.close(1013, "Client is not reading messages");
  } catch {
    ws.terminate();
    return;
  }
  const timer = setTimeout(() => {
    if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
  }, SLOW_CONSUMER_TERMINATION_MS);
  timer.unref();
}

export function sendWebSocketData(ws: WebSocket, data: string): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  const byteLength = Buffer.byteLength(data);
  if (
    byteLength > MAX_WEBSOCKET_BUFFERED_BYTES
    || ws.bufferedAmount + byteLength > MAX_WEBSOCKET_BUFFERED_BYTES
  ) {
    closeSlowConsumer(ws);
    return false;
  }
  try {
    ws.send(data, (error) => {
      if (error && ws.readyState !== WebSocket.CLOSED) ws.terminate();
    });
    return true;
  } catch {
    ws.terminate();
    return false;
  }
}

export function sendWebSocketJson(ws: WebSocket, value: unknown): boolean {
  try {
    const data = JSON.stringify(value);
    return typeof data === "string" && sendWebSocketData(ws, data);
  } catch {
    return false;
  }
}
