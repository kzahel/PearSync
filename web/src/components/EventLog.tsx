import { useEffect, useRef, useState } from "react";
import type { AppEvent } from "../api";
import styles from "./EventLog.module.css";

interface EventLogProps {
  events: AppEvent[];
}

const EVENT_TYPES = [
  "upload",
  "download",
  "delete",
  "conflict",
  "error",
  "peer-join",
  "peer-leave",
] as const;

const ICONS: Record<string, string> = {
  upload: "\u2191",
  download: "\u2193",
  delete: "\u2716",
  conflict: "\u26A0",
  error: "\u2718",
  "peer-join": "\u25CF",
  "peer-leave": "\u25CB",
};

const STYLE_MAP: Record<string, string> = {
  upload: styles.upload,
  download: styles.download,
  delete: styles.delete,
  conflict: styles.conflict,
  error: styles.error,
  "peer-join": styles.peerEvent,
  "peer-leave": styles.peerEvent,
};

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString("en-US", { hour12: false });
}

export function EventLog({ events }: EventLogProps) {
  const [filters, setFilters] = useState<Set<string>>(new Set(EVENT_TYPES));
  const [autoScroll, setAutoScroll] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);

  const toggleFilter = (type: string) => {
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  };

  const filtered = events.filter((e) => filters.has(e.type));

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new events
  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = 0;
    }
  }, [events.length, autoScroll]);

  if (events.length === 0) {
    return <div className={styles.empty}>No activity yet</div>;
  }

  return (
    <div className={styles.container}>
      <div className={styles.filters}>
        {EVENT_TYPES.map((type) => (
          <label key={type} className={styles.filterLabel}>
            <input
              type="checkbox"
              checked={filters.has(type)}
              onChange={() => toggleFilter(type)}
            />
            {type}
          </label>
        ))}
        <button type="button" className={styles.pauseBtn} onClick={() => setAutoScroll((v) => !v)}>
          {autoScroll ? "Pause" : "Resume"}
        </button>
      </div>
      <div className={styles.log} ref={logRef}>
        {filtered.map((event) => (
          <div key={event.id} className={styles.entry} data-testid="event-row">
            <span className={styles.time}>{formatTimestamp(event.timestamp)}</span>
            <span className={`${styles.icon} ${STYLE_MAP[event.type] ?? ""}`}>
              {ICONS[event.type] ?? "?"}
            </span>
            <span className={styles.detail}>{event.detail}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
