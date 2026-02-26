import { useState } from "react";
import { pickFolder, previewSetup, type SetupPreviewResponse, setup } from "../api";
import { runtime } from "../runtime";
import styles from "./Setup.module.css";

interface SetupProps {
  onComplete: () => void;
}

export function Setup({ onComplete }: SetupProps) {
  const [folder, setFolder] = useState("~/PearSync");
  const [mode, setMode] = useState<"create" | "join">("create");
  const [inviteCode, setInviteCode] = useState("");
  const [startupConflictPolicy, setStartupConflictPolicy] = useState<
    "remote-wins" | "local-wins" | "keep-both"
  >("remote-wins");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [preview, setPreview] = useState<SetupPreviewResponse | null>(null);
  const handleBrowse = async () => {
    try {
      const { folder: picked } = await pickFolder();
      setFolder(picked);
    } catch {
      // User cancelled the dialog — ignore
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!folder.trim()) {
      setError("Folder path is required");
      return;
    }
    if (mode === "join" && !inviteCode.trim()) {
      setError("Invite code is required to join");
      return;
    }
    setError("");
    setLoading(true);
    try {
      await setup({
        folder: folder.trim(),
        mode,
        inviteCode: mode === "join" ? inviteCode.trim() : undefined,
        startupConflictPolicy: mode === "join" ? startupConflictPolicy : undefined,
      });
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handlePreview = async () => {
    if (!folder.trim()) {
      setError("Folder path is required");
      return;
    }
    if (!inviteCode.trim()) {
      setError("Invite code is required to preview join impact");
      return;
    }

    setError("");
    setPreviewLoading(true);
    try {
      const nextPreview = await previewSetup({
        folder: folder.trim(),
        mode: "join",
        inviteCode: inviteCode.trim(),
      });
      setPreview(nextPreview);
    } catch (err) {
      setPreview(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewLoading(false);
    }
  };

  return (
    <div className={styles.container} data-testid="setup-screen">
      <div className={styles.card}>
        <h1 className={styles.title}>PearSync</h1>
        <p className={styles.subtitle}>Peer-to-peer folder sync</p>
        <form onSubmit={handleSubmit}>
          <label className={styles.label} htmlFor="folder">
            Folder path
          </label>
          <div className={styles.folderRow}>
            <input
              id="folder"
              className={styles.input}
              type="text"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              placeholder="~/PearSync"
            />
            {runtime.canPickFolder && (
              <button type="button" className={styles.browseBtn} onClick={handleBrowse}>
                Browse
              </button>
            )}
          </div>

          <span className={styles.label}>Mode</span>
          <div className={styles.radioGroup}>
            <label className={styles.radioLabel}>
              <input
                type="radio"
                name="mode"
                checked={mode === "create"}
                onChange={() => setMode("create")}
              />
              Create new sync
            </label>
            <label className={styles.radioLabel}>
              <input
                type="radio"
                name="mode"
                checked={mode === "join"}
                onChange={() => setMode("join")}
              />
              Join with invite
            </label>
          </div>

          {mode === "join" && (
            <>
              <label className={styles.label} htmlFor="invite">
                Invite code
              </label>
              <input
                id="invite"
                className={styles.input}
                type="text"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                placeholder="Paste invite code here"
              />

              <label className={styles.label} htmlFor="startup-conflict-policy">
                Join conflict policy
              </label>
              <select
                id="startup-conflict-policy"
                className={styles.input}
                value={startupConflictPolicy}
                onChange={(e) =>
                  setStartupConflictPolicy(
                    e.target.value as "remote-wins" | "local-wins" | "keep-both",
                  )
                }
              >
                <option value="remote-wins">Remote wins (adopt existing head)</option>
                <option value="local-wins">Local wins (publish local files)</option>
                <option value="keep-both">Keep both (save local as conflict copy)</option>
              </select>

              <button
                type="button"
                className={styles.previewBtn}
                onClick={handlePreview}
                disabled={previewLoading}
              >
                {previewLoading ? "Previewing..." : "Preview join impact"}
              </button>

              {preview && (
                <div className={styles.previewBox}>
                  <div className={styles.previewTitle}>Join Preview</div>
                  <div className={styles.previewLine}>
                    Local files: {preview.counts.localFiles} | Remote files:{" "}
                    {preview.counts.remoteFiles}
                  </div>
                  <div className={styles.previewLine}>
                    Conflicts: {preview.counts.fileConflicts} | Tombstone collisions:{" "}
                    {preview.counts.tombstoneConflicts}
                  </div>
                  <div className={styles.previewLine}>
                    Remote-wins affected: {preview.policyImpact.remoteWins.totalAffected}
                  </div>
                  <div className={styles.previewLine}>
                    Local-wins affected: {preview.policyImpact.localWins.totalAffected}
                  </div>
                  <div className={styles.previewLine}>
                    Keep-both affected: {preview.policyImpact.keepBoth.totalAffected}
                  </div>
                </div>
              )}
            </>
          )}

          {error && <p className={styles.error}>{error}</p>}

          <button type="submit" className={styles.button} disabled={loading}>
            {loading ? "Setting up..." : "Start Syncing"}
          </button>
        </form>
      </div>
    </div>
  );
}
