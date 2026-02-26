import { useCallback, useEffect, useRef, useState } from "react";
import { type AppEvent, getEvents } from "../api";
import { useWebSocket, type WsMessage } from "./useWebSocket";

const MAX_EVENTS = 1000;

export function useEvents() {
  const [events, setEvents] = useState<AppEvent[]>([]);
  const nextIdRef = useRef(1);

  // Load initial events from REST API
  useEffect(() => {
    getEvents(100, 0).then((initial) => {
      setEvents(initial);
      if (initial.length > 0) {
        nextIdRef.current = Math.max(...initial.map((e) => e.id)) + 1;
      }
    });
  }, []);

  const onMessage = useCallback((msg: WsMessage) => {
    if (msg.type !== "sync" && msg.type !== "error") return;

    const payload = msg.payload as Record<string, unknown>;
    let type: AppEvent["type"];
    let detail: string;
    const path = payload.path as string | undefined;

    if (msg.type === "error") {
      type = "error";
      detail = (payload.message as string) ?? "Unknown error";
    } else {
      const action = payload.action as string;
      const direction = payload.direction as string;
      if (action === "conflict") {
        type = "conflict";
        detail = `Conflict: ${path} → ${payload.conflictPath}`;
      } else if (action === "delete") {
        type = "delete";
        detail = `Deleted ${path}`;
      } else if (direction === "up") {
        type = "upload";
        detail = `Uploaded ${path}`;
      } else {
        type = "download";
        detail = `Downloaded ${path}`;
      }
    }

    const event: AppEvent = {
      id: nextIdRef.current++,
      timestamp: msg.timestamp,
      type,
      path,
      detail,
    };

    setEvents((prev) => [event, ...prev].slice(0, MAX_EVENTS));
  }, []);

  useWebSocket(onMessage);

  return events;
}
