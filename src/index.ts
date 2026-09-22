import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ASYNC_STARTED_EVENT, CHILD_STATUS_EVENT, HerdrInspectorManager } from "./herdr-inspectors.ts";
import { SubagentSidebar } from "./subagent-sidebar.ts";

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
  const sidebar = new SubagentSidebar({
    pi,
    sessionId: () => resolveSessionIdentity(context),
  });

  let unsubscribeAsyncStarted: (() => void) | undefined;
  let unsubscribeChildStatus: (() => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    sidebar.start();
    unsubscribeAsyncStarted ??= pi.events.on(ASYNC_STARTED_EVENT, (payload) => {
      sidebar.handleAsyncStarted(payload);
      void manager.handleAsyncStarted(payload);
    });
    unsubscribeChildStatus ??= pi.events.on(CHILD_STATUS_EVENT, (payload) => {
      sidebar.handleChildStatus(payload);
      void manager.handleChildStatus(payload);
    });
  });
  pi.on("session_shutdown", () => {
    unsubscribeAsyncStarted?.();
    unsubscribeAsyncStarted = undefined;
    unsubscribeChildStatus?.();
    unsubscribeChildStatus = undefined;
    manager.resetSession();
    sidebar.dispose();
    context = undefined;
  });

  pi.registerCommand("navrness-agents", {
    description: "Show or control the opt-in pi-subagents panel for Pi Atelier",
    handler: async (args, ctx) => {
      context = ctx;
      const action = args.trim().toLowerCase();
      if (action === "on") sidebar.setEnabled(true);
      else if (action === "off") sidebar.setEnabled(false);
      else if (action === "status") {
        ctx.ui.notify(`The pi-navrness Atelier panel is ${sidebar.isEnabled() ? "enabled" : "disabled"}.`, "info");
        return;
      } else if (action) {
        ctx.ui.notify("Usage: /navrness-agents [on|off|status]", "warning");
        return;
      } else {
        await sidebar.showDetails(ctx);
        return;
      }
      ctx.ui.notify(`The pi-navrness Atelier panel is ${sidebar.isEnabled() ? "enabled" : "disabled"}.`, "info");
    },
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
