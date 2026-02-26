import { useCallback, useState } from "react";
import { type FileInfo, getFiles, getPeers, type PeerInfo } from "../api";
import { useApi } from "../hooks/useApi";
import { useEvents } from "../hooks/useEvents";
import { useWebSocket, type WsMessage } from "../hooks/useWebSocket";
import { ConflictList } from "./ConflictList";
import styles from "./Dashboard.module.css";
import { EventLog } from "./EventLog";
import { FileTable } from "./FileTable";
import { InviteModal } from "./InviteModal";
import { PeerList } from "./PeerList";
import { StatusBar } from "./StatusBar";

type Tab = "files" | "peers" | "activity" | "conflicts";

export function Dashboard() {
  const [tab, setTab] = useState<Tab>("files");
  const [showInvite, setShowInvite] = useState(false);

  const { data: files, refetch: refetchFiles } = useApi<FileInfo[]>(getFiles, 5000);
  const { data: peers, refetch: refetchPeers } = useApi<PeerInfo[]>(getPeers, 5000);
  const events = useEvents();

  // Refetch data when sync events arrive via WebSocket
  const onWsMessage = useCallback(
    (msg: WsMessage) => {
      if (msg.type === "sync") {
        refetchFiles();
        refetchPeers();
      }
    },
    [refetchFiles, refetchPeers],
  );
  useWebSocket(onWsMessage);

  const tabClass = (t: Tab) => `${styles.tab} ${tab === t ? styles.tabActive : ""}`;

  return (
    <div className={styles.dashboard}>
      <StatusBar peerCount={peers?.length ?? 0} fileCount={files?.length ?? 0} />
      <div className={styles.tabBar}>
        <button type="button" className={tabClass("files")} onClick={() => setTab("files")}>
          Files
        </button>
        <button type="button" className={tabClass("peers")} onClick={() => setTab("peers")}>
          Peers
        </button>
        <button type="button" className={tabClass("activity")} onClick={() => setTab("activity")}>
          Activity
        </button>
        <button type="button" className={tabClass("conflicts")} onClick={() => setTab("conflicts")}>
          Conflicts
        </button>
        <span className={styles.tabSpacer} />
        <button type="button" className={styles.inviteBtn} onClick={() => setShowInvite(true)}>
          + Invite
        </button>
      </div>
      <div className={styles.content}>
        {tab === "files" && <FileTable files={files ?? []} />}
        {tab === "peers" && <PeerList peers={peers ?? []} />}
        {tab === "activity" && <EventLog events={events} />}
        {tab === "conflicts" && <ConflictList files={files ?? []} />}
      </div>
      {showInvite && <InviteModal onClose={() => setShowInvite(false)} />}
    </div>
  );
}
