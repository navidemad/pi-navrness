#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("Invalid observer arguments.");
    result[key.slice(2)] = value;
  }
  const childIndex = result.index === undefined ? undefined : Number.parseInt(result.index, 10);
  const workflowKey = result["workflow-key"];
  const hasIndex = Number.isInteger(childIndex) && childIndex >= 0;
  if (!result["async-dir"] || !result["run-id"] || !result.agent || (!hasIndex && !workflowKey)) {
    throw new Error("Observer requires --async-dir, --run-id, --agent, and either --index or --workflow-key.");
  }
  return {
    asyncDir: path.resolve(result["async-dir"]),
    runId: result["run-id"],
    agent: result.agent,
    ...(hasIndex ? { childIndex } : {}),
    ...(workflowKey ? { workflowKey } : {}),
  };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_LINES = 30;

function boundedTail(text, maxLines = MAX_OUTPUT_LINES, maxBytes = MAX_OUTPUT_BYTES) {
  const bytes = Buffer.from(text);
  const bounded = bytes.length > maxBytes ? bytes.subarray(bytes.length - maxBytes).toString("utf8") : text;
  return bounded.split(/\r?\n/).filter(Boolean).slice(-maxLines).join("\n");
}

function tail(file) {
  if (!file) return "Waiting for child output...";
  let descriptor;
  try {
    descriptor = fs.openSync(file, "r");
    const size = fs.fstatSync(descriptor).size;
    const length = Math.min(size, MAX_OUTPUT_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(descriptor, buffer, 0, length, size - length);
    return boundedTail(buffer.toString("utf8")) || "Waiting for child output...";
  } catch {
    return "Waiting for child output...";
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function workflowActivity(step) {
  const recentOutput = Array.isArray(step?.recentOutput)
    ? step.recentOutput.filter((line) => typeof line === "string").join("\n")
    : "";
  const output = boundedTail(recentOutput);
  const tool = typeof step?.currentTool === "string" && step.currentTool.length > 0
    ? `current tool: ${step.currentTool}`
    : "";
  return [tool, output].filter(Boolean).join("\n\n") || "Waiting for child output...";
}

const options = parseArgs(process.argv.slice(2));
const statusFile = path.join(options.asyncDir, "status.json");
const terminalStates = new Set(["complete", "completed", "failed", "partial", "paused", "stopped", "rejected"]);
let terminalSince;

function render() {
  const status = readJson(statusFile);
  if (status?.runId && status.runId !== options.runId) {
    process.stderr.write("Run identity changed; observer stopped.\n");
    process.exitCode = 1;
    return false;
  }
  const steps = Array.isArray(status?.steps) ? status.steps : [];
  const childIndex = options.workflowKey
    ? steps.findIndex((candidate) => candidate?.workflowKey === options.workflowKey)
    : options.childIndex;
  const step = childIndex !== undefined && childIndex >= 0 ? steps[childIndex] : undefined;
  const outputFile = !options.workflowKey && childIndex !== undefined && childIndex >= 0
    ? path.join(options.asyncDir, `output-${childIndex}.log`)
    : undefined;
  const runState = status?.state;
  const stepDidNotRun = step?.status === "pending" && terminalStates.has(runState);
  const state = stepDidNotRun ? "did-not-run" : (step?.status ?? runState ?? "starting");
  const title = `pi-subagents · ${options.agent} · ${state}`;
  const childLabel = options.workflowKey ?? childIndex ?? "pending";
  process.stdout.write(`\u001b]0;${title}\u0007\u001b[2J\u001b[H`);
  const activity = options.workflowKey ? workflowActivity(step) : tail(outputFile);
  process.stdout.write(`${title}\nrun ${options.runId} · child ${childLabel}\n\n${activity}\n`);
  if (stepDidNotRun || terminalStates.has(state)) terminalSince ??= Date.now();
  else terminalSince = undefined;
  return terminalSince === undefined || Date.now() - terminalSince < 5_000;
}

if (render()) {
  const timer = setInterval(() => {
    if (!render()) clearInterval(timer);
  }, 500);
  process.on("SIGINT", () => {
    clearInterval(timer);
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    clearInterval(timer);
    process.exit(0);
  });
}
