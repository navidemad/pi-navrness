# pi-navrness

Small, public Pi harness extensions built around supported APIs. The first extension keeps [`pi-subagents`](https://github.com/nicobailon/pi-subagents) as the orchestration authority and gives each announced async child a passive activity pane in Herdr.

## What it does

- Listens to the documented in-process `subagent:async-started` and `subagent:child-status` events.
- Opens background Herdr panes for direct children and stable keyed workflow children announced by `pi-subagents`, up to four panes per Pi process.
- Shows direct-child log tails and the authoritative `recentOutput`/`currentTool` status fields for keyed workflow children.
- Leaves the original `subagent` tool, workflows, validation, isolation, steering, and results untouched.
- Suppresses duplicate panes and ignores runs owned by another Pi session.
- Does nothing outside a Herdr-managed pane.

The panes are **passive inspectors**, not the child processes and not additional Herdr-recognized agents. Pi and `pi-subagents` remain authoritative. Closing an inspector does not stop its child. This package never closes panes except a pane it just created when observer startup fails.

Automatic visibility has a hard four-pane budget for the lifetime of the Pi process, shared across session resets handled by that process. Reloading or starting a new OS process can create a new budget. Once the limit is reached, later children remain headless and orchestration continues unchanged. Successful panes never return capacity because the user may have repurposed them; close or reuse them manually if desired. Direct log reads are limited to the final 64 KiB, and lifecycle-root bookkeeping retains at most 32 pending workflow roots.

## Compatibility

The compatibility floor is:

- Pi `>=0.86.1`
- `pi-subagents >=0.70.1` with the keyed workflow lifecycle event patch
- Herdr `>=0.9.1`
- Node.js `>=22`

The event patch is based on `pi-subagents v0.70.1` and is available at fork commit `33456f3b6672c153b42fac9c1e99f44c6a46475c`. Vanilla `pi-subagents v0.70.1` does not include the required workflow events. Once the upstream patch is released, this README will identify the first official compatible version.

Only async roots emit the lifecycle events used here. Foreground subagents remain in Pi's normal UI. Direct single, chain, and parallel launches use their announced indices. Async `workflowScript` roots register their lifecycle artifact directory, then each `runs.run`/`runs.all` child opens from a `status: "started"` event keyed by `workflowKey`. The observer follows that key in `status.json` rather than assuming a static child position, so dynamically materialized workflow children cannot be mislabeled.

## Install from GitHub

Add both packages to Pi settings:

```json
{
  "packages": [
    "git:github.com/navidemad/pi-subagents@33456f3b6672c153b42fac9c1e99f44c6a46475c",
    "git:github.com/navidemad/pi-navrness"
  ]
}
```

Reload Pi after changing packages.

## Enable

Automatic pane creation is opt-in. Either start Pi with:

```sh
PI_NAVRNESS_HERDR_VISIBILITY=1 pi
```

or enable it for the current Pi session:

```text
/navrness-herdr on
```

Use `/navrness-herdr status` to inspect the setting and `/navrness-herdr off` to stop opening new panes. The command override lasts for the current Pi session; a new, resumed, forked, or reloaded session creates a new extension instance and returns to the environment default. Existing panes are never closed by those commands. A reload may reset the pane budget if the host reloads extension modules in a new process or isolated module context; the four-pane guarantee is process-scoped, not machine- or Herdr-session-scoped.

Then launch an async `pi-subagents` run normally. Inspectors split to the right with `--no-focus`, so the active user pane keeps focus.

## Development

```sh
npm install
npm test
npm run typecheck
```

The extension intentionally registers no model-facing tool and imports no `pi-subagents` internals. Its integration contracts are the public root event, keyed child lifecycle event, and lifecycle artifact formats documented by `pi-subagents`.
