/** First-run dialog: ask for the server API key, validate, connect. */

import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { store } from "../lib/store.js";

export function KeyGate({ open, hint }: { open: boolean; hint?: string | null }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const ok = await store.connect(key.trim());
    setBusy(false);
    if (!ok) setError(store.getState().authError ?? "connection failed — wrong key or server unreachable");
  };

  return (
    <Dialog.Root open={open}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content dialog-key" onOpenAutoFocus={(e) => e.preventDefault()}>
          <Dialog.Title className="dialog-title">Connect to WrongForge</Dialog.Title>
          <Dialog.Description className="dialog-desc">
            The dashboard talks to the local API on this origin. Paste the server key
            <code> npm run serve</code> printed — it is stored in this browser only.
          </Dialog.Description>
          <div className="key-row">
            <input
              autoFocus
              type="password"
              placeholder="API key (≥ 16 chars)"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void connect()}
            />
            <button className="btn-primary" disabled={busy || !key.trim()} onClick={() => void connect()}>
              {busy ? "connecting…" : "Connect"}
            </button>
          </div>
          {(error ?? hint) && <div className="key-error">{error ?? hint}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
