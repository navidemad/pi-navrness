import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ASYNC_STARTED_EVENT, CHILD_STATUS_EVENT, HerdrInspectorManager } from "./herdr-inspectors.ts";

export function resolveSessionIdentity(context: ExtensionContext | undefined): string | undefined {
  return context?.sessionManager.getSessionFile() ?? context?.sessionManager.getSessionId();
}

export default function piNavrness(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  const manager = new HerdrInspectorManager({
    runtime: {
      env: process.env,
      exec: (command, args) => pi.exec(command, args, { timeout: 15_000 }),
      notify: (message, level) => context?.ui.notify(message, level),
    },
    sessionId: () => resolveSessionIdentity(context),
  });

  let unsubscribeAsyncStarted: (() => void) | undefined;
  let unsubscribeChildStatus: (() => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    unsubscribeAsyncStarted ??= pi.events.on(ASYNC_STARTED_EVENT, (payload) => {
      void manager.handleAsyncStarted(payload);
    });
    unsubscribeChildStatus ??= pi.events.on(CHILD_STATUS_EVENT, (payload) => {
      void manager.handleChildStatus(payload);
    });
  });
  pi.on("session_shutdown", () => {
    unsubscribeAsyncStarted?.();
    unsubscribeAsyncStarted = undefined;
    unsubscribeChildStatus?.();
    unsubscribeChildStatus = undefined;
    manager.resetSession();
    context = undefined;
  });

  pi.registerCommand("navrness-herdr", {
    description: "Control opt-in Herdr inspector panes for new pi-subagents runs",
    handler: async (args, ctx) => {
      context = ctx;
      const action = args.trim().toLowerCase();
      if (action === "on") manager.setEnabled(true);
      else if (action === "off") manager.setEnabled(false);
      else if (action && action !== "status") {
        ctx.ui.notify("Usage: /navrness-herdr [on|off|status]", "warning");
        return;
      }
      ctx.ui.notify(`Automatic Herdr inspectors are ${manager.isEnabled() ? "enabled" : "disabled"} for this Pi session.`, "info");
    },
  });
}
