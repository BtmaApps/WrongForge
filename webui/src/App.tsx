/** Shell: key gate → top bar + tabbed views. Everything below is live. */

import { useEffect, useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import * as Tooltip from "@radix-ui/react-tooltip";
import { loadKey } from "./lib/api.js";
import { store, useStore } from "./lib/store.js";
import { KeyGate } from "./components/KeyGate.js";
import { TopBar } from "./components/TopBar.js";
import { LiveFeed } from "./components/LiveFeed.js";
import { TasksView } from "./components/TasksView.js";
import { SessionsView } from "./components/SessionsView.js";
import { GraphView } from "./components/GraphView.js";

export default function App() {
  const conn = useStore((s) => s.conn);
  const connDetail = useStore((s) => s.connDetail);
  const authError = useStore((s) => s.authError);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [forceGate, setForceGate] = useState(false);
  const locked = conn === "locked";

  useEffect(() => {
    const key = loadKey();
    if (key) void store.connect(key);
    return () => store.disconnectSse();
  }, []);

  useEffect(() => {
    if (conn === "open") setForceGate(false);
  }, [conn]);

  const openTask = (id: string): void => setOpenTaskId(id);

  return (
    <Tooltip.Provider delayDuration={250}>
      <div className="app">
        <TopBar />
        {conn === "reconnecting" && connDetail && (
          <div className="conn-banner">
            <span>
              live feed lost — {connDetail} — retrying in the background
              {connDetail.includes("401") ? " (the key looks wrong: the server may have generated a new one)" : ""}
            </span>
            <button className="banner-btn" onClick={() => setForceGate(true)}>
              change key
            </button>
          </div>
        )}
        {!locked && (
          <Tabs.Root defaultValue="feed" className="tabs">
            <Tabs.List className="tabs-list">
              <Tabs.Trigger value="feed" className="tabs-trigger">
                Live feed
              </Tabs.Trigger>
              <Tabs.Trigger value="graph" className="tabs-trigger">
                Graph
              </Tabs.Trigger>
              <Tabs.Trigger value="tasks" className="tabs-trigger">
                Tasks
              </Tabs.Trigger>
              <Tabs.Trigger value="sessions" className="tabs-trigger">
                Sessions
              </Tabs.Trigger>
            </Tabs.List>
            <Tabs.Content value="feed" className="tabs-content">
              <LiveFeed onOpenTask={openTask} />
            </Tabs.Content>
            <Tabs.Content value="graph" className="tabs-content tabs-graph">
              <GraphView onOpenTask={openTask} />
            </Tabs.Content>
            <Tabs.Content value="tasks" className="tabs-content">
              <TasksView openTaskId={openTaskId} setOpenTaskId={setOpenTaskId} />
            </Tabs.Content>
            <Tabs.Content value="sessions" className="tabs-content">
              <SessionsView />
            </Tabs.Content>
          </Tabs.Root>
        )}
        {locked && (
          <div className="locked-note">
            The API on this origin requires a key.
            {authError && <div className="key-error">{authError}</div>}
          </div>
        )}
        <KeyGate open={locked || forceGate} hint={authError} onDismiss={() => setForceGate(false)} />
      </div>
    </Tooltip.Provider>
  );
}
