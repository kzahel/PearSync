import { useState } from "react";
import type { PeerInfo } from "../api";
import styles from "./PeerList.module.css";

interface PeerListProps {
  peers: PeerInfo[];
}

export function PeerList({ peers }: PeerListProps) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const handleCopy = async (key: string) => {
    await navigator.clipboard.writeText(key);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  if (peers.length === 0) {
    return <div className={styles.empty}>No peers connected</div>;
  }

  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>Peer</th>
          <th>Writer Key</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {peers.map((peer) => (
          <tr key={peer.writerKey}>
            <td>
              {peer.name}
              {peer.isLocal && <span className={styles.localTag}>you</span>}
            </td>
            <td>
              <button
                type="button"
                className={styles.writerKey}
                onClick={() => handleCopy(peer.writerKey)}
                title={copiedKey === peer.writerKey ? "Copied!" : "Click to copy"}
              >
                {peer.writerKey.slice(0, 16)}...
              </button>
            </td>
            <td>
              <span
                className={`${styles.statusDot} ${peer.isConnected ? styles.online : styles.offline}`}
              />
              {peer.isConnected ? "Online" : "Offline"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
