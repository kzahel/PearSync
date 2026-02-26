import { useMemo, useState } from "react";
import type { FileInfo } from "../api";
import styles from "./FileTable.module.css";

interface FileTableProps {
  files: FileInfo[];
}

type SortKey = "path" | "size" | "mtime" | "syncState" | "peerName";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} hr ago`;
  return new Date(ms).toLocaleDateString();
}

export function FileTable({ files }: FileTableProps) {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("path");
  const [sortAsc, setSortAsc] = useState(true);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return files.filter((f) => f.path.toLowerCase().includes(q));
  }, [files, search]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    copy.sort((a, b) => {
      let cmp = 0;
      if (sortKey === "size" || sortKey === "mtime") {
        cmp = a[sortKey] - b[sortKey];
      } else {
        cmp = a[sortKey].localeCompare(b[sortKey]);
      }
      return sortAsc ? cmp : -cmp;
    });
    return copy;
  }, [filtered, sortKey, sortAsc]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortAsc((v) => !v);
    } else {
      setSortKey(key);
      setSortAsc(true);
    }
  };

  const arrow = (key: SortKey) => {
    if (sortKey !== key) return "";
    return sortAsc ? " \u25B2" : " \u25BC";
  };

  const totalSize = files.reduce((s, f) => s + f.size, 0);

  const dotClass = (state: FileInfo["syncState"]) => {
    switch (state) {
      case "synced":
        return styles.synced;
      case "syncing":
        return styles.syncingDot;
      case "conflict":
        return styles.conflictDot;
      default:
        return styles.localOnly;
    }
  };

  return (
    <div className={styles.container}>
      <input
        className={styles.search}
        type="text"
        placeholder="Filter files..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {sorted.length === 0 ? (
        <div className={styles.empty}>
          {files.length === 0 ? "No files synced yet" : "No files match filter"}
        </div>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th onClick={() => handleSort("path")}>
                Name<span className={styles.sortArrow}>{arrow("path")}</span>
              </th>
              <th onClick={() => handleSort("size")}>
                Size<span className={styles.sortArrow}>{arrow("size")}</span>
              </th>
              <th onClick={() => handleSort("mtime")}>
                Modified<span className={styles.sortArrow}>{arrow("mtime")}</span>
              </th>
              <th onClick={() => handleSort("syncState")}>
                Status<span className={styles.sortArrow}>{arrow("syncState")}</span>
              </th>
              <th onClick={() => handleSort("peerName")}>
                Peer<span className={styles.sortArrow}>{arrow("peerName")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((file) => (
              <tr key={file.path} data-testid="file-row">
                <td>{file.path}</td>
                <td>{formatSize(file.size)}</td>
                <td>{formatTime(file.mtime)}</td>
                <td>
                  <span className={`${styles.statusDot} ${dotClass(file.syncState)}`} />
                  {file.syncState}
                </td>
                <td className={styles.mono}>{file.peerName}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className={styles.footer}>
        {files.length} file{files.length !== 1 ? "s" : ""}, {formatSize(totalSize)} total
      </div>
    </div>
  );
}
