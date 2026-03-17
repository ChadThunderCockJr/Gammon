import { useCallback, useEffect, useRef, useState } from "react";

type ServerMessage = Record<string, unknown> & { type: string };

const BACKOFF_INITIAL_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const BACKOFF_JITTER = 0.25;
const MAX_RETRIES = 50;

export function useWebSocket(url: string) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const handlersRef = useRef<Map<string, Set<(msg: ServerMessage) => void>>>(
    new Map(),
  );
  const retryCountRef = useRef(0);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      retryCountRef.current = 0;
      setConnected(true);
    };
    ws.onclose = () => {
      setConnected(false);
      if (retryCountRef.current >= MAX_RETRIES) return;
      const base = Math.min(
        BACKOFF_INITIAL_MS * Math.pow(2, retryCountRef.current),
        BACKOFF_MAX_MS,
      );
      const jitter = base * BACKOFF_JITTER * (Math.random() * 2 - 1);
      const delay = Math.max(0, base + jitter);
      retryCountRef.current += 1;
      setTimeout(connect, delay);
    };
    ws.onmessage = (event) => {
      try {
        const data =
          typeof event.data === "string" ? event.data : String(event.data);
        const msg = JSON.parse(data) as ServerMessage;
        const handlers = handlersRef.current.get(msg.type);
        if (handlers) {
          handlers.forEach((h) => h(msg));
        }
        const allHandlers = handlersRef.current.get("*");
        if (allHandlers) {
          allHandlers.forEach((h) => h(msg));
        }
      } catch {
        /* ignore parse errors */
      }
    };
  }, [url]);

  const disconnect = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
  }, []);

  const sendMessage = useCallback((msg: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const on = useCallback(
    (type: string, handler: (msg: ServerMessage) => void) => {
      if (!handlersRef.current.has(type)) {
        handlersRef.current.set(type, new Set());
      }
      handlersRef.current.get(type)!.add(handler);
      return () => {
        handlersRef.current.get(type)?.delete(handler);
      };
    },
    [],
  );

  useEffect(() => {
    return () => {
      wsRef.current?.close();
    };
  }, []);

  return { connect, disconnect, sendMessage, connected, on };
}
