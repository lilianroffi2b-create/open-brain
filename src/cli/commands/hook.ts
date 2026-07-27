import { defineCommand } from "citty";

import { HOOK_EVENTS, isHookEvent, type HookEvent } from "../../hooks/events.js";
import { postToolUseHook } from "../../hooks/post-tool-use.js";
import { preCompactHook } from "../../hooks/pre-compact.js";
import { preToolUseHook } from "../../hooks/pre-tool-use.js";
import { runHook, type HookHandler } from "../../hooks/runtime.js";
import { sessionStartHook } from "../../hooks/session-start.js";
import { stopHook } from "../../hooks/stop.js";
import { userPromptSubmitHook } from "../../hooks/user-prompt-submit.js";
import { registerCaptureOrgans } from "../../staging/capture.js";

/**
 * The single entry point for every hook event. One command instead of one
 * script per event is what makes the host settings merge trivially idempotent:
 * the command string is stable and unique per event, and the user has nothing
 * to install.
 *
 * This command deliberately breaks the CLI's usual error contract. Whatever
 * goes wrong, it exits 0 in silence, because the caller is a host CLI in the
 * middle of a user's session and a hook that fails loudly breaks that session.
 * An unknown event name is the one thing it will not do quietly, and even then
 * it stays inside the contract by saying so on stderr with exit 2.
 */

// Wires the pre-compaction capture organ in as this module loads, which is
// the entry point every hook process (and every test harness that imports
// handlerFor below) goes through. A call here, not a side effect of importing
// the staging layer: see registerCaptureOrgans's own doc.
registerCaptureOrgans();

const HANDLERS: Record<HookEvent, HookHandler> = {
  "session-start": sessionStartHook,
  "user-prompt-submit": userPromptSubmitHook,
  "pre-tool-use": preToolUseHook,
  "post-tool-use": postToolUseHook,
  stop: stopHook,
  "pre-compact": preCompactHook,
};

export function handlerFor(event: HookEvent): HookHandler {
  return HANDLERS[event];
}

export const hookCommand = defineCommand({
  meta: {
    name: "hook",
    description: "Run one hook event with its JSON payload on stdin. Called by your AI CLI.",
  },
  args: {
    event: {
      type: "positional",
      description: `Hook event: ${HOOK_EVENTS.join(", ")}.`,
      required: true,
    },
  },
  async run({ args }) {
    const event = typeof args.event === "string" ? args.event : "";
    if (!isHookEvent(event)) {
      process.stderr.write(
        `[open-brain hook] Unknown event "${event}". Expected one of: ${HOOK_EVENTS.join(", ")}.\n`,
      );
      process.exitCode = 2;
      return;
    }
    await runHook(event, handlerFor(event));
  },
});
