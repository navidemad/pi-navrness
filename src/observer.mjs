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
  const childRunId = result["child-run-id"];
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
    ...(childRunId ? { childRunId } : {}),
  };
}

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_LINES = 30;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const WAITING_MESSAGE = "Waiting for child output...";

function readJson(file) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, "r");
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_METADATA_BYTES) return undefined;
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (bytesRead <= 0) return undefined;
      offset += bytesRead;
    }
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function boundedTail(text, maxLines = MAX_OUTPUT_LINES, maxBytes = MAX_OUTPUT_BYTES) {
  const bytes = Buffer.from(text);
  const bounded = bytes.length > maxBytes ? bytes.subarray(bytes.length - maxBytes).toString("utf8") : text;
  return bounded.split(/\r?\n/).filter(Boolean).slice(-maxLines).join("\n");
}

function readBoundedTail(file, maxLines = MAX_OUTPUT_LINES) {
  if (!file) return undefined;
  let descriptor;
  try {
    descriptor = fs.openSync(file, "r");
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) return undefined;
    const length = Math.min(stat.size, MAX_OUTPUT_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(descriptor, buffer, 0, length, stat.size - length);
    return boundedTail(buffer.toString("utf8"), maxLines) || undefined;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function tail(file) {
  return readBoundedTail(file) ?? WAITING_MESSAGE;
}

function withoutTrailingAcceptanceReport(text) {
  const match = text.match(/(?:^|\n)```(?:acceptance-report|acceptance_report)\s*\r?\n([\s\S]*?)\r?\n```\s*$/u);
  if (!match || match.index === undefined) return text;
  const prefix = text.slice(0, match.index).trimEnd();
  if (!prefix) return text;
  try {
    const report = JSON.parse(match[1]);
    if (!report || typeof report !== "object" || Array.isArray(report)) return text;
    return prefix;
  } catch {
    return text;
  }
}

function validReceiptEntry(entry, workflowKey, childRunId) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry) || entry.key !== workflowKey) return false;
  if (entry.latestRunId !== undefined && (typeof entry.latestRunId !== "string" || !entry.latestRunId.trim())) return false;
  const continuation = entry.continuation;
  if (!continuation || typeof continuation !== "object" || Array.isArray(continuation) || !Array.isArray(continuation.runIds)) return false;
  if (continuation.runIds.some((runId) => typeof runId !== "string" || !runId.trim())) return false;
  if (entry.latestRunId !== undefined && continuation.runIds.at(-1) !== entry.latestRunId) return false;
  const resumability = entry.resumability;
  if (!resumability || typeof resumability !== "object" || Array.isArray(resumability)) return false;
  if (resumability.state === "resumable") {
    if (entry.latestRunId === undefined) return false;
  } else if (resumability.state === "not-resumable") {
    if (typeof resumability.reason !== "string" || !resumability.reason.trim()) return false;
  } else {
    return false;
  }
  return typeof childRunId === "string" && entry.latestRunId === childRunId;
}

function terminalWorkflowReport(options, rootStatus) {
  if (!options.workflowKey || !terminalStates.has(rootStatus?.state)) return undefined;
  const receipt = readJson(path.join(options.asyncDir, "workflow-receipt.json"));
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return undefined;
  if (receipt.version !== 1 || receipt.workflowRunId !== options.runId) return undefined;
  if (!["complete", "failed", "paused", "stopped"].includes(receipt.state)) return undefined;
  if (typeof receipt.createdAt !== "number" || !Number.isFinite(receipt.createdAt)) return undefined;
  if (!receipt.entries || typeof receipt.entries !== "object" || Array.isArray(receipt.entries)) return undefined;
  const entry = receipt.entries[options.workflowKey];
  if (!validReceiptEntry(entry, options.workflowKey, options.childRunId)) return undefined;
  if (typeof entry.outputReference !== "string" || !path.isAbsolute(entry.outputReference)) return undefined;
  const report = readBoundedTail(entry.outputReference, 120);
  return report ? withoutTrailingAcceptanceReport(report) : undefined;
}

function workflowActivity(step) {
  const recentOutput = Array.isArray(step?.recentOutput)
    ? step.recentOutput.filter((line) => typeof line === "string").join("\n")
    : "";
  const output = boundedTail(recentOutput);
  const tool = typeof step?.currentTool === "string" && step.currentTool.length > 0
    ? `current tool: ${step.currentTool}`
    : "";
  return [tool, output].filter(Boolean).join("\n\n") || WAITING_MESSAGE;
}

function childRunDirectory(asyncDir, childRunId) {
  if (!childRunId || path.basename(childRunId) !== childRunId) return undefined;
  const runsDir = path.dirname(asyncDir);
  const candidate = path.resolve(runsDir, childRunId);
  return path.dirname(candidate) === runsDir ? candidate : undefined;
}

function correlatedChildStatus(options) {
  if (!options.workflowKey || !options.childRunId) return undefined;
  const asyncDir = childRunDirectory(options.asyncDir, options.childRunId);
  if (!asyncDir) return undefined;
  const status = readJson(path.join(asyncDir, "status.json"));
  if (status?.runId !== options.childRunId) return undefined;
  if (status?.parentWorkflowRunId !== options.runId || status?.workflowKey !== options.workflowKey) return undefined;
  return { asyncDir, status };
}

const options = parseArgs(process.argv.slice(2));
const statusFile = path.join(options.asyncDir, "status.json");
const terminalStates = new Set(["complete", "completed", "failed", "partial", "paused", "stopped", "rejected"]);
let terminalSince;

function render() {
  const rootStatus = readJson(statusFile);
  if (rootStatus?.runId && rootStatus.runId !== options.runId) {
    process.stderr.write("Run identity changed; observer stopped.\n");
    process.exitCode = 1;
    return false;
  }
  const rootSteps = Array.isArray(rootStatus?.steps) ? rootStatus.steps : [];
  const rootChildIndex = options.workflowKey
    ? rootSteps.findIndex((candidate) => candidate?.workflowKey === options.workflowKey)
    : options.childIndex;
  const rootStep = rootChildIndex !== undefined && rootChildIndex >= 0 ? rootSteps[rootChildIndex] : undefined;
  const correlated = correlatedChildStatus(options);
  const childSteps = Array.isArray(correlated?.status?.steps) ? correlated.status.steps : [];
  const step = correlated ? childSteps[0] : rootStep;
  const outputFile = correlated
    ? path.join(correlated.asyncDir, "output-0.log")
    : !options.workflowKey && rootChildIndex !== undefined && rootChildIndex >= 0
      ? path.join(options.asyncDir, `output-${rootChildIndex}.log`)
      : undefined;
  const runState = correlated?.status?.state ?? rootStatus?.state;
  const stepDidNotRun = rootStep?.status === "pending" && terminalStates.has(rootStatus?.state);
  const state = stepDidNotRun ? "did-not-run" : (step?.status ?? rootStep?.status ?? runState ?? "starting");
  const title = `pi-subagents · ${options.agent} · ${state}`;
  const childLabel = options.workflowKey ?? rootChildIndex ?? "pending";
  process.stdout.write(`\u001b]0;${title}\u0007\u001b[2J\u001b[H`);
  const directOutput = outputFile ? tail(outputFile) : WAITING_MESSAGE;
  const finalReport = terminalWorkflowReport(options, rootStatus);
  const activity = finalReport ?? (correlated && directOutput !== WAITING_MESSAGE
    ? directOutput
    : options.workflowKey ? workflowActivity(step) : directOutput);
  process.stdout.write(`${title}\nrun ${options.runId} · child ${childLabel}\n\n${activity}\n`);
  const observerIsTerminal = stepDidNotRun || (options.workflowKey ? terminalStates.has(rootStatus?.state) : terminalStates.has(state));
  if (observerIsTerminal) terminalSince ??= Date.now();
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
