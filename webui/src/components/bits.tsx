/** Small shared pieces: badges, status dots, JSON inspector, bars. */

import { useState } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import * as Dialog from "@radix-ui/react-dialog";
import type { TaskStatus } from "../lib/types.js";

export const STATUS_CLASS: Record<TaskStatus, string> = {
  queued: "st-queued",
  running: "st-running",
  completed: "st-completed",
  failed: "st-failed",
  cancelled: "st-cancelled",
  timed_out: "st-timed_out",
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span className={`badge ${STATUS_CLASS[status]}`}>
      {status === "running" && <span className="dot dot-live" />}
      {status}
    </span>
  );
}

export function Chip({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <span className={`chip ${tone ?? ""}`}>
      <span className="chip-label">{label}</span>
      <span className="chip-value">{value}</span>
    </span>
  );
}

export function Tip({ children, text }: { children: React.ReactNode; text: string }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip" sideOffset={6}>
          {text}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function Bar({ percent, tone }: { percent: number; tone?: string }) {
  const p = Math.max(0, Math.min(100, percent));
  return (
    <span className="bar">
      <span className={`bar-fill ${tone ?? ""}`} style={{ width: `${p}%` }} />
    </span>
  );
}

/** One-line JSON summary; click to inspect the whole payload in a dialog. */
export function JsonPeek({ value, max = 140, label }: { value: unknown; max?: number; label?: string }) {
  const [open, setOpen] = useState(false);
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) text = "";
  const oneLine = text.replace(/\s+/g, " ").trim();
  return (
    <>
      <button type="button" className="json-peek" onClick={() => setOpen(true)} title="inspect payload">
        {label ?? (oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine || "∅")}
      </button>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content dialog-json">
            <div className="dialog-header">
              <Dialog.Title className="dialog-title">payload</Dialog.Title>
              <Dialog.Close asChild>
                <button className="dialog-close" aria-label="close">
                  ✕
                </button>
              </Dialog.Close>
            </div>
            <pre>{pretty(value)}</pre>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

function pretty(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
