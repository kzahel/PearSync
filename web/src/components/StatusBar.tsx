import { getStatus, type StatusInfo } from "../api";
import { useApi } from "../hooks/useApi";
import { useTheme } from "../hooks/useTheme";
import styles from "./StatusBar.module.css";

interface StatusBarProps {
  peerCount: number;
  fileCount: number;
}

export function StatusBar({ peerCount, fileCount }: StatusBarProps) {
  const { data: status } = useApi<StatusInfo>(getStatus, 3000);
  const { theme, toggle } = useTheme();

  const state = status?.state ?? "idle";
  const folder = status?.folder ?? "";

  const badgeClass =
    state === "watching" ? styles.watching : state === "syncing" ? styles.syncing : styles.offline;

  const stateLabel = state === "watching" ? "Watching" : state === "syncing" ? "Syncing" : "Idle";

  return (
    <div className={styles.bar}>
      <span className={styles.appName}>PearSync</span>
      <span className={styles.folder}>{folder}</span>
      <span className={`${styles.badge} ${badgeClass}`}>
        <span className={styles.dot} />
        {stateLabel}
      </span>
      <span className={styles.stat}>
        {peerCount} peer{peerCount !== 1 ? "s" : ""}
      </span>
      <span className={styles.stat}>
        {fileCount} file{fileCount !== 1 ? "s" : ""}
      </span>
      <span className={styles.spacer} />
      <button type="button" className={styles.themeBtn} onClick={toggle} title="Toggle theme">
        {theme === "dark" ? "\u2600" : "\u263E"}
      </button>
    </div>
  );
}
