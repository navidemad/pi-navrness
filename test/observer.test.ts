import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
