import { fileURLToPath } from "node:url";

export const ASYNC_STARTED_EVENT = "subagent:async-started";
export const CHILD_STATUS_EVENT = "subagent:child-status";

interface WorkflowGraphNode {
  kind?: unknown;
  children?: unknown;
}

interface WorkflowGraph {
  nodes?: unknown;
}

export interface AsyncStartedEvent {
  lifecycleArtifactVersion: number;
  id: string;
  sessionId: string;
  asyncDir: string;
  cwd: string;
  mode?: string;
  agent?: string;
  agents?: string[];
  workflowGraph?: WorkflowGraph;
}

export interface ChildStartedEvent {
  type: "subagent.child-status";
  version: 1;
  runId: string;
  childId: string;
  status: "started";
  asyncDir: string;
  agent: string;
  workflowKey: string;
  stepIndex?: number;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface InspectorRuntime {
  env: NodeJS.ProcessEnv;
  exec(command: string, args: string[]): Promise<CommandResult>;
  notify(message: string, level: "info" | "warning" | "error"): void;
}

export interface InspectorPaneBudget {
  opened: number;
  reserved: number;
  capWarningShown: boolean;
}

export interface InspectorManagerOptions {
  runtime: InspectorRuntime;
  sessionId: () => string | undefined;
  observerPath?: string;
  enabled?: boolean;
  maxPanes?: number;
  paneBudget?: InspectorPaneBudget;
}

interface HerdrSplitResponse {
  result?: {
    pane?: { pane_id?: unknown };
  };
  pane?: { pane_id?: unknown };
  pane_id?: unknown;
}

interface InspectorChild {
  identity: string;
  agent: string;
  index?: number;
  workflowKey?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseWorkflowGraph(value: unknown): WorkflowGraph | undefined {
  if (!isRecord(value) || !Array.isArray(value.nodes)) return undefined;
  return { nodes: value.nodes };
}

function parseStartedEvent(value: unknown): AsyncStartedEvent | undefined {
  if (!isRecord(value)) return undefined;
  if (!Number.isInteger(value.lifecycleArtifactVersion)) return undefined;
  for (const key of ["id", "sessionId", "asyncDir", "cwd"] as const) {
    if (typeof value[key] !== "string" || value[key].length === 0) return undefined;
  }
  const agents = Array.isArray(value.agents)
    ? value.agents.filter((agent): agent is string => typeof agent === "string" && agent.length > 0)
    : undefined;
  const agent = typeof value.agent === "string" && value.agent.length > 0 ? value.agent : undefined;
  const mode = typeof value.mode === "string" && value.mode.length > 0 ? value.mode : undefined;
  const workflowGraph = parseWorkflowGraph(value.workflowGraph);
  return {
    lifecycleArtifactVersion: value.lifecycleArtifactVersion as number,
    id: value.id as string,
    sessionId: value.sessionId as string,
    asyncDir: value.asyncDir as string,
    cwd: value.cwd as string,
    ...(mode ? { mode } : {}),
    ...(agent ? { agent } : {}),
    ...(agents ? { agents } : {}),
    ...(workflowGraph ? { workflowGraph } : {}),
  };
}

function parseChildStartedEvent(value: unknown): ChildStartedEvent | undefined {
  if (!isRecord(value) || value.type !== "subagent.child-status" || value.version !== 1 || value.status !== "started") return undefined;
  for (const key of ["runId", "childId", "asyncDir", "agent", "workflowKey"] as const) {
    if (typeof value[key] !== "string" || value[key].length === 0) return undefined;
  }
  const stepIndex = Number.isInteger(value.stepIndex) && (value.stepIndex as number) >= 0 ? value.stepIndex as number : undefined;
  return {
    type: "subagent.child-status",
    version: 1,
    runId: value.runId as string,
    childId: value.childId as string,
    status: "started",
    asyncDir: value.asyncDir as string,
    agent: value.agent as string,
    workflowKey: value.workflowKey as string,
    ...(stepIndex !== undefined ? { stepIndex } : {}),
  };
}

function includesDynamicGroup(nodes: unknown): boolean {
  if (!Array.isArray(nodes)) return false;
  return nodes.some((node: unknown) => {
    if (!isRecord(node)) return false;
    return node.kind === "dynamic-parallel-group" || includesDynamicGroup(node.children);
  });
}

function parsePaneId(stdout: string): string | undefined {
  let parsed: HerdrSplitResponse;
  try {
    parsed = JSON.parse(stdout) as HerdrSplitResponse;
  } catch {
    return undefined;
  }
  const candidates = [parsed.result?.pane?.pane_id, parsed.pane?.pane_id, parsed.pane_id];
  return candidates.find((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function enabledFromEnvironment(env: NodeJS.ProcessEnv): boolean {
  return ["1", "true", "on", "yes"].includes((env.PI_NAVRNESS_HERDR_VISIBILITY ?? "").toLowerCase());
}

const DEFAULT_MAX_PANES = 4;
const MAX_WORKFLOW_ROOTS = 32;
const processState = globalThis as typeof globalThis & {
  __piNavrnessHerdrPaneBudget?: InspectorPaneBudget;
};

function processPaneBudget(): InspectorPaneBudget {
  processState.__piNavrnessHerdrPaneBudget ??= { opened: 0, reserved: 0, capWarningShown: false };
  return processState.__piNavrnessHerdrPaneBudget;
}

export class HerdrInspectorManager {
  private enabled: boolean;
  private readonly opened = new Set<string>();
  private readonly pending = new Set<string>();
  private readonly workflowRoots = new Map<string, AsyncStartedEvent>();
  private readonly runtime: InspectorRuntime;
  private readonly sessionId: () => string | undefined;
  private readonly observerPath: string;
  private readonly maxPanes: number;
  private readonly paneBudget: InspectorPaneBudget;

  constructor(options: InspectorManagerOptions) {
    this.runtime = options.runtime;
    this.sessionId = options.sessionId;
    this.observerPath = options.observerPath ?? fileURLToPath(new URL("./observer.mjs", import.meta.url));
    this.enabled = options.enabled ?? enabledFromEnvironment(options.runtime.env);
    this.maxPanes = options.maxPanes ?? DEFAULT_MAX_PANES;
    this.paneBudget = options.paneBudget ?? processPaneBudget();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  resetSession(): void {
    this.workflowRoots.clear();
  }

  async handleAsyncStarted(payload: unknown): Promise<void> {
    if (!this.enabled) return;
    if (this.runtime.env.HERDR_ENV !== "1" || !this.runtime.env.HERDR_PANE_ID) return;

    const event = parseStartedEvent(payload);
    if (!event) {
      this.runtime.notify("pi-navrness ignored an invalid pi-subagents start event.", "warning");
      return;
    }
    if (event.sessionId !== this.sessionId()) return;
    if (event.mode === "workflow") {
      if (this.paneBudget.opened + this.paneBudget.reserved >= this.maxPanes) {
        this.notifyPaneCap();
        return;
      }
      this.workflowRoots.delete(event.id);
      this.workflowRoots.set(event.id, event);
      while (this.workflowRoots.size > MAX_WORKFLOW_ROOTS) {
        const oldest = this.workflowRoots.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.workflowRoots.delete(oldest);
      }
      return;
    }
    if (includesDynamicGroup(event.workflowGraph?.nodes)) {
      this.runtime.notify(
        `pi-navrness skipped run ${event.id}: dynamic workflow children do not have stable public identities.`,
        "warning",
      );
      return;
    }

    const agents = event.agents?.length ? event.agents : event.agent ? [event.agent] : [];
    if (agents.length === 0) {
      this.runtime.notify(`pi-navrness could not identify children for run ${event.id}.`, "warning");
      return;
    }

    await Promise.all(agents.map((agent, index) => this.openInspector(event, {
      identity: `index:${index}`,
      agent,
      index,
    })));
  }

  async handleChildStatus(payload: unknown): Promise<void> {
    if (!this.enabled) return;
    if (this.runtime.env.HERDR_ENV !== "1" || !this.runtime.env.HERDR_PANE_ID) return;

    const child = parseChildStartedEvent(payload);
    if (!child) return;
    const root = this.workflowRoots.get(child.runId);
    if (!root || root.sessionId !== this.sessionId()) return;
    if (child.asyncDir !== root.asyncDir) {
      this.runtime.notify(`pi-navrness ignored child ${child.childId}: workflow artifact identity did not match its root.`, "warning");
      return;
    }
    await this.openInspector(root, {
      identity: `workflow:${child.workflowKey}`,
      agent: child.agent,
      workflowKey: child.workflowKey,
      ...(child.stepIndex !== undefined ? { index: child.stepIndex } : {}),
    });
  }

  private notifyPaneCap(): void {
    if (this.paneBudget.capWarningShown) return;
    this.paneBudget.capWarningShown = true;
    this.runtime.notify(
      `pi-navrness reached its ${this.maxPanes}-pane process limit; additional subagents remain headless.`,
      "warning",
    );
  }

  private async openInspector(event: AsyncStartedEvent, child: InspectorChild): Promise<void> {
    const key = `${event.sessionId}:${event.id}:${child.identity}`;
    if (this.opened.has(key) || this.pending.has(key)) return;
    if (this.paneBudget.opened + this.paneBudget.reserved >= this.maxPanes) {
      this.notifyPaneCap();
      return;
    }
    this.pending.add(key);
    this.paneBudget.reserved += 1;

    let ownedPaneId: string | undefined;
    try {
      const split = await this.runtime.exec("herdr", [
        "pane",
        "split",
        "--current",
        "--direction",
        "right",
        "--cwd",
        event.cwd,
        "--no-focus",
      ]);
      if (split.code !== 0) throw new Error(split.stderr.trim() || `herdr pane split exited ${split.code}`);
      ownedPaneId = parsePaneId(split.stdout);
      if (!ownedPaneId) throw new Error("herdr pane split returned no pane id");

      const observerArgs = [
        process.execPath,
        this.observerPath,
        "--async-dir",
        event.asyncDir,
        "--run-id",
        event.id,
        ...(child.workflowKey ? ["--workflow-key", child.workflowKey] : ["--index", String(child.index)]),
        "--agent",
        child.agent,
      ];
      const command = observerArgs.map(quoteShell).join(" ");
      const started = await this.runtime.exec("herdr", ["pane", "run", ownedPaneId, command]);
      if (started.code !== 0) throw new Error(started.stderr.trim() || `herdr pane run exited ${started.code}`);
      this.opened.add(key);
      this.paneBudget.opened += 1;
    } catch (error) {
      if (ownedPaneId) await this.runtime.exec("herdr", ["pane", "close", ownedPaneId]);
      const message = error instanceof Error ? error.message : String(error);
      this.runtime.notify(`Could not open Herdr inspector for ${child.agent}: ${message}`, "error");
    } finally {
      this.pending.delete(key);
      this.paneBudget.reserved -= 1;
    }
  }
}
