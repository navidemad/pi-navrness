import fs from "node:fs";
import path from "node:path";
import { DynamicBorder, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AsyncStartedEvent, ChildStartedEvent } from "./herdr-inspectors.ts";

export const ATELIER_SIDEBAR_EVENT = "pi-atelier:sidebar-panels";
const PANEL_ID = "pi-navrness:subagents";
const PANEL_SOURCE = "pi-navrness";
const PANEL_PROTOCOL_VERSION = 1;
const MAX_CHILDREN = 16;
const MAX_ROOTS = 32;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_DETAIL_BYTES = 64 * 1024;
const MAX_DETAIL_LINES = 120;
const RECEIPT_GRACE_REFRESHES = 3;
const TERMINAL_STATES = new Set(["complete", "completed", "failed", "partial", "paused", "stopped", "rejected", "did-not-run"]);
const PLACEHOLDER_LINES = new Set(["[prompt redacted]", "# code context", "**output:**", "waiting for child activity..."]);
const panelRevisions = new WeakMap<object, number>();

type PanelRole = "accent" | "dim" | "error" | "muted" | "ready" | "warning" | "working";

interface PanelRow {
  text: string;
  role?: PanelRole;
}

interface PanelContribution {
  id: typeof PANEL_ID;
  title: string;
  rows: PanelRow[];
  role: PanelRole;
}

interface TrackedRoot {
  runId: string;
  asyncDir: string;
  mode?: string;
  startedAt: number;
}

interface TrackedChild {
  id: string;
  rootRunId: string;
  asyncDir: string;
  agent: string;
  label: string;
  index?: number;
  workflowKey?: string;
  childRunId?: string;
  startedAt: number;
}

export interface ChildSnapshot extends TrackedChild {
  state: string;
  task?: string;
  currentTool?: string;
  durationMs: number;
  detail: string;
  rawDetail?: string;
  hasFinalReport: boolean;
  summary?: string;
}

interface SidebarRuntime {
  events: Pick<ExtensionAPI["events"], "emit" | "on">;
  sessionId(): string | undefined;
  now(): number;
  readJson(file: string): unknown;
  readTail(file: string, maxLines?: number): string | undefined;
  setInterval(callback: () => void, intervalMs: number): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
}

export interface SubagentSidebarOptions {
  pi: Pick<ExtensionAPI, "events">;
  sessionId: () => string | undefined;
  enabled?: boolean;
  now?: () => number;
  readJson?: (file: string) => unknown;
  readTail?: (file: string, maxLines?: number) => string | undefined;
  setInterval?: SidebarRuntime["setInterval"];
  clearInterval?: SidebarRuntime["clearInterval"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function boundedReadJson(file: string): unknown {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(file, "r");
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_METADATA_BYTES) return undefined;
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (count <= 0) return undefined;
      offset += count;
    }
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function boundedReadTail(file: string, maxLines = MAX_DETAIL_LINES): string | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(file, "r");
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) return undefined;
    const length = Math.min(stat.size, MAX_DETAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(descriptor, buffer, 0, length, stat.size - length);
    return buffer.toString("utf8").split(/\r?\n/).filter(Boolean).slice(-maxLines).join("\n") || undefined;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function parseRoot(value: unknown): AsyncStartedEvent | undefined {
  if (!isRecord(value)) return undefined;
  const id = nonEmptyString(value.id);
  const sessionId = nonEmptyString(value.sessionId);
  const asyncDir = nonEmptyString(value.asyncDir);
  const cwd = nonEmptyString(value.cwd);
  if (!id || !sessionId || !asyncDir || !cwd || !Number.isInteger(value.lifecycleArtifactVersion)) return undefined;
  const agents = Array.isArray(value.agents)
    ? value.agents.filter((agent): agent is string => Boolean(nonEmptyString(agent)))
    : undefined;
  return {
    lifecycleArtifactVersion: value.lifecycleArtifactVersion as number,
    id,
    sessionId,
    asyncDir,
    cwd,
    ...(nonEmptyString(value.mode) ? { mode: value.mode as string } : {}),
    ...(nonEmptyString(value.agent) ? { agent: value.agent as string } : {}),
    ...(agents?.length ? { agents } : {}),
    ...(nonEmptyString(value.parentWorkflowRunId) ? { parentWorkflowRunId: value.parentWorkflowRunId as string } : {}),
    ...(nonEmptyString(value.workflowKey) ? { workflowKey: value.workflowKey as string } : {}),
  };
}

function parseChild(value: unknown): ChildStartedEvent | undefined {
  if (!isRecord(value) || value.type !== "subagent.child-status" || value.version !== 1 || value.status !== "started") return undefined;
  const runId = nonEmptyString(value.runId);
  const childId = nonEmptyString(value.childId);
  const asyncDir = nonEmptyString(value.asyncDir);
  const agent = nonEmptyString(value.agent);
  const workflowKey = nonEmptyString(value.workflowKey);
  if (!runId || !childId || !asyncDir || !agent || !workflowKey) return undefined;
  const stepIndex = Number.isInteger(value.stepIndex) && (value.stepIndex as number) >= 0 ? value.stepIndex as number : undefined;
  return {
    type: "subagent.child-status",
    version: 1,
    runId,
    childId,
    status: "started",
    asyncDir,
    agent,
    workflowKey,
    ...(nonEmptyString(value.childRunId) ? { childRunId: value.childRunId as string } : {}),
    ...(stepIndex !== undefined ? { stepIndex } : {}),
  };
}

function childRunDirectory(asyncDir: string, childRunId: string | undefined): string | undefined {
  if (!childRunId || path.basename(childRunId) !== childRunId) return undefined;
  const runsDir = path.dirname(asyncDir);
  const candidate = path.resolve(runsDir, childRunId);
  return path.dirname(candidate) === runsDir ? candidate : undefined;
}

function statusSteps(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value) || !Array.isArray(value.steps)) return [];
  return value.steps.filter(isRecord);
}

function stateRole(state: string): PanelRole {
  if (state === "running" || state === "queued" || state === "starting") return "working";
  if (state === "complete" || state === "completed") return "ready";
  if (state === "failed" || state === "rejected") return "error";
  if (state === "paused" || state === "partial" || state === "stopped" || state === "did-not-run") return "warning";
  return "muted";
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
}

function recentOutput(step: Record<string, unknown> | undefined): string | undefined {
  if (!Array.isArray(step?.recentOutput)) return undefined;
  const lines = step.recentOutput.filter((line): line is string => typeof line === "string");
  return lines.slice(-MAX_DETAIL_LINES).join("\n") || undefined;
}

function substantiveLine(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => {
    const normalized = line.toLowerCase();
    if (!line || PLACEHOLDER_LINES.has(normalized)) return false;
    if (/^(?:```|[{}\[\],]|#{1,6}(?:[ \t]+|$))/u.test(line)) return false;
    if (/^(?:fingerprint|path|status|criteriaSatisfied|changedFiles|commandsRun|validationOutput|residualRisks)\s*[":]/iu.test(line)) return false;
    if (/^(?:daemon:\s+running|pixel\s+(?:status|repo-state|scope-task|search-content)\b|[├└│])/iu.test(line)) return false;
    return true;
  });
  return lines.find((line) => /(?:error|failed|failure|command exited|blocked)/iu.test(line)) ?? lines[0];
}

function safeTask(value: string | undefined): string | undefined {
  const task = value?.trim();
  if (!task || PLACEHOLDER_LINES.has(task.toLowerCase())) return undefined;
  return task;
}

function outputWithoutAcceptanceReport(text: string): string {
  const match = text.match(/(?:^|\n)```(?:acceptance-report|acceptance_report)\s*\r?\n([\s\S]*?)\r?\n```\s*$/u);
  if (!match || match.index === undefined) return text;
  try {
    const parsed = JSON.parse(match[1]);
    if (!isRecord(parsed)) return text;
    return text.slice(0, match.index).trimEnd() || text;
  } catch {
    return text;
  }
}

function validReceiptEntry(entry: unknown, workflowKey: string, childRunId: string): entry is Record<string, unknown> {
  if (!isRecord(entry) || entry.key !== workflowKey || entry.latestRunId !== childRunId) return false;
  if (!isRecord(entry.continuation) || !Array.isArray(entry.continuation.runIds)) return false;
  const runIds = entry.continuation.runIds;
  if (runIds.some((runId) => !nonEmptyString(runId)) || runIds.at(-1) !== childRunId) return false;
  if (!isRecord(entry.resumability)) return false;
  if (entry.resumability.state === "resumable") return true;
  return entry.resumability.state === "not-resumable" && Boolean(nonEmptyString(entry.resumability.reason));
}

function terminalReport(runtime: SidebarRuntime, child: TrackedChild, rootStatus: unknown, receipt: unknown): string | undefined {
  if (!child.workflowKey || !child.childRunId || !isRecord(rootStatus) || !TERMINAL_STATES.has(String(rootStatus.state))) return undefined;
  if (
    !isRecord(receipt)
    || receipt.version !== 1
    || receipt.workflowRunId !== child.rootRunId
    || !["complete", "failed", "paused", "stopped"].includes(String(receipt.state))
    || typeof receipt.createdAt !== "number"
    || !Number.isFinite(receipt.createdAt)
    || !isRecord(receipt.entries)
  ) return undefined;
  const entry = receipt.entries[child.workflowKey];
  if (!validReceiptEntry(entry, child.workflowKey, child.childRunId)) return undefined;
  const outputReference = nonEmptyString(entry.outputReference);
  if (!outputReference || !path.isAbsolute(outputReference)) return undefined;
  const report = runtime.readTail(outputReference);
  const readable = report ? outputWithoutAcceptanceReport(report).trim() : "";
  return readable || undefined;
}

interface RootArtifacts {
  status: unknown;
  receipt: unknown;
}

function snapshotFor(runtime: SidebarRuntime, child: TrackedChild, artifacts: RootArtifacts): ChildSnapshot {
  const rootStatus = artifacts.status;
  const rootSteps = statusSteps(rootStatus);
  const rootStep = child.workflowKey
    ? rootSteps.find((step) => step.workflowKey === child.workflowKey)
    : child.index === undefined ? undefined : rootSteps[child.index];

  let childStatus: unknown;
  let childStep: Record<string, unknown> | undefined;
  let outputFile: string | undefined;
  const childDir = childRunDirectory(child.asyncDir, child.childRunId);
  if (childDir) {
    const candidate = runtime.readJson(path.join(childDir, "status.json"));
    if (isRecord(candidate) && candidate.runId === child.childRunId && candidate.parentWorkflowRunId === child.rootRunId && candidate.workflowKey === child.workflowKey) {
      childStatus = candidate;
      childStep = statusSteps(candidate)[0];
      outputFile = path.join(childDir, "output-0.log");
    }
  } else if (child.index !== undefined) {
    outputFile = path.join(child.asyncDir, `output-${child.index}.log`);
  }

  const effectiveStep = childStep ?? rootStep;
  const rootState = isRecord(rootStatus) ? nonEmptyString(rootStatus.state) : undefined;
  const childState = isRecord(childStatus) ? nonEmptyString(childStatus.state) : undefined;
  const pendingAfterTerminal = effectiveStep?.status === "pending" && rootState && TERMINAL_STATES.has(rootState);
  const state = pendingAfterTerminal
    ? "did-not-run"
    : nonEmptyString(effectiveStep?.status) ?? childState ?? rootState ?? "starting";
  const task = safeTask(nonEmptyString(effectiveStep?.description) ?? nonEmptyString(effectiveStep?.label));
  const currentTool = nonEmptyString(effectiveStep?.currentTool);
  const endedAt = isRecord(childStatus) && typeof childStatus.endedAt === "number"
    ? childStatus.endedAt
    : isRecord(rootStatus) && typeof rootStatus.endedAt === "number" && TERMINAL_STATES.has(state)
      ? rootStatus.endedAt
      : undefined;
  const startedAt = isRecord(childStatus) && typeof childStatus.startedAt === "number"
    ? childStatus.startedAt
    : typeof effectiveStep?.startedAt === "number"
      ? effectiveStep.startedAt
      : child.startedAt;
  const report = terminalReport(runtime, child, rootStatus, artifacts.receipt);
  const rawDetail = (outputFile ? runtime.readTail(outputFile) : undefined) ?? recentOutput(effectiveStep);
  const detail = report ?? rawDetail ?? "Waiting for child activity...";
  const reportSummary = substantiveLine(report);
  const activitySummary = substantiveLine(rawDetail);
  const errorSummary = [reportSummary, activitySummary].find((line) =>
    line && /(?:error|failed|failure|command exited|blocked)/iu.test(line));
  const summary = errorSummary ?? (currentTool
    ? `tool: ${currentTool}`
    : reportSummary ?? activitySummary);
  return {
    ...child,
    state,
    ...(task ? { task } : {}),
    ...(currentTool ? { currentTool } : {}),
    durationMs: Math.max(0, (endedAt ?? runtime.now()) - startedAt),
    detail,
    ...(rawDetail && rawDetail !== detail ? { rawDetail } : {}),
    hasFinalReport: Boolean(report),
    ...(summary ? { summary } : {}),
  };
}

function panelFor(snapshots: readonly ChildSnapshot[]): PanelContribution {
  if (snapshots.length === 0) {
    return { id: PANEL_ID, title: "Subagents", role: "accent", rows: [{ text: "No subagents in this session", role: "dim" }] };
  }
  const rows = snapshots.flatMap((snapshot) => {
    const heading = `${snapshot.label} · ${snapshot.agent} · ${snapshot.state} · ${formatDuration(snapshot.durationMs)}`;
    return [
      { text: heading, role: stateRole(snapshot.state) },
      ...(snapshot.task ? [{ text: `  ${snapshot.task}`, role: "muted" as const }] : []),
      ...(snapshot.summary ? [{ text: `  ${snapshot.summary}`, role: "dim" as const }] : []),
    ];
  });
  return { id: PANEL_ID, title: `Subagents (${snapshots.length})`, role: "accent", rows: rows.slice(0, 24) };
}

function enabledFromEnvironment(): boolean {
  return ["1", "true", "on", "yes"].includes((process.env.PI_NAVRNESS_SIDEBAR ?? "").toLowerCase());
}

function nextPanelRevision(events: object): number {
  const next = (panelRevisions.get(events) ?? 0) + 1;
  panelRevisions.set(events, next);
  return next;
}

export class SubagentSidebar {
  private readonly runtime: SidebarRuntime;
  private readonly roots = new Map<string, TrackedRoot>();
  private readonly children = new Map<string, TrackedChild>();
  private enabled: boolean;
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribeDiscovery: (() => void) | undefined;
  private cachedSnapshots: ChildSnapshot[] = [];
  private receiptGraceRemaining = 0;
  private lastPanelSignature: string | undefined;

  constructor(options: SubagentSidebarOptions) {
    this.runtime = {
      events: options.pi.events,
      sessionId: options.sessionId,
      now: options.now ?? Date.now,
      readJson: options.readJson ?? boundedReadJson,
      readTail: options.readTail ?? boundedReadTail,
      setInterval: options.setInterval ?? ((callback, intervalMs) => setInterval(callback, intervalMs)),
      clearInterval: options.clearInterval ?? clearInterval,
    };
    this.enabled = options.enabled ?? enabledFromEnvironment();
  }

  start(): void {
    this.unsubscribeDiscovery ??= this.runtime.events.on(ATELIER_SIDEBAR_EVENT, (value) => {
      if (!this.enabled || !isRecord(value) || value.version !== PANEL_PROTOCOL_VERSION || value.type !== "discover") return;
      const requestId = nonEmptyString(value.requestId);
      if (requestId) this.publish(requestId, true);
    });
    if (this.enabled) this.publish(undefined, true);
  }

  dispose(): void {
    if (this.enabled) this.unregister();
    this.unsubscribeDiscovery?.();
    this.unsubscribeDiscovery = undefined;
    if (this.timer) this.runtime.clearInterval(this.timer);
    this.timer = undefined;
    this.roots.clear();
    this.children.clear();
    this.cachedSnapshots = [];
    this.receiptGraceRemaining = 0;
    this.lastPanelSignature = undefined;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (enabled) {
      this.refresh();
      this.syncTimer();
    } else {
      this.unregister();
      this.stopTimer();
    }
  }

  handleAsyncStarted(value: unknown): void {
    const event = parseRoot(value);
    if (!event || event.sessionId !== this.runtime.sessionId()) return;
    if (event.parentWorkflowRunId && event.workflowKey) return;
    const startedAt = this.runtime.now();
    this.roots.delete(event.id);
    this.roots.set(event.id, { runId: event.id, asyncDir: event.asyncDir, ...(event.mode ? { mode: event.mode } : {}), startedAt });
    while (this.roots.size > MAX_ROOTS) this.roots.delete(this.roots.keys().next().value as string);

    if (event.mode !== "workflow") {
      const agents = event.agents?.length ? event.agents : event.agent ? [event.agent] : [];
      agents.forEach((agent, index) => this.track({
        id: `${event.id}:index:${index}`,
        rootRunId: event.id,
        asyncDir: event.asyncDir,
        agent,
        label: agents.length > 1 ? `child ${index + 1}` : agent,
        index,
        startedAt,
      }));
    }
    this.receiptGraceRemaining = RECEIPT_GRACE_REFRESHES;
    this.syncTimer();
    this.refresh();
  }

  handleChildStatus(value: unknown): void {
    const event = parseChild(value);
    if (!event) return;
    const root = this.roots.get(event.runId);
    if (!root || root.asyncDir !== event.asyncDir) return;
    this.track({
      id: `${event.runId}:workflow:${event.workflowKey}`,
      rootRunId: event.runId,
      asyncDir: event.asyncDir,
      agent: event.agent,
      label: event.workflowKey,
      workflowKey: event.workflowKey,
      ...(event.childRunId ? { childRunId: event.childRunId } : {}),
      ...(event.stepIndex !== undefined ? { index: event.stepIndex } : {}),
      startedAt: this.runtime.now(),
    });
    this.receiptGraceRemaining = RECEIPT_GRACE_REFRESHES;
    this.syncTimer();
    this.refresh();
  }

  snapshots(): ChildSnapshot[] {
    return this.cachedSnapshots.map((snapshot) => ({ ...snapshot }));
  }

  refresh(): void {
    const artifacts = new Map<string, RootArtifacts>();
    for (const child of this.children.values()) {
      if (artifacts.has(child.asyncDir)) continue;
      const status = this.runtime.readJson(path.join(child.asyncDir, "status.json"));
      const rootTerminal = isRecord(status) && TERMINAL_STATES.has(String(status.state));
      artifacts.set(child.asyncDir, {
        status,
        receipt: rootTerminal ? this.runtime.readJson(path.join(child.asyncDir, "workflow-receipt.json")) : undefined,
      });
    }
    this.cachedSnapshots = [...this.children.values()].map((child) => snapshotFor(
      this.runtime,
      child,
      artifacts.get(child.asyncDir) ?? { status: undefined, receipt: undefined },
    ));
    if (this.enabled) this.publish();

    const settled = this.cachedSnapshots.length > 0 && this.cachedSnapshots.every((snapshot) => TERMINAL_STATES.has(snapshot.state));
    const waitingForReceipt = settled && this.cachedSnapshots.some((snapshot) => snapshot.workflowKey && !snapshot.hasFinalReport);
    if (!settled) return;
    if (waitingForReceipt && this.receiptGraceRemaining > 0) {
      this.receiptGraceRemaining -= 1;
      return;
    }
    this.stopTimer();
  }

  async showDetails(ctx: ExtensionCommandContext): Promise<void> {
    const snapshots = this.snapshots();
    if (snapshots.length === 0) {
      ctx.ui.notify("No pi-subagents children have been observed in this session.", "info");
      return;
    }
    const labels = snapshots.map((snapshot) => `${snapshot.label} · ${snapshot.agent} · ${snapshot.state}`);
    const choice = await ctx.ui.select("Subagent activity", labels);
    if (!choice) return;
    const selected = snapshots[labels.indexOf(choice)];
    if (!selected) return;
    let requestRender: (() => void) | undefined;
    const selectedIsActive = !TERMINAL_STATES.has(selected.state);
    const renderTimer = selectedIsActive ? this.runtime.setInterval(() => requestRender?.(), 1_000) : undefined;
    renderTimer?.unref?.();
    try {
      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        let scrollOffset = 0;
        let showRaw = false;
        const border = new DynamicBorder((text: string) => theme.fg("borderAccent", text));
        requestRender = () => tui.requestRender();
        return {
          render: (width) => {
            const snapshot = this.snapshots().find((candidate) => candidate.id === selected.id) ?? selected;
            const innerWidth = Math.max(1, width - 4);
            const terminalRows = typeof tui.terminal?.rows === "number" ? tui.terminal.rows : 24;
            const viewportRows = Math.max(4, Math.min(MAX_DETAIL_LINES, Math.floor(terminalRows * 0.62) - 7));
            const headingColor = snapshot.state === "complete" || snapshot.state === "completed"
              ? "success"
              : snapshot.state === "failed" || snapshot.state === "rejected"
                ? "error"
                : snapshot.state === "running" || snapshot.state === "queued" || snapshot.state === "starting"
                  ? "accent"
                  : "warning";
            const heading = theme.fg(headingColor, theme.bold(`${snapshot.label} · ${snapshot.agent} · ${snapshot.state}`));
            const metadata = theme.fg("dim", `${formatDuration(snapshot.durationMs)}${snapshot.currentTool ? ` · tool ${snapshot.currentTool}` : ""}`);
            const source = showRaw && snapshot.rawDetail ? snapshot.rawDetail : snapshot.detail;
            const sourceLabel = showRaw && snapshot.rawDetail ? "Raw activity" : snapshot.hasFinalReport ? "Final report" : "Activity";
            const content = source.split(/\r?\n/).flatMap((line) => wrapTextWithAnsi(line, innerWidth));
            const maxOffset = Math.max(0, content.length - viewportRows);
            scrollOffset = Math.min(scrollOffset, maxOffset);
            const visible = content.slice(scrollOffset, scrollOffset + viewportRows);
            const pad = (line: string) => {
              const clipped = truncateToWidth(line, innerWidth, "");
              return `  ${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))}  `;
            };
            const taskLines = snapshot.task ? wrapTextWithAnsi(snapshot.task, innerWidth).slice(0, 2) : [];
            const help = `${scrollOffset + 1}-${Math.min(content.length, scrollOffset + viewportRows)}/${Math.max(1, content.length)} · ↑↓ scroll${snapshot.rawDetail ? " · r report/raw" : ""} · esc close`;
            return [
              ...border.render(width),
              pad(heading),
              pad(metadata),
              ...taskLines.map((line) => pad(theme.fg("muted", line))),
              pad(theme.fg("accent", sourceLabel)),
              ...visible.map(pad),
              ...Array.from({ length: Math.max(0, viewportRows - visible.length) }, () => pad("")),
              pad(theme.fg("dim", help)),
              ...border.render(width),
            ];
          },
          handleInput(data) {
            if (matchesKey(data, Key.escape)) done(undefined);
            else if (matchesKey(data, Key.up)) scrollOffset = Math.max(0, scrollOffset - 1);
            else if (matchesKey(data, Key.down)) scrollOffset += 1;
            else if (matchesKey(data, Key.pageUp)) scrollOffset = Math.max(0, scrollOffset - 10);
            else if (matchesKey(data, Key.pageDown)) scrollOffset += 10;
            else if (data.toLowerCase() === "r") {
              showRaw = !showRaw;
              scrollOffset = 0;
            }
            tui.requestRender();
          },
          invalidate() {
            border.invalidate();
          },
        };
      }, {
        overlay: true,
        overlayOptions: { width: "62%", minWidth: 44, maxHeight: "76%", anchor: "left-center", margin: 2 },
      });
    } finally {
      requestRender = undefined;
      if (renderTimer) this.runtime.clearInterval(renderTimer);
    }
  }

  private track(child: TrackedChild): void {
    this.children.delete(child.id);
    this.children.set(child.id, child);
    while (this.children.size > MAX_CHILDREN) this.children.delete(this.children.keys().next().value as string);
  }

  private syncTimer(): void {
    if (this.enabled && this.children.size > 0 && !this.timer) {
      this.timer = this.runtime.setInterval(() => this.refresh(), 1_000);
      this.timer.unref?.();
    } else if ((!this.enabled || this.children.size === 0) && this.timer) {
      this.stopTimer();
    }
  }

  private stopTimer(): void {
    if (!this.timer) return;
    this.runtime.clearInterval(this.timer);
    this.timer = undefined;
  }

  private publish(requestId?: string, force = false): void {
    const panel = panelFor(this.cachedSnapshots);
    const signature = JSON.stringify(panel);
    if (!force && signature === this.lastPanelSignature) return;
    this.lastPanelSignature = signature;
    this.runtime.events.emit(ATELIER_SIDEBAR_EVENT, {
      version: PANEL_PROTOCOL_VERSION,
      type: "register",
      source: PANEL_SOURCE,
      revision: nextPanelRevision(this.runtime.events),
      panel,
      ...(requestId ? { requestId } : {}),
    });
  }

  private unregister(): void {
    this.runtime.events.emit(ATELIER_SIDEBAR_EVENT, {
      version: PANEL_PROTOCOL_VERSION,
      type: "unregister",
      source: PANEL_SOURCE,
      revision: nextPanelRevision(this.runtime.events),
      id: PANEL_ID,
    });
  }
}
