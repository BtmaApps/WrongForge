/**
 * The living map: WrongStack → tasks → models ↔ tools ↔ workdirs.
 * Nodes and edges are derived from the store; anything that pulsed in the
 * last few seconds renders animated, so the graph literally shows what is
 * moving through the system right now.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { useStore } from "../lib/store.js";
import { fmtTokens, shortId } from "../lib/types.js";

const PULSE_MS = 4000;
const MAX_TASK_NODES = 10;
const MAX_TOOL_NODES = 12;
const MAX_WORKDIR_NODES = 6;

type TaskNodeData = {
  id: string;
  label: string;
  status: string;
  model: string;
  steps: number;
  maxSteps: number;
  tools: number;
  tokensIn: number;
  tokensOut: number;
  active: boolean;
};

type StatNodeData = { label: string; sub?: string; tone: string; active: boolean; count?: number; errors?: number };

function TaskNodeView({ data }: NodeProps) {
  const d = data as unknown as TaskNodeData;
  return (
    <div className={`gf-node gf-task st-${d.status} ${d.active ? "gf-active" : ""}`}>
      <div className="gf-title mono">{d.label}</div>
      <div className="gf-sub mono">{shortId(d.model.replace("claude-", ""), 20)}</div>
      <div className="gf-stats mono">
        <span>steps {d.steps}/{d.maxSteps}</span>
        <span>tools {d.tools}</span>
      </div>
      {(d.tokensIn > 0 || d.tokensOut > 0) && (
        <div className="gf-stats mono dim">
          ↑{fmtTokens(d.tokensIn)} ↓{fmtTokens(d.tokensOut)}
        </div>
      )}
    </div>
  );
}

function StatNodeView({ data }: NodeProps) {
  const d = data as unknown as StatNodeData;
  return (
    <div className={`gf-node gf-stat tone-border-${d.tone} ${d.active ? "gf-active" : ""}`}>
      <div className="gf-title">{d.label}</div>
      {d.sub && <div className="gf-sub mono">{d.sub}</div>}
      {typeof d.count === "number" && (
        <div className="gf-stats mono">
          <span>×{d.count}</span>
          {typeof d.errors === "number" && d.errors > 0 && <span className="err">{d.errors} err</span>}
        </div>
      )}
    </div>
  );
}

const nodeTypes = { task: TaskNodeView, stat: StatNodeView };

export function GraphView({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const tasks = useStore((s) => s.tasks);
  const tools = useStore((s) => s.tools);
  const pulses = useStore((s) => s.pulses);
  const totals = useStore((s) => s.totals);
  const [beat, setBeat] = useState(0);

  // idle re-render so "active" highlights decay when the system goes quiet
  useEffect(() => {
    const t = setInterval(() => setBeat((b) => b + 1), 2000);
    return () => clearInterval(t);
  }, []);

  const now = Date.now();
  const fresh = (id: string): boolean => {
    const t = pulses.get(id);
    return typeof t === "number" && now - t < PULSE_MS;
  };
  const anyTaskFresh = [...pulses.values()].some((t) => now - t < PULSE_MS);

  const { nodes, edges } = useMemo(() => {
    const sorted = [...tasks.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
    const shown = sorted.slice(0, MAX_TASK_NODES);
    const hidden = sorted.length - shown.length;

    const nodes: Node[] = [];
    const edges: Edge[] = [];

    nodes.push({
      id: "orchestrator",
      type: "stat",
      position: { x: 0, y: 300 },
      data: { label: "WrongStack", sub: `HTTP API · ${totals.requests} reqs`, tone: "violet", active: anyTaskFresh },
      draggable: true,
    });

    // models in use
    const modelAgg = new Map<string, { tasks: number; reqs: number }>();
    for (const t of shown) {
      const m = modelAgg.get(t.model) ?? { tasks: 0, reqs: 0 };
      m.tasks++;
      modelAgg.set(t.model, m);
    }

    shown.forEach((t, i) => {
      nodes.push({
        id: `task:${t.id}`,
        type: "task",
        position: { x: 360, y: i * 130 },
        data: {
          id: t.id,
          label: shortId(t.id, 14),
          status: t.status,
          model: t.model,
          steps: t.progress.steps,
          maxSteps: t.max_steps,
          tools: t.progress.tool_calls,
          tokensIn: t.result?.usage.input_tokens ?? 0,
          tokensOut: t.result?.usage.output_tokens ?? 0,
          active: fresh(`task:${t.id}`),
        } as unknown as Record<string, unknown>,
        draggable: true,
      });
      edges.push({
        id: `e:orch>${t.id}`,
        source: "orchestrator",
        target: `task:${t.id}`,
        animated: fresh(`task:${t.id}`),
        className: `ed-status ed-${t.status}`,
      });
      edges.push({
        id: `e:${t.id}>model`,
        source: `task:${t.id}`,
        target: `model:${t.model}`,
        label: "req",
        animated: fresh(`edge:${t.id}>model:${t.model}`),
        className: "ed-req",
      });
      edges.push({
        id: `e:model>${t.id}`,
        source: `model:${t.model}`,
        target: `task:${t.id}`,
        animated: fresh(`edge:model:${t.model}>${t.id}`),
        className: "ed-res",
      });
    });

    let my = 0;
    for (const [model, agg] of modelAgg) {
      nodes.push({
        id: `model:${model}`,
        type: "stat",
        position: { x: 760, y: my * 110 },
        data: {
          label: model.replace("claude-", ""),
          sub: `${agg.tasks} task${agg.tasks > 1 ? "s" : ""}`,
          tone: "cyan",
          active: fresh(`model:${model}`),
        },
        draggable: true,
      });
      my++;
    }

    // tools by activity
    const toolList = [...tools.entries()].sort((a, b) => b[1].lastAt - a[1].lastAt).slice(0, MAX_TOOL_NODES);
    toolList.forEach(([name, st], i) => {
      const id = `tool:${name}`;
      nodes.push({
        id,
        type: "stat",
        position: { x: 1120, y: i * 105 },
        data: { label: name, tone: st.errors > 0 ? "red" : "green", active: fresh(id), count: st.calls, errors: st.errors },
        draggable: true,
      });
      // connect the most recent task that used it — simple heuristic: the
      // running task, else the newest task
      const src = [...shown].reverse().find((t) => t.status === "running") ?? shown[0];
      if (src) {
        edges.push({
          id: `e:${src.id}>${id}`,
          source: `task:${src.id}`,
          target: id,
          animated: fresh(`edge:${src.id}>${id}`),
          className: "ed-tool",
        });
      }
    });

    // workdirs (aggregated)
    const dirAgg = new Map<string, number>();
    for (const t of sorted) dirAgg.set(t.workdir, (dirAgg.get(t.workdir) ?? 0) + 1);
    [...dirAgg.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_WORKDIR_NODES)
      .forEach(([dir, count], j) => {
        const id = `dir:${dir}`;
        nodes.push({
          id,
          type: "stat",
          position: { x: 360, y: 620 + j * 100 },
          data: {
            label: dir.split(/[\\/]/).pop() || dir,
            sub: dir,
            tone: "amber",
            active: false,
            count,
          },
          draggable: true,
        });
        const first = shown.find((t) => t.workdir === dir);
        if (first) {
          edges.push({
            id: `e:${first.id}>${id}`,
            source: `task:${first.id}`,
            target: id,
            className: "ed-dir",
            style: { strokeDasharray: "6 5" },
          });
        }
      });

    if (hidden > 0) {
      nodes.push({
        id: "more",
        type: "stat",
        position: { x: 360, y: shown.length * 130 },
        data: { label: `+ ${hidden} more tasks`, tone: "dim", active: false },
        draggable: true,
      });
    }

    return { nodes, edges };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, tools, pulses, totals, beat]);

  return (
    <div className="graph">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.2}
        proOptions={{ hideAttribution: false }}
        onNodeClick={(_, node) => {
          if (node.id.startsWith("task:")) onOpenTask(node.id.slice(5));
        }}
      >
        <Background gap={22} />
        <MiniMap pannable zoomable className="gf-minimap" />
        <Controls />
      </ReactFlow>
      <div className="graph-legend mono">
        <span className="lg lg-req">→ request</span>
        <span className="lg lg-res">→ response</span>
        <span className="lg lg-tool">→ tool call</span>
        <span className="lg lg-dir">┈ workdir</span>
        <span className="lg">animated = active (last 4s)</span>
      </div>
    </div>
  );
}
