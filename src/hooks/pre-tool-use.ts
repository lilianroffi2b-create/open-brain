import type { GuardInput, GuardVerdict } from "../staging/guard.js";
import { payloadRecord, payloadString } from "./events.js";
import type { HookContext, HookOutcome } from "./runtime.js";

/**
 * The pre-effect guard, reduced to its wiring. Every rule, every path, every
 * refusal lives in the staging guard; this file only turns a host payload into
 * a GuardInput and hands the verdict back to the runtime.
 *
 *   deny  -> the runtime renders permissionDecision "deny", the host's
 *            first-class refusal: the tool call does not happen
 *   allow -> silence, exit 0
 *
 * The refusal is deliberately not a soft block. A soft block hands text back to
 * the assistant and lets it decide, which is the wrong shape for a red line: on
 * the preference kernel the call has to be stopped, not argued with.
 *
 * The guard module is loaded lazily. If it is not present in the installed
 * build, the hook stays silent rather than refusing every tool call: an absent
 * module is a packaging fact, not evidence about the call being made. The
 * guard's own fail-closed behavior on a malformed payload lives inside the
 * guard, where the evidence is.
 */

type GuardEvaluator = (input: GuardInput) => GuardVerdict;

async function loadGuard(): Promise<GuardEvaluator | undefined> {
  try {
    const module = await import("../staging/guard.js");
    return typeof module.evaluateGuard === "function" ? module.evaluateGuard : undefined;
  } catch {
    return undefined;
  }
}

export function guardBlockMessage(verdict: GuardVerdict): string {
  const reason = verdict.reason ?? "This action is not allowed on this vault.";
  const rule = verdict.rule === undefined ? "" : ` (rule: ${verdict.rule})`;
  return `[open-brain guard] ${reason}${rule}`;
}

export async function preToolUseHook(
  context: HookContext,
): Promise<HookOutcome | undefined> {
  const tool = payloadString(context.payload, "tool_name");
  if (tool === undefined) {
    return undefined;
  }
  const evaluate = await loadGuard();
  if (evaluate === undefined) {
    return undefined;
  }

  const verdict = evaluate({
    tool,
    toolInput: payloadRecord(context.payload, "tool_input") ?? {},
    vaultRoot: context.vaultRoot,
    config: context.config,
  });
  return verdict.decision === "deny"
    ? { block: guardBlockMessage(verdict) }
    : undefined;
}
