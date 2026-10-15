/** Shapes mirrored from the WrongForge HTTP API (docs/TASKS-API.md). */

export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "timed_out";

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export interface TaskProgress {
  last_event_seq: number;
  steps: number;
  tool_calls: number;
  current_tool?: { id: string; name: string; started_at: string };
  last_report?: { message: string; percent?: number; phase?: string; at: string };
  todos?: { content: string; status: string }[];
  last_activity_at: string;
}

export interface TaskRecord {
  id: string;
  status: TaskStatus;
  session_id: string;
  session_created: boolean;
  prompt: string;
  model: string;
  max_steps: number;
  timeout_ms: number;
  workdir: string;
  workdir_lock: boolean;
  cache?: string;
  effort?: string;
  env_keys?: string[];
  system_append?: string;
  context?: unknown;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  progress: TaskProgress;
  result?: {
    text: string;
    finish_reason: string;
    steps: number;
    tool_calls: number;
    usage: TokenUsage;
    context_tokens: number;
    context_window: number;
    context_percent: number;
    duration_ms: number;
  };
  error?: { code: string; message: string };
}

export interface TaskEvent {
  seq: number;
  ts: string;
  task_id: string;
  session_id: string;
  type: string;
  data: Record<string, unknown>;
}

export interface SessionMeta {
  id: string;
  created_at: string;
  updated_at: string;
  turns: number;
  message_count: number;
  title: string;
  model?: string;
  workdir?: string;
  context_tokens?: number;
  compactions?: number;
}

export interface AgentMessage {
  role: string;
  content: unknown;
}

export interface UsageWindow {
  percent: number | null;
  resetsAt: string | null;
  isActive: boolean;
}

export interface PlanUsage {
  five_hour: UsageWindow;
  weekly: UsageWindow | null;
  extra_usage: { enabled: boolean; usedCredits: number | null; monthlyLimit: number | null; utilization: number | null };
}

export interface Info {
  name: string;
  version: string;
  protocol: number;
  features: string[];
  signed_in: boolean;
  default_model: string;
  models: string[];
  queue: { queued: number; running: number; max_concurrency: number } & Record<string, number>;
  workdir: { default: string | null; required: boolean; allowed_roots?: string[]; lock_by_default: boolean };
  context: { window: number; compact_at: number; clear_at: number; keep_turns: number };
  cache: { default: string; modes: string[] };
  effort: { default: string; levels: string[] };
  tools: string[];
  tool_guides: string[];
  mcp: { config_file: string; servers: number };
}

export const TERMINAL: TaskStatus[] = ["completed", "failed", "cancelled", "timed_out"];

export const fmtTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);

export const shortId = (id: string, keep = 10): string => (id.length > keep ? `${id.slice(0, keep)}…` : id);

export const fmtAge = (iso: string): string => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};
