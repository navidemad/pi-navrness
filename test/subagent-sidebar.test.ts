import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { ATELIER_SIDEBAR_EVENT, SubagentSidebar } from "../src/subagent-sidebar.ts";

class EventBus {
  readonly emitted: Array<{ channel: string; data: unknown }> = [];
  private readonly handlers = new Map<string, Set<(data: unknown) => void>>();

  on(channel: string, handler: (data: unknown) => void): () => void {
    const handlers = this.handlers.get(channel) ?? new Set();
    handlers.add(handler);
    this.handlers.set(channel, handlers);
    return () => handlers.delete(handler);
  }

  emit(channel: string, data: unknown): void {
    this.emitted.push({ channel, data });
    for (const handler of this.handlers.get(channel) ?? []) handler(data);
  }
}

function rootEvent(asyncDir: string, overrides: Record<string, unknown> = {}) {
  return {
    lifecycleArtifactVersion: 3,
    id: "root-run",
    sessionId: "session-a",
    asyncDir,
    cwd: "/tmp/project",
    mode: "workflow",
    ...overrides,
  };
}

function childEvent(asyncDir: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "subagent.child-status",
    version: 1,
    runId: "root-run",
    childId: "alpha-child",
    status: "started",
    asyncDir,
    agent: "scout",
    workflowKey: "alpha",
    childRunId: "child-alpha",
    stepIndex: 0,
    ...overrides,
  };
}

function setup(options: {
  enabled?: boolean;
  now?: number;
  readJson?: (file: string) => unknown;
  readTail?: (file: string, maxLines?: number) => string | undefined;
} = {}) {
  const bus = new EventBus();
  const timers = new Map<object, () => void>();
  const clearedTimers: object[] = [];
  const sidebar = new SubagentSidebar({
    pi: { events: bus },
    sessionId: () => "session-a",
    enabled: options.enabled ?? true,
    now: () => options.now ?? 20_000,
    ...(options.readJson ? { readJson: options.readJson } : {}),
    ...(options.readTail ? { readTail: options.readTail } : {}),
    setInterval(callback) {
      const timer = { unref() {} };
      timers.set(timer, callback);
      return timer as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval(timer) {
      const key = timer as unknown as object;
      clearedTimers.push(key);
      timers.delete(key);
    },
  });
  sidebar.start();
  return { sidebar, bus, timers, clearedTimers };
}

function registrations(bus: EventBus): Record<string, unknown>[] {
  return bus.emitted
    .filter((event) => event.channel === ATELIER_SIDEBAR_EVENT)
    .map((event) => event.data)
    .filter((data): data is Record<string, unknown> => typeof data === "object" && data !== null && (data as { type?: unknown }).type === "register");
}

test("publishes one Atelier panel row per authoritative workflow child and ignores child async duplicates", () => {
  const dir = mkdtempSync(join(tmpdir(), "navrness-sidebar-"));
  try {
    writeFileSync(join(dir, "status.json"), JSON.stringify({
      runId: "root-run",
      state: "running",
      startedAt: 10_000,
      steps: [{ workflowKey: "alpha", description: "Summarize README.md", status: "running", currentTool: "read", recentOutput: ["Reading README.md"] }],
    }));
    const { sidebar, bus } = setup();
    sidebar.handleAsyncStarted(rootEvent(dir));
    sidebar.handleAsyncStarted(rootEvent(join(dirname(dir), "child-alpha"), {
      id: "child-alpha",
      mode: "single",
      parentWorkflowRunId: "root-run",
      workflowKey: "alpha",
      agent: "scout",
    }));
    sidebar.handleChildStatus(childEvent(dir));

    assert.equal(sidebar.snapshots().length, 1);
    assert.equal(sidebar.snapshots()[0]?.currentTool, "read");
    const panel = registrations(bus).at(-1)?.panel as { rows?: Array<{ text?: string }> };
    assert.match(panel.rows?.[0]?.text ?? "", /alpha · scout · running/);
    assert.equal(panel.rows?.[1]?.text, "  Summarize README.md");
    assert.match(panel.rows?.[2]?.text ?? "", /tool: read/);
    sidebar.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shows a correlated final report instead of acceptance JSON", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "navrness-sidebar-"));
  try {
    const rootDir = join(runsDir, "root-run");
    const childDir = join(runsDir, "child-alpha");
    const report = join(runsDir, "alpha.md");
    mkdirSync(rootDir);
    mkdirSync(childDir);
    writeFileSync(join(rootDir, "status.json"), JSON.stringify({
      runId: "root-run",
      state: "complete",
      endedAt: 18_000,
      steps: [{ workflowKey: "alpha", status: "completed", runId: "child-alpha" }],
    }));
    writeFileSync(join(childDir, "status.json"), JSON.stringify({
      runId: "child-alpha",
      parentWorkflowRunId: "root-run",
      workflowKey: "alpha",
      state: "complete",
      startedAt: 11_000,
      endedAt: 18_000,
      steps: [{ status: "completed" }],
    }));
    writeFileSync(report, "Readable report\nALPHA-OK\n\n```acceptance-report\n{\"criteriaSatisfied\": []}\n```\n");
    writeFileSync(join(rootDir, "workflow-receipt.json"), JSON.stringify({
      version: 1,
      workflowRunId: "root-run",
      state: "complete",
      createdAt: 18_000,
      entries: {
        alpha: {
          key: "alpha",
          latestRunId: "child-alpha",
          continuation: { runIds: ["child-alpha"] },
          resumability: { state: "resumable" },
          outputReference: report,
        },
      },
    }));
    const { sidebar } = setup();
    sidebar.handleAsyncStarted(rootEvent(rootDir));
    sidebar.handleChildStatus(childEvent(rootDir));

    const snapshot = sidebar.snapshots()[0];
    assert.equal(snapshot?.state, "completed");
    assert.equal(snapshot?.durationMs, 7_000);
    assert.equal(snapshot?.detail, "Readable report\nALPHA-OK");
    sidebar.dispose();
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});

test("detail command renders a bounded responsive view for the selected child", async () => {
  const dir = mkdtempSync(join(tmpdir(), "navrness-sidebar-"));
  try {
    writeFileSync(join(dir, "status.json"), JSON.stringify({
      runId: "root-run",
      state: "running",
      steps: [{ workflowKey: "alpha", status: "running", currentTool: "read", recentOutput: ["A long activity line that must wrap safely in a narrow detail overlay"] }],
    }));
    const { sidebar } = setup();
    sidebar.handleAsyncStarted(rootEvent(dir));
    sidebar.handleChildStatus(childEvent(dir));
    let rendered: string[] = [];
    const ctx = {
      ui: {
        select: async (_title: string, items: string[]) => items[0],
        custom: async (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: () => void) => { render(width: number): string[] }) => {
          const component = factory(
            { requestRender() {}, terminal: { columns: 80, rows: 24 } },
            { fg: (_color: string, text: string) => text, bold: (text: string) => text },
            {},
            () => undefined,
          );
          rendered = component.render(24);
        },
        notify() {},
      },
    } as unknown as ExtensionCommandContext;
    await sidebar.showDetails(ctx);
    assert.match(rendered.join("\n"), /alpha · scout · runn/);
    assert.match(rendered.join("\n"), /Activity/);
    assert.match(rendered.join("\n"), /↑↓ scroll/);
    assert.ok(rendered.every((line) => Array.from(line.replace(/\x1b\[[0-9;]*m/g, "")).length <= 24));
    sidebar.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("replays registration for Atelier discovery regardless of load order", () => {
  const { sidebar, bus } = setup();
  bus.emit(ATELIER_SIDEBAR_EVENT, { version: 1, type: "discover", requestId: "atelier-1" });
  const replay = registrations(bus).at(-1);
  assert.equal(replay?.requestId, "atelier-1");
  sidebar.dispose();
});

test("keeps per-source revisions monotonic across replacement extension instances", () => {
  const bus = new EventBus();
  const create = () => new SubagentSidebar({
    pi: { events: bus },
    sessionId: () => "session-a",
    enabled: true,
    setInterval: () => ({ unref() {} }) as unknown as ReturnType<typeof setInterval>,
    clearInterval() {},
  });
  const first = create();
  first.start();
  first.dispose();
  const second = create();
  second.start();
  const revisions = bus.emitted
    .map((event) => (event.data as { revision?: number }).revision)
    .filter((revision): revision is number => revision !== undefined);
  assert.deepEqual(revisions, [1, 2, 3]);
  second.dispose();
});

test("is opt-in and unregisters cleanly", () => {
  const { sidebar, bus, timers } = setup({ enabled: false });
  assert.equal(registrations(bus).length, 0);
  assert.equal(timers.size, 0);
  sidebar.setEnabled(true);
  assert.equal(registrations(bus).length, 1);
  assert.equal(timers.size, 0);
  sidebar.setEnabled(false);
  const last = bus.emitted.at(-1)?.data as { type?: string; id?: string };
  assert.deepEqual(last, {
    version: 1,
    type: "unregister",
    source: "pi-navrness",
    revision: 2,
    id: "pi-navrness:subagents",
  });
  sidebar.dispose();
});

test("shares root artifact reads across siblings and does not republish unchanged panels", () => {
  const dir = mkdtempSync(join(tmpdir(), "navrness-sidebar-"));
  try {
    writeFileSync(join(dir, "status.json"), JSON.stringify({
      runId: "root-run",
      state: "running",
      steps: [
        { workflowKey: "alpha", status: "running", currentTool: "read" },
        { workflowKey: "beta", status: "running", currentTool: "bash" },
      ],
    }));
    const reads = new Map<string, number>();
    const { sidebar, bus, timers } = setup({
      readJson(file) {
        reads.set(file, (reads.get(file) ?? 0) + 1);
        try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; }
      },
    });
    sidebar.handleAsyncStarted(rootEvent(dir));
    sidebar.handleChildStatus(childEvent(dir));
    sidebar.handleChildStatus(childEvent(dir, { childId: "beta-child", workflowKey: "beta", childRunId: "child-beta", stepIndex: 1 }));
    reads.clear();
    const before = registrations(bus).length;
    const tick = [...timers.values()][0];
    assert.ok(tick);
    tick();
    assert.equal(reads.get(join(dir, "status.json")), 1);
    assert.equal(reads.get(join(dir, "workflow-receipt.json")) ?? 0, 0);
    assert.equal(registrations(bus).length, before);
    sidebar.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stops terminal polling after a bounded receipt grace and restarts for a new lifecycle event", () => {
  const firstDir = mkdtempSync(join(tmpdir(), "navrness-sidebar-"));
  const secondDir = mkdtempSync(join(tmpdir(), "navrness-sidebar-"));
  try {
    writeFileSync(join(firstDir, "status.json"), JSON.stringify({
      runId: "root-run", state: "complete", endedAt: 20_000,
      steps: [{ workflowKey: "alpha", status: "completed", runId: "child-alpha" }],
    }));
    writeFileSync(join(secondDir, "status.json"), JSON.stringify({
      runId: "root-two", state: "running", steps: [{ workflowKey: "gamma", status: "running" }],
    }));
    const { sidebar, timers, clearedTimers } = setup();
    sidebar.handleAsyncStarted(rootEvent(firstDir));
    sidebar.handleChildStatus(childEvent(firstDir));
    for (let index = 0; index < 4; index += 1) [...timers.values()][0]?.();
    assert.equal(timers.size, 0);
    assert.ok(clearedTimers.length > 0);

    sidebar.handleAsyncStarted(rootEvent(secondDir, { id: "root-two" }));
    sidebar.handleChildStatus(childEvent(secondDir, { runId: "root-two", childId: "gamma-child", workflowKey: "gamma", childRunId: "child-gamma" }));
    assert.equal(timers.size, 1);
    sidebar.dispose();
  } finally {
    rmSync(firstDir, { recursive: true, force: true });
    rmSync(secondDir, { recursive: true, force: true });
  }
});

test("captures a final report when its receipt appears during terminal grace", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "navrness-sidebar-"));
  try {
    const rootDir = join(runsDir, "root-run");
    const report = join(runsDir, "alpha.md");
    mkdirSync(rootDir);
    writeFileSync(join(rootDir, "status.json"), JSON.stringify({
      runId: "root-run", state: "complete", endedAt: 20_000,
      steps: [{ workflowKey: "alpha", status: "completed", runId: "child-alpha" }],
    }));
    const { sidebar, timers } = setup();
    sidebar.handleAsyncStarted(rootEvent(rootDir));
    sidebar.handleChildStatus(childEvent(rootDir));
    assert.equal(sidebar.snapshots()[0]?.hasFinalReport, false);

    const readableReport = [
      "# Code Context",
      "## Files Retrieved",
      "Pi Navrness exposes subagent activity without moving the agents.",
      "ALPHA-OK",
    ].join("\n");
    writeFileSync(report, `${readableReport}\n`);
    writeFileSync(join(rootDir, "workflow-receipt.json"), JSON.stringify({
      version: 1, workflowRunId: "root-run", state: "complete", createdAt: 20_001,
      entries: { alpha: { key: "alpha", latestRunId: "child-alpha", continuation: { runIds: ["child-alpha"] }, resumability: { state: "resumable" }, outputReference: report } },
    }));
    [...timers.values()][0]?.();
    assert.equal(sidebar.snapshots()[0]?.detail, readableReport);
    assert.equal(sidebar.snapshots()[0]?.summary, "Pi Navrness exposes subagent activity without moving the agents.");
    assert.equal(sidebar.snapshots()[0]?.hasFinalReport, true);
    assert.equal(timers.size, 0);
    sidebar.dispose();
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});

test("suppresses redacted and technical placeholder summaries without inventing replacements", () => {
  const dir = mkdtempSync(join(tmpdir(), "navrness-sidebar-"));
  try {
    writeFileSync(join(dir, "status.json"), JSON.stringify({
      runId: "root-run", state: "running",
      steps: [{ workflowKey: "alpha", status: "running", description: "[prompt redacted]", recentOutput: ["# Code Context", "## Files Retrieved", "###### Details", "**Output:**"] }],
    }));
    const { sidebar, bus } = setup();
    sidebar.handleAsyncStarted(rootEvent(dir));
    sidebar.handleChildStatus(childEvent(dir));
    const snapshot = sidebar.snapshots()[0];
    assert.equal(snapshot?.task, undefined);
    assert.equal(snapshot?.summary, undefined);
    const panel = registrations(bus).at(-1)?.panel as { rows: Array<{ text: string }> };
    assert.deepEqual(panel.rows.map((row) => row.text), ["alpha · scout · running · 0s"]);
    sidebar.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("keeps an error visible ahead of the active tool and routine technical activity", () => {
  const dir = mkdtempSync(join(tmpdir(), "navrness-sidebar-"));
  try {
    writeFileSync(join(dir, "status.json"), JSON.stringify({
      runId: "root-run", state: "running",
      steps: [{ workflowKey: "alpha", status: "running", currentTool: "bash", recentOutput: ["daemon: running", "Reading files", "Command exited with code 1"] }],
    }));
    const { sidebar } = setup();
    sidebar.handleAsyncStarted(rootEvent(dir));
    sidebar.handleChildStatus(childEvent(dir));
    assert.equal(sidebar.snapshots()[0]?.summary, "Command exited with code 1");
    assert.equal(sidebar.snapshots()[0]?.currentTool, "bash");
    sidebar.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detail overlay is framed, scrollable, toggles raw activity, and cleans up its timer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "navrness-sidebar-"));
  try {
    writeFileSync(join(dir, "status.json"), JSON.stringify({
      runId: "root-run", state: "running",
      steps: [{ workflowKey: "alpha", status: "running", recentOutput: Array.from({ length: 30 }, (_, index) => `activity ${index}`) }],
    }));
    const { sidebar, timers, clearedTimers } = setup();
    sidebar.handleAsyncStarted(rootEvent(dir));
    sidebar.handleChildStatus(childEvent(dir));
    let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
    let overlayOptions: unknown;
    const ctx = {
      ui: {
        select: async (_title: string, items: string[]) => items[0],
        custom: async (factory: Function, options: { overlayOptions?: unknown }) => {
          overlayOptions = options.overlayOptions;
          component = factory(
            { requestRender() {}, terminal: { columns: 100, rows: 24 } },
            { fg: (_color: string, text: string) => text, bold: (text: string) => text },
            {},
            () => undefined,
          );
          const first = component?.render(50) ?? [];
          assert.match(first[0] ?? "", /─/);
          assert.match(first.at(-1) ?? "", /─/);
          assert.match(first.join("\n"), /↑↓ scroll/);
          component?.handleInput(Key.down);
          component?.handleInput("r");
        },
        notify() {},
      },
    } as unknown as ExtensionCommandContext;
    const timersBefore = timers.size;
    await sidebar.showDetails(ctx);
    assert.deepEqual(overlayOptions, { width: "62%", minWidth: 44, maxHeight: "76%", anchor: "left-center", margin: 2 });
    assert.equal(timers.size, timersBefore);
    assert.ok(clearedTimers.length > 0);
    sidebar.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects cross-session roots and mismatched child artifact directories", () => {
  const { sidebar } = setup();
  sidebar.handleAsyncStarted(rootEvent("/tmp/root", { sessionId: "other-session" }));
  sidebar.handleChildStatus(childEvent("/tmp/root"));
  assert.equal(sidebar.snapshots().length, 0);

  sidebar.handleAsyncStarted(rootEvent("/tmp/root"));
  sidebar.handleChildStatus(childEvent("/tmp/other"));
  assert.equal(sidebar.snapshots().length, 0);
  sidebar.dispose();
});
