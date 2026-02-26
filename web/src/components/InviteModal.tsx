import { useEffect, useState } from "react";
import { createInvite } from "../api";
import styles from "./InviteModal.module.css";

interface InviteModalProps {
  onClose: () => void;
}

export function InviteModal({ onClose }: InviteModalProps) {
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    createInvite()
      .then(({ inviteCode }) => {
        setCode(inviteCode);
        setLoading(false);
      })
      .catch(() => {
        setCode("Failed to generate invite code");
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label="Invite a peer"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: click on inner div only prevents propagation */}
      <div className={styles.modal} role="document" onClick={(e) => e.stopPropagation()}>
        <h2 className={styles.title}>Invite a peer</h2>
        <p className={styles.subtitle}>
          Share this code with your other device. They have 10 minutes to enter it.
        </p>
        {loading ? (
          <div className={styles.loading}>Generating invite code...</div>
        ) : (
          <>
            <div className={styles.codeBox}>{code}</div>
            <div className={styles.actions}>
              <button type="button" className={styles.copyBtn} onClick={handleCopy}>
                {copied ? "Copied!" : "Copy to clipboard"}
              </button>
              <button type="button" className={styles.closeBtn} onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
