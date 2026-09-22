# pi-navrness

Small, public Pi harness extensions built around supported APIs. The first extension keeps [`pi-subagents`](https://github.com/nicobailon/pi-subagents) as the orchestration authority and exposes its async children in the [Pi Atelier](https://github.com/michaelmjhhhh/pi-atelier) sidebar. Passive Herdr inspector panes remain available as a separate opt-in.

## What it does

- Listens to the documented in-process `subagent:async-started` and `subagent:child-status` events.
- Contributes a bounded `Subagents` panel through Pi Atelier's public sidebar-panel protocol, without replacing Pi's footer, editor, or `subagent` tool.
- Shows each child key/name, agent, state, duration, current tool, and a safe substantive activity preview; redacted prompts and technical placeholder headings stay hidden.
- `/navrness-agents` opens a framed, scrollable detail view that prefers the final report and can toggle to raw bounded activity with `r`.
- Hides the panel automatically with Atelier on narrow terminals and leaves transcript input focused.
- Optionally opens background Herdr panes for direct children and stable keyed workflow children announced by `pi-subagents`, up to four panes per Pi process.
- Shows direct-child log tails and the authoritative `recentOutput`/`currentTool` status fields for keyed workflow children.
- Keeps Pi at roughly 65% width on the left and stacks inspector panes in the right-hand region.
- Prefers each keyed child's recorded `outputReference` after the workflow settles; a valid trailing acceptance-report block is hidden when readable report text precedes it.
- Leaves the original `subagent` tool, workflows, validation, isolation, steering, and results untouched.
- Suppresses duplicate panes and ignores runs owned by another Pi session.
- Does nothing outside a Herdr-managed pane.

The Atelier panel is presentation-only. While children are active, it polls bounded, read-only lifecycle artifacts once per second, sharing each workflow-root read across siblings. It retains final snapshots and stops polling after settlement, with a short bounded grace period for the terminal receipt. It never writes session artifacts. Newly contributed Atelier panels are hidden until enabled once in **Atelier Settings → Display → Sidebar panels**.

The optional Herdr panes are **passive inspectors**, not the child processes and not additional Herdr-recognized agents. Pi and `pi-subagents` remain authoritative. Closing an inspector does not stop its child. This package never closes panes except a pane it just created when observer startup fails.

Automatic visibility has a hard four-pane budget for the lifetime of the Pi process, shared across session resets handled by that process. Reloading or starting a new OS process can create a new budget. Once the limit is reached, later children remain headless and orchestration continues unchanged. Successful panes never return capacity because the user may have repurposed them; close or reuse them manually if desired. Direct log reads are limited to the final 64 KiB, and lifecycle-root bookkeeping retains at most 32 pending workflow roots.

## Compatibility

The compatibility floor is:

- Pi `>=0.86.1`
- `pi-subagents >=0.70.1` with the keyed workflow lifecycle event patch
- Pi Atelier `>=0.10.2` for the integrated sidebar
- Herdr `>=0.9.1` only for optional inspector panes
- Node.js `>=22`

The event patch is based on `pi-subagents v0.70.1` and is available at fork commit `33456f3b6672c153b42fac9c1e99f44c6a46475c`. Vanilla `pi-subagents v0.70.1` does not include the required workflow events. Once the upstream patch is released, this README will identify the first official compatible version.

Only async roots emit the lifecycle events used here. Foreground subagents remain in Pi's normal UI. Direct single, chain, and parallel launches use their announced indices. Async `workflowScript` roots register their lifecycle artifact directory, then each `runs.run`/`runs.all` child opens from a `status: "started"` event keyed by `workflowKey`. The observer follows that key in `status.json` rather than assuming a static child position, so dynamically materialized workflow children cannot be mislabeled.

## Install from GitHub

Add both packages to Pi settings:

```json
{
  "packages": [
    "npm:pi-atelier@0.10.2",
    "git:github.com/navidemad/pi-subagents@33456f3b6672c153b42fac9c1e99f44c6a46475c",
    "git:github.com/navidemad/pi-navrness"
  ]
}
```

Reload Pi after changing packages.

## Enable

The integrated Atelier panel is opt-in. Either start Pi with:

```sh
PI_NAVRNESS_SIDEBAR=1 pi
```

or enable it for the current session:

```text
/navrness-agents on
```

Open **`/atelier display`** once and enable `pi-navrness:subagents` under Sidebar panels. Run `/navrness-agents` to select a child and open its bounded live activity or final report. `/navrness-agents status` reports the setting and `/navrness-agents off` unregisters the panel.

This integration uses Atelier's public contribution protocol. It does not copy Atelier's split implementation, patch Pi's private TUI layout, or take ownership of the footer/editor.

Automatic Herdr pane creation is a separate opt-in. Either start Pi with:

```sh
PI_NAVRNESS_HERDR_VISIBILITY=1 pi
```

or enable it for the current Pi session:

```text
/navrness-herdr on
```

Use `/navrness-herdr status` to inspect the setting and `/navrness-herdr off` to stop opening new panes. The command override lasts for the current Pi session; a new, resumed, forked, or reloaded session creates a new extension instance and returns to the environment default. Existing panes are never closed by those commands. A reload may reset the pane budget if the host reloads extension modules in a new process or isolated module context; the four-pane guarantee is process-scoped, not machine- or Herdr-session-scoped.

Then launch an async `pi-subagents` run normally. The first inspector reserves the right 35% with `--no-focus`; later inspectors stack downward only while the same owned observer process is still running. After that observer exits or its pane is closed or reused, later children stay headless rather than splitting the parent or user work.

At terminal settlement, a keyed inspector reads only the `outputReference` recorded for its exact workflow key and child run in a valid terminal v1 `workflow-receipt.json`. Reads are bounded. If the receipt or report is missing or invalid, the inspector keeps the correlated child log as its fallback rather than inventing a summary.

### Local smoke test

From a local checkout, load Atelier, the patched `pi-subagents`, and this extension without changing installed packages:

```sh
cd /path/to/pi-navrness
env PI_NAVRNESS_SIDEBAR=1 pi --no-extensions \
  -e /path/to/pi-atelier \
  -e /path/to/pi-subagents/index.ts \
  -e /path/to/pi-navrness/src/index.ts
```

In Pi, run `/atelier sidebar on`, then `/atelier display` and enable the contributed `pi-navrness:subagents` panel once. Launch an async two-child `workflowScript`. Expect the sidebar to list both children and update their state/tool/duration without taking editor focus. Run `/navrness-agents` to select a child and inspect its live detail or readable final report.

To smoke-test Herdr panes instead, add `PI_NAVRNESS_HERDR_VISIBILITY=1` and run `/navrness-herdr status`.

## Development

```sh
npm install
npm test
npm run typecheck
```

The extension intentionally registers no model-facing tool and imports no `pi-subagents` internals. Its integration contracts are the public root event, keyed child lifecycle event, and lifecycle artifact formats documented by `pi-subagents`.
