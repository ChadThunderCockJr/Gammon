import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

type ServerMessage = Record<string, unknown> & { type: string };
const ServerMessageSchema = z.object({ type: z.string() }).catchall(z.unknown());

const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const BACKOFF_JITTER = 0.25;
const MAX_RETRIES = 50;

export function useWebSocket(url: string) {
  const wsRef = useRef<WebSocket | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const shouldReconnectRef = useRef(false);
  const [connected, setConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<ServerMessage | null>(null);
  const handlersRef = useRef<Map<string, Set<(message: ServerMessage) => void>>>(new Map());
  const retryCountRef = useRef(0);
  const connectRef = useRef<() => void>(() => undefined);

  const connect = useCallback(() => {
    shouldReconnectRef.current = true;
    if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) return;
    const ws = new WebSocket(url);
    wsRef.current = ws;
    ws.onopen = () => {
      retryCountRef.current = 0;
      setConnected(true);
    };
    ws.onclose = () => {
      if (wsRef.current !== ws) return;
      wsRef.current = null;
      setConnected(false);
      if (!shouldReconnectRef.current || retryCountRef.current >= MAX_RETRIES) return;
      const base = Math.min(BACKOFF_INITIAL_MS * Math.pow(2, retryCountRef.current), BACKOFF_MAX_MS);
      const jitter = base * BACKOFF_JITTER * (Math.random() * 2 - 1);
      retryCountRef.current += 1;
      retryTimerRef.current = window.setTimeout(() => connectRef.current(), Math.max(0, base + jitter));
    };
    ws.onmessage = (event) => {
      try {
        const result = ServerMessageSchema.safeParse(JSON.parse(String(event.data)));
        if (!result.success) return;
        const message = result.data as ServerMessage;
        setLastMessage(message);
        handlersRef.current.get(message.type)?.forEach((handler) => handler(message));
        handlersRef.current.get("*")?.forEach((handler) => handler(message));
      } catch {
        return;
      }
    };
  }, [url]);
  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  const disconnect = useCallback(() => {
    shouldReconnectRef.current = false;
    if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
    wsRef.current?.close();
    wsRef.current = null;
    setConnected(false);
  }, []);

  const sendMessage = useCallback((message: Record<string, unknown>): boolean => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return false;
    wsRef.current.send(JSON.stringify(message));
    return true;
  }, []);

  const on = useCallback((type: string, handler: (message: ServerMessage) => void) => {
    if (!handlersRef.current.has(type)) handlersRef.current.set(type, new Set());
    handlersRef.current.get(type)?.add(handler);
    return () => { handlersRef.current.get(type)?.delete(handler); };
  }, []);

  useEffect(() => disconnect, [disconnect]);

  return { connect, disconnect, sendMessage, connected, lastMessage, on };
}
