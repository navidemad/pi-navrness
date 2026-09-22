import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const observerPath = new URL("../src/observer.mjs", import.meta.url);

test("a keyed running workflow child renders status activity without an output log", async () => {
  const asyncDir = mkdtempSync(join(tmpdir(), "pi-navrness-observer-"));
  try {
    writeFileSync(join(asyncDir, "status.json"), JSON.stringify({
      runId: "run-live-workflow",
      state: "running",
      steps: [{
        status: "running",
        workflowKey: "review",
        currentTool: "read",
        recentOutput: ["Inspecting the relevant source", "Found the lifecycle seam"],
      }],
    }));

    const child = spawn(process.execPath, [
      observerPath.pathname,
      "--async-dir",
      asyncDir,
      "--run-id",
      "run-live-workflow",
      "--workflow-key",
      "review",
      "--agent",
      "reviewer",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`observer output timed out: ${output}`));
      }, 4_000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
        if (!output.includes("Found the lifecycle seam")) return;
        clearTimeout(timeout);
        resolve();
      });
      child.once("error", reject);
    });
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));

    assert.match(output, /current tool: read/);
    assert.match(output, /Inspecting the relevant source/);
    assert.equal(output.includes("Waiting for child output"), false);
  } finally {
    rmSync(asyncDir, { recursive: true, force: true });
  }
});

test("a keyed workflow observer falls back to its correlated child log when no final report exists", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "pi-navrness-observer-runs-"));
  const rootDir = join(runsDir, "workflow-root");
  const childDir = join(runsDir, "child-alpha");
  try {
    mkdirSync(rootDir);
    mkdirSync(childDir);
    writeFileSync(join(rootDir, "status.json"), JSON.stringify({
      runId: "workflow-root",
      state: "complete",
      steps: [{ status: "completed", workflowKey: "alpha", runId: "child-alpha", recentOutput: [] }],
    }));
    writeFileSync(join(childDir, "status.json"), JSON.stringify({
      runId: "child-alpha",
      parentWorkflowRunId: "workflow-root",
      workflowKey: "alpha",
      state: "complete",
      steps: [{ status: "completed" }],
    }));
    const unrelatedReport = join(runsDir, "unrelated.md");
    writeFileSync(join(rootDir, "workflow-receipt.json"), JSON.stringify({
      version: 1,
      workflowRunId: "another-workflow",
      state: "complete",
      createdAt: 1,
      entries: {
        alpha: {
          key: "alpha",
          latestRunId: "child-alpha",
          continuation: { runIds: ["child-alpha"] },
          resumability: { state: "not-resumable", reason: "complete" },
          outputReference: unrelatedReport,
        },
      },
    }));
    writeFileSync(unrelatedReport, "MUST-NOT-RENDER\n");
    writeFileSync(join(childDir, "output-0.log"), "actual child output\nALPHA-OK\n");

    const result = spawnSync(process.execPath, [
      observerPath.pathname,
      "--async-dir",
      rootDir,
      "--run-id",
      "workflow-root",
      "--workflow-key",
      "alpha",
      "--child-run-id",
      "child-alpha",
      "--agent",
      "scout",
    ], { encoding: "utf8", timeout: 8_000 });

    assert.equal(result.error, undefined);
    assert.match(result.stdout, /actual child output/);
    assert.match(result.stdout, /ALPHA-OK/);
    assert.doesNotMatch(result.stdout, /Waiting for child output/);
    assert.doesNotMatch(result.stdout, /MUST-NOT-RENDER/);
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});

test("a terminal keyed workflow child prefers its readable report and hides a valid trailing acceptance block", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "pi-navrness-observer-report-"));
  const rootDir = join(runsDir, "workflow-root");
  const childDir = join(runsDir, "child-alpha");
  const reportPath = join(runsDir, "alpha.md");
  try {
    mkdirSync(rootDir);
    mkdirSync(childDir);
    writeFileSync(join(rootDir, "status.json"), JSON.stringify({
      runId: "workflow-root",
      state: "complete",
      steps: [{ status: "completed", workflowKey: "alpha", runId: "child-alpha" }],
    }));
    writeFileSync(join(rootDir, "workflow-receipt.json"), JSON.stringify({
      version: 1,
      workflowRunId: "workflow-root",
      state: "complete",
      createdAt: 1,
      entries: {
        alpha: {
          key: "alpha",
          latestRunId: "child-alpha",
          continuation: { runIds: ["child-alpha"] },
          resumability: { state: "not-resumable", reason: "complete" },
          outputReference: reportPath,
        },
      },
    }));
    writeFileSync(join(childDir, "status.json"), JSON.stringify({
      runId: "child-alpha",
      parentWorkflowRunId: "workflow-root",
      workflowKey: "alpha",
      state: "complete",
      steps: [{ status: "completed" }],
    }));
    writeFileSync(join(childDir, "output-0.log"), "raw live output\nacceptance JSON follows\n");
    writeFileSync(reportPath, [
      "# Final report",
      "",
      "Readable result. ALPHA-OK",
      "",
      "```acceptance-report",
      JSON.stringify({ criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "done" }] }),
      "```",
      "",
    ].join("\n"));

    const result = spawnSync(process.execPath, [
      observerPath.pathname,
      "--async-dir",
      rootDir,
      "--run-id",
      "workflow-root",
      "--workflow-key",
      "alpha",
      "--child-run-id",
      "child-alpha",
      "--agent",
      "scout",
    ], { encoding: "utf8", timeout: 8_000 });

    assert.equal(result.error, undefined);
    assert.match(result.stdout, /# Final report/);
    assert.match(result.stdout, /Readable result\. ALPHA-OK/);
    assert.doesNotMatch(result.stdout, /criteriaSatisfied/);
    assert.doesNotMatch(result.stdout, /raw live output/);
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});

test("malformed workflow receipts fall back to the exact correlated child log", async (t) => {
  const cases = [
    ["unsupported version", { version: 2 }],
    ["non-terminal receipt state", { state: "completed" }],
    ["invalid entry lineage", { entry: { continuation: { runIds: ["other-child"] } } }],
    ["mismatched child run", { entry: { latestRunId: "other-child", continuation: { runIds: ["other-child"] } } }],
  ] as const;

  for (const [name, mutation] of cases) {
    await t.test(name, () => {
      const runsDir = mkdtempSync(join(tmpdir(), "pi-navrness-observer-malformed-"));
      const rootDir = join(runsDir, "workflow-root");
      const childDir = join(runsDir, "child-alpha");
      const redirectedReport = join(runsDir, "redirected.md");
      try {
        mkdirSync(rootDir);
        mkdirSync(childDir);
        writeFileSync(join(rootDir, "status.json"), JSON.stringify({
          runId: "workflow-root",
          state: "complete",
          steps: [{ status: "completed", workflowKey: "alpha", runId: "child-alpha" }],
        }));
        writeFileSync(join(childDir, "status.json"), JSON.stringify({
          runId: "child-alpha",
          parentWorkflowRunId: "workflow-root",
          workflowKey: "alpha",
          state: "complete",
          steps: [{ status: "completed" }],
        }));
        writeFileSync(join(childDir, "output-0.log"), "correlated fallback\nALPHA-OK\n");
        writeFileSync(redirectedReport, "MUST-NOT-RENDER\n");
        const baseEntry = {
          key: "alpha",
          latestRunId: "child-alpha",
          continuation: { runIds: ["child-alpha"] },
          resumability: { state: "not-resumable", reason: "complete" },
          outputReference: redirectedReport,
        };
        writeFileSync(join(rootDir, "workflow-receipt.json"), JSON.stringify({
          version: 1,
          workflowRunId: "workflow-root",
          state: "complete",
          createdAt: 1,
          entries: { alpha: { ...baseEntry, ...("entry" in mutation ? mutation.entry : {}) } },
          ...("entry" in mutation ? {} : mutation),
        }));

        const result = spawnSync(process.execPath, [
          observerPath.pathname,
          "--async-dir",
          rootDir,
          "--run-id",
          "workflow-root",
          "--workflow-key",
          "alpha",
          "--child-run-id",
          "child-alpha",
          "--agent",
          "scout",
        ], { encoding: "utf8", timeout: 8_000 });

        assert.equal(result.error, undefined);
        assert.match(result.stdout, /correlated fallback/);
        assert.match(result.stdout, /ALPHA-OK/);
        assert.doesNotMatch(result.stdout, /MUST-NOT-RENDER/);
      } finally {
        rmSync(runsDir, { recursive: true, force: true });
      }
    });
  }
});

test("direct child log reads are bounded to the final 64 KiB", () => {
  const asyncDir = mkdtempSync(join(tmpdir(), "pi-navrness-observer-"));
  try {
    writeFileSync(join(asyncDir, "status.json"), JSON.stringify({
      runId: "run-large-log",
      state: "complete",
      steps: [{ status: "completed" }],
    }));
    writeFileSync(join(asyncDir, "output-0.log"), `discarded-prefix\n${"x".repeat(70 * 1024)}\nretained-tail\n`);

    const result = spawnSync(process.execPath, [
      observerPath.pathname,
      "--async-dir",
      asyncDir,
      "--run-id",
      "run-large-log",
      "--index",
      "0",
      "--agent",
      "worker",
    ], { encoding: "utf8", timeout: 8_000 });

    assert.equal(result.error, undefined);
    assert.doesNotMatch(result.stdout, /discarded-prefix/);
    assert.match(result.stdout, /retained-tail/);
  } finally {
    rmSync(asyncDir, { recursive: true, force: true });
  }
});

test("a pending child in a terminal run is shown as did-not-run and the observer exits", () => {
  const asyncDir = mkdtempSync(join(tmpdir(), "pi-navrness-observer-"));
  try {
    writeFileSync(join(asyncDir, "status.json"), JSON.stringify({
      runId: "run-failed-chain",
      state: "failed",
      steps: [
        { status: "failed", workflowKey: "writer" },
        { status: "pending", workflowKey: "review" },
      ],
    }));

    const result = spawnSync(process.execPath, [
      observerPath.pathname,
      "--async-dir",
      asyncDir,
      "--run-id",
      "run-failed-chain",
      "--workflow-key",
      "review",
      "--agent",
      "reviewer",
    ], { encoding: "utf8", timeout: 8_000 });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /pi-subagents · reviewer · did-not-run/);
  } finally {
    rmSync(asyncDir, { recursive: true, force: true });
  }
});
