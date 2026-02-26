import { useEffect, useRef } from "react";
import { runtime } from "../runtime";
import { subscribeToPush } from "../transport";

export interface WsMessage {
  type: "sync" | "status" | "peer" | "error" | "stats";
  payload: unknown;
  timestamp: number;
}

export function useWebSocket(onMessage: (msg: WsMessage) => void) {
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    // In Pear mode, use pipe transport for push messages
    if (runtime.isPear) {
      const unsub = subscribeToPush((msg) => {
        onMessageRef.current(msg as WsMessage);
      });
      return () => {
        if (unsub) unsub();
      };
    }

    // HTTP mode: use WebSocket
    let ws: WebSocket | null = null;
    let reconnectDelay = 1000;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    function connect() {
      if (stopped) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

      ws.onopen = () => {
        reconnectDelay = 1000;
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as WsMessage;
          onMessageRef.current(msg);
        } catch {
          // ignore malformed messages
        }
      };

      ws.onerror = (event) => {
        console.error("[ws] connection error:", event);
      };

      ws.onclose = () => {
        if (stopped) return;
        reconnectTimer = setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 2, 30000);
          connect();
        }, reconnectDelay);
      };
    }

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) ws.close();
    };
  }, []);
}
