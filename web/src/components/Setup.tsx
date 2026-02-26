import { useState } from "react";
import { createInvite, setup } from "../api";
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
  const [generatedInvite, setGeneratedInvite] = useState("");
  const [copied, setCopied] = useState(false);

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
      if (mode === "create") {
        const { inviteCode: code } = await createInvite();
        setGeneratedInvite(code);
      } else {
        onComplete();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    await navigator.clipboard.writeText(generatedInvite);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (generatedInvite) {
    return (
      <div className={styles.container}>
        <div className={styles.card}>
          <h1 className={styles.title}>PearSync</h1>
          <p className={styles.subtitle}>
            Share this invite code with your other device. They have 10 minutes to enter it.
          </p>
          <div className={styles.inviteResult}>
            <div className={styles.inviteCode}>{generatedInvite}</div>
            <button type="button" className={styles.copyButton} onClick={handleCopy}>
              {copied ? "Copied!" : "Copy to clipboard"}
            </button>
          </div>
          <button type="button" className={styles.button} onClick={onComplete}>
            Continue to Dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container} data-testid="setup-screen">
      <div className={styles.card}>
        <h1 className={styles.title}>PearSync</h1>
        <p className={styles.subtitle}>Peer-to-peer folder sync</p>
        <form onSubmit={handleSubmit}>
          <label className={styles.label} htmlFor="folder">
            Folder path
          </label>
          <input
            id="folder"
            className={styles.input}
            type="text"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            placeholder="~/PearSync"
          />

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
