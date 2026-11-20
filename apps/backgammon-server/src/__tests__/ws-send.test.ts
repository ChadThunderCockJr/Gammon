import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_WEBSOCKET_BUFFERED_BYTES,
  sendWebSocketData,
  sendWebSocketJson,
} from "../ws-send.js";

function socket(input?: { bufferedAmount?: number; sendError?: Error }) {
  const fake = {
    readyState: WebSocket.OPEN,
    bufferedAmount: input?.bufferedAmount ?? 0,
    send: vi.fn((_data: string, callback?: (error?: Error) => void) => callback?.(input?.sendError)),
    close: vi.fn(function close(this: { readyState: number }) {
      this.readyState = WebSocket.CLOSED;
    }),
    terminate: vi.fn(),
  };
  return { fake, ws: fake as unknown as WebSocket };
}

describe("bounded websocket sends", () => {
  it("serializes and delivers a normal JSON message", () => {
    const { fake, ws } = socket();

    expect(sendWebSocketJson(ws, { type: "profile_updated", address: "xion1player" })).toBe(true);
    expect(fake.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "profile_updated", address: "xion1player" }),
      expect.any(Function),
    );
    expect(fake.close).not.toHaveBeenCalled();
  });

  it("closes a slow consumer before the queued bytes cross the ceiling", () => {
    const { fake, ws } = socket({ bufferedAmount: MAX_WEBSOCKET_BUFFERED_BYTES - 1 });

    expect(sendWebSocketData(ws, "ab")).toBe(false);
    expect(fake.send).not.toHaveBeenCalled();
    expect(fake.close).toHaveBeenCalledWith(1013, "Client is not reading messages");
  });

  it("terminates a socket whose send callback reports failure", () => {
    const { fake, ws } = socket({ sendError: new Error("write failed") });

    expect(sendWebSocketData(ws, "message")).toBe(true);
    expect(fake.terminate).toHaveBeenCalledOnce();
  });
});
