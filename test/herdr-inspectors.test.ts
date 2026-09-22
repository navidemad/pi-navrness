import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import piNavrness from "../src/index.ts";
import {
  HerdrInspectorManager,
  type CommandResult,
  type InspectorPaneBudget,
  type InspectorRuntime,
} from "../src/herdr-inspectors.ts";

interface Call {
  command: string;
  args: string[];
}

function setup(options: {
  env?: NodeJS.ProcessEnv;
  sessionId?: string;
  responses?: CommandResult[];
  enabled?: boolean;
  maxPanes?: number;
  paneBudget?: InspectorPaneBudget;
} = {}) {
  const calls: Call[] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const responses = [...(options.responses ?? [])];
  let pane = 0;
  const runtime: InspectorRuntime = {
    env: options.env ?? { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
    async exec(command, args) {
      calls.push({ command, args });
      const response = responses.shift();
      if (response) return response;
      if (args[1] === "split") {
        pane += 1;
        return { stdout: JSON.stringify({ result: { pane: { pane_id: `w1:p${pane + 1}` } } }), stderr: "", code: 0 };
      }
      if (args[1] === "layout") {
        return {
          stdout: JSON.stringify({
            result: { layout: { panes: Array.from({ length: pane }, (_, index) => ({ pane_id: `w1:p${index + 2}`, rect: { width: 60, height: 60 } })) } },
          }),
          stderr: "",
          code: 0,
        };
      }
      if (args[1] === "process-info") {
        const paneId = args[3] ?? "";
        const pid = 200 + Number.parseInt(paneId.split("p").at(-1) ?? "0", 10);
        return {
          stdout: JSON.stringify({ result: { process_info: { pane_id: paneId, shell_pid: 100, foreground_process_group_id: pid, foreground_processes: [{ pid, name: "node", argv0: "node" }] } } }),
          stderr: "",
          code: 0,
        };
      }
      return { stdout: "{}", stderr: "", code: 0 };
    },
    notify(message, level) {
      notifications.push({ message, level });
    },
  };
  const manager = new HerdrInspectorManager({
    runtime,
    sessionId: () => options.sessionId ?? "session-a",
    observerPath: "/package/observer.mjs",
    enabled: options.enabled ?? true,
    maxPanes: options.maxPanes ?? 4,
    paneBudget: options.paneBudget ?? { opened: 0, reserved: 0, capWarningShown: false },
  });
  return { manager, calls, notifications };
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    lifecycleArtifactVersion: 3,
    id: "run-1",
    sessionId: "session-a",
    asyncDir: "/tmp/run-1",
    cwd: "/tmp/project",
    agent: "worker",
    agents: ["worker", "reviewer"],
    ...overrides,
  };
}

function childEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "subagent.child-status",
    version: 1,
    runId: "run-1",
    childId: "review",
    status: "started",
    asyncDir: "/tmp/run-1",
    agent: "reviewer",
    workflowKey: "review",
    childRunId: "child-run-review",
    stepIndex: 0,
    ...overrides,
  };
}

test("serializes concurrent child panes into a 65/35 layout with inspectors stacked right", async () => {
  const { manager, calls, notifications } = setup();
  await manager.handleAsyncStarted(event());

  const splits = calls.filter((call) => call.args[1] === "split");
  const runs = calls.filter((call) => call.args[1] === "run");
  assert.equal(splits.length, 2);
  assert.equal(runs.length, 2);
  assert.deepEqual(splits[0]?.args.slice(0, 9), ["pane", "split", "--current", "--direction", "right", "--ratio", "0.65", "--cwd", "/tmp/project"]);
  assert.deepEqual(splits[1]?.args.slice(0, 9), ["pane", "split", "--pane", "w1:p2", "--direction", "down", "--ratio", "0.5", "--cwd"]);
  assert.ok(runs[0]?.args[3]?.includes("--index' '0"));
  assert.ok(runs[1]?.args[3]?.includes("--index' '1"));
  assert.deepEqual(notifications, []);
});

test("subsequent inspectors split the largest owned pane, never an unrelated pane", async () => {
  const responses: CommandResult[] = [
    { stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } }), stderr: "", code: 0 },
    { stdout: "{}", stderr: "", code: 0 },
    { stdout: "{}", stderr: "", code: 0 },
    { stdout: JSON.stringify({ result: { process_info: { pane_id: "w1:p2", shell_pid: 100, foreground_process_group_id: 202, foreground_processes: [{ pid: 202, name: "node", argv0: "node" }] } } }), stderr: "", code: 0 },
    {
      stdout: JSON.stringify({
        result: {
          layout: {
            panes: [
              { pane_id: "w1:p1", rect: { width: 180, height: 60 } },
              { pane_id: "w1:p2", rect: { width: 60, height: 60 } },
            ],
          },
        },
      }),
      stderr: "",
      code: 0,
    },
    { stdout: JSON.stringify({ result: { process_info: { pane_id: "w1:p2", shell_pid: 100, foreground_process_group_id: 202, foreground_processes: [{ pid: 202, name: "node", argv0: "node" }] } } }), stderr: "", code: 0 },
    { stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p3" } } }), stderr: "", code: 0 },
    { stdout: "{}", stderr: "", code: 0 },
    { stdout: "{}", stderr: "", code: 0 },
    { stdout: JSON.stringify({ result: { process_info: { pane_id: "w1:p3", shell_pid: 100, foreground_process_group_id: 203, foreground_processes: [{ pid: 203, name: "node", argv0: "node" }] } } }), stderr: "", code: 0 },
  ];
  const { manager, calls } = setup({ responses });
  await manager.handleAsyncStarted(event());

  const splits = calls.filter((call) => call.args[1] === "split");
  assert.deepEqual(splits[1]?.args.slice(0, 8), ["pane", "split", "--pane", "w1:p2", "--direction", "down", "--ratio", "0.5"]);
});

test("later workflows stay headless after an owned observer exits or its pane closes", async () => {
  for (const unavailableLayout of [
    [{ pane_id: "w1:p2", rect: { width: 60, height: 60 } }],
    [],
  ]) {
    const responses: CommandResult[] = [
      { stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } }), stderr: "", code: 0 },
      { stdout: "{}", stderr: "", code: 0 },
      { stdout: "{}", stderr: "", code: 0 },
      { stdout: JSON.stringify({ result: { process_info: { pane_id: "w1:p2", shell_pid: 100, foreground_process_group_id: 202, foreground_processes: [{ pid: 202, name: "node", argv0: "node" }] } } }), stderr: "", code: 0 },
      { stdout: JSON.stringify({ result: { layout: { panes: unavailableLayout } } }), stderr: "", code: 0 },
      ...(unavailableLayout.length > 0
        ? [{ stdout: JSON.stringify({ result: { process_info: { pane_id: "w1:p2", shell_pid: 100, foreground_process_group_id: 100, foreground_processes: [{ pid: 100, name: "fish", argv0: "fish" }] } } }), stderr: "", code: 0 }]
        : []),
    ];
    const { manager, calls, notifications } = setup({ responses });
    await manager.handleAsyncStarted(event({ id: "first", agents: ["worker"] }));
    await manager.handleAsyncStarted(event({ id: "later", agents: ["reviewer"] }));

    assert.equal(calls.filter((call) => call.args[1] === "split").length, 1);
    assert.equal(calls.filter((call) => call.args[1] === "split" && call.args.includes("--current")).length, 1);
    assert.match(notifications.at(-1)?.message ?? "", /kept reviewer headless/);
  }
});

test("entrypoint matches persisted and ephemeral pi-subagents session identities", async () => {
  const previousHerdrEnv = process.env.HERDR_ENV;
  const previousPaneId = process.env.HERDR_PANE_ID;
  const previousVisibility = process.env.PI_NAVRNESS_HERDR_VISIBILITY;
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "w1:p1";
  process.env.PI_NAVRNESS_HERDR_VISIBILITY = "1";

  try {
    for (const session of [
      { file: "/tmp/session.jsonl", id: "session-id", expected: "/tmp/session.jsonl" },
      { file: undefined, id: "ephemeral-id", expected: "ephemeral-id" },
    ]) {
      const lifecycleHandlers = new Map<string, (payload: unknown) => void>();
      const piHandlers = new Map<string, (...args: unknown[]) => void>();
      const calls: Call[] = [];
      const fakePi = {
        events: {
          on(name: string, handler: (payload: unknown) => void) {
            lifecycleHandlers.set(name, handler);
            return () => lifecycleHandlers.delete(name);
          },
        },
        on(name: string, handler: (...args: unknown[]) => void) {
          piHandlers.set(name, handler);
        },
        registerCommand() {},
        async exec(command: string, args: string[]) {
          calls.push({ command, args });
          if (args[1] === "split") {
            return { stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } }), stderr: "", code: 0 };
          }
          return { stdout: "{}", stderr: "", code: 0 };
        },
      };
      const context = {
        sessionManager: {
          getSessionFile: () => session.file,
          getSessionId: () => session.id,
        },
        ui: { notify() {} },
      };

      piNavrness(fakePi as unknown as ExtensionAPI);
      piHandlers.get("session_start")?.({}, context as unknown as ExtensionContext);
      lifecycleHandlers.get("subagent:async-started")?.(event({ sessionId: session.expected, mode: "workflow", agent: "workflow", agents: undefined }));
      lifecycleHandlers.get("subagent:child-status")?.(childEvent({ agent: "worker" }));
      await tick();
      assert.equal(calls.filter((call) => call.args[1] === "split").length, 1);
      piHandlers.get("session_shutdown")?.();
    }
  } finally {
    if (previousHerdrEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = previousHerdrEnv;
    if (previousPaneId === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = previousPaneId;
    if (previousVisibility === undefined) delete process.env.PI_NAVRNESS_HERDR_VISIBILITY;
    else process.env.PI_NAVRNESS_HERDR_VISIBILITY = previousVisibility;
  }
});

test("suppresses duplicate lifecycle events for the same run child", async () => {
  const { manager, calls } = setup();
  await manager.handleAsyncStarted(event());
  await manager.handleAsyncStarted(event());

  assert.equal(calls.filter((call) => call.args[1] === "split").length, 2);
});

test("retains duplicate tracking across session reset", async () => {
  const { manager, calls } = setup();
  await manager.handleAsyncStarted(event({ agents: ["worker"] }));
  manager.resetSession();
  await manager.handleAsyncStarted(event({ agents: ["worker"] }));

  assert.equal(calls.filter((call) => call.args[1] === "split").length, 1);
});

test("ignores events owned by another Pi session", async () => {
  const { manager, calls } = setup();
  await manager.handleAsyncStarted(event({ sessionId: "session-b" }));
  assert.deepEqual(calls, []);
});

test("skips a whole dynamic workflow rather than mislabeling later static children", async () => {
  const { manager, calls, notifications } = setup();
  await manager.handleAsyncStarted(event({
    agents: ["worker", "reviewer"],
    workflowGraph: {
      nodes: [
        { kind: "dynamic-parallel-group", children: [{ kind: "agent", agent: "worker" }] },
        { kind: "agent", agent: "reviewer" },
      ],
    },
  }));

  assert.deepEqual(calls, []);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0]?.message ?? "", /skipped run run-1.*dynamic workflow/);
  assert.equal(notifications[0]?.level, "warning");
});

test("opens a workflow inspector from the stable keyed child lifecycle contract", async () => {
  const { manager, calls, notifications } = setup();
  await manager.handleAsyncStarted(event({ mode: "workflow", agent: "workflow", agents: undefined }));
  assert.equal(calls.length, 0, "the root event registers artifacts but does not represent a child");

  await manager.handleChildStatus(childEvent());
  await manager.handleChildStatus(childEvent());

  assert.equal(calls.filter((call) => call.args[1] === "split").length, 1);
  const run = calls.find((call) => call.args[1] === "run");
  assert.ok(run?.args[3]?.includes("--workflow-key' 'review"));
  assert.ok(run?.args[3]?.includes("--child-run-id' 'child-run-review"));
  assert.equal(run?.args[3]?.includes("--index"), false);
  assert.deepEqual(notifications, []);
});

test("uses the keyed root event instead of opening a duplicate direct workflow child", async () => {
  const { manager, calls } = setup();
  await manager.handleAsyncStarted(event({ mode: "workflow", agent: "workflow", agents: undefined }));
  await manager.handleAsyncStarted(event({
    id: "child-run-review",
    mode: "single",
    agents: ["reviewer"],
    asyncDir: "/tmp/child-run-review",
    parentWorkflowRunId: "run-1",
    workflowKey: "review",
  }));
  await manager.handleChildStatus(childEvent());

  assert.equal(calls.filter((call) => call.args[1] === "split").length, 1);
  const run = calls.find((call) => call.args[1] === "run");
  assert.ok(run?.args[3]?.includes("--run-id' 'run-1"));
  assert.ok(run?.args[3]?.includes("--child-run-id' 'child-run-review"));
});

test("rejects a keyed child whose artifact directory does not match its workflow root", async () => {
  const { manager, calls, notifications } = setup();
  await manager.handleAsyncStarted(event({ mode: "workflow", agent: "workflow", agents: undefined }));
  await manager.handleChildStatus(childEvent({ asyncDir: "/tmp/other-run" }));

  assert.deepEqual(calls, []);
  assert.match(notifications[0]?.message ?? "", /artifact identity did not match/);
});

test("caps successful panes for the process and does not reset the budget with the session", async () => {
  const paneBudget: InspectorPaneBudget = { opened: 0, reserved: 0, capWarningShown: false };
  const { manager, calls, notifications } = setup({ paneBudget, maxPanes: 4 });

  for (let index = 0; index < 6; index += 1) {
    await manager.handleAsyncStarted(event({ id: `run-${index}`, agents: ["worker"] }));
  }
  assert.equal(calls.filter((call) => call.args[1] === "split").length, 4);
  assert.equal(calls.filter((call) => call.args[1] === "close").length, 0);
  assert.equal(notifications.filter(({ message }) => message.includes("4-pane process limit")).length, 1);

  manager.resetSession();
  await manager.handleAsyncStarted(event({ id: "run-after-reset", agents: ["worker"] }));
  assert.equal(calls.filter((call) => call.args[1] === "split").length, 4);
});

test("bounds remembered workflow roots and ignores evicted children", async () => {
  const { manager, calls } = setup();
  for (let index = 0; index < 33; index += 1) {
    await manager.handleAsyncStarted(event({ id: `workflow-${index}`, mode: "workflow", agent: "workflow", agents: undefined }));
  }

  await manager.handleChildStatus(childEvent({ runId: "workflow-0", asyncDir: "/tmp/run-1" }));
  await manager.handleChildStatus(childEvent({ runId: "workflow-32", asyncDir: "/tmp/run-1" }));
  assert.equal(calls.filter((call) => call.args[1] === "split").length, 1);
});

test("does nothing outside a Herdr-managed pane", async () => {
  const { manager, calls, notifications } = setup({ env: {} });
  await manager.handleAsyncStarted(event());
  assert.deepEqual(calls, []);
  assert.deepEqual(notifications, []);
});

test("reports startup errors and closes only the pane it created", async () => {
  const responses: CommandResult[] = [
    { stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p9" } } }), stderr: "", code: 0 },
    { stdout: "", stderr: "cannot start observer", code: 1 },
  ];
  const { manager, calls, notifications } = setup({ responses });
  await manager.handleAsyncStarted(event({ agents: ["worker"] }));

  assert.deepEqual(calls.at(-1)?.args, ["pane", "close", "w1:p9"]);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0]?.message ?? "", /cannot start observer/);
  assert.equal(notifications[0]?.level, "error");
});

test("remains off until explicitly enabled when the environment does not opt in", async () => {
  const { manager, calls } = setup({ enabled: false });
  await manager.handleAsyncStarted(event());
  assert.equal(calls.length, 0);

  manager.setEnabled(true);
  await manager.handleAsyncStarted(event({ agents: ["worker"] }));
  assert.equal(calls.filter((call) => call.args[1] === "split").length, 1);
});
