import type { FileInfo } from "../api";
import styles from "./ConflictList.module.css";

interface ConflictListProps {
  files: FileInfo[];
}

interface ConflictEntry {
  conflictPath: string;
  originalPath: string;
  peerName: string;
  date: string;
  file: FileInfo;
}

function parseConflict(file: FileInfo): ConflictEntry | null {
  const match = file.path.match(/(.+)\.conflict-(\d{4}-\d{2}-\d{2})-([^.]+)(\..*)?$/);
  if (!match) return null;
  const ext = match[4] ?? "";
  return {
    conflictPath: file.path,
    originalPath: match[1] + ext,
    date: match[2],
    peerName: match[3],
    file,
  };
}

export function ConflictList({ files }: ConflictListProps) {
  const conflicts = files.map(parseConflict).filter((c): c is ConflictEntry => c !== null);

  if (conflicts.length === 0) {
    return <div className={styles.empty}>No conflicts</div>;
  }

  return (
    <div className={styles.list}>
      {conflicts.map((c) => (
        <div key={c.conflictPath} className={styles.card}>
          <div className={styles.path}>{c.originalPath}</div>
          <div className={styles.meta}>
            <div>
              Conflict copy: <span className={styles.mono}>{c.conflictPath}</span>
            </div>
            <div>
              Peer: <span className={styles.mono}>{c.peerName}</span>
            </div>
            <div>Date: {c.date}</div>
          </div>
          <div className={styles.hint}>Delete the conflict copy once you've reviewed it.</div>
        </div>
      ))}
    </div>
  );
}
