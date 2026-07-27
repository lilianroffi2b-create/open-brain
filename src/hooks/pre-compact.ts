import { payloadString } from "./events.js";
import type { HookContext, HookOutcome } from "./runtime.js";

/**
 * The shell and the dispatch for the pre-compaction event. Compaction is the
 * one moment where a session is about to lose material it will never see again,
 * which is why the wiring exists now even though nothing extracts anything yet.
 *
 * Extension point. The extraction logic is owned by the staging layer and is
 * delivered separately. It registers itself here:
 *
 *   import { registerPreCompactExtractor } from "../hooks/pre-compact.js";
 *   registerPreCompactExtractor(async (context) => {
 *     // context.payload.trigger is "auto" or "manual"
 *     return { context: "...", budget };
 *   });
 *
 * Contract for an extractor:
 *   - it returns a HookOutcome or undefined, exactly like any other handler,
 *     and never writes to stdout itself: the runtime owns every output shape
 *   - a returned `context` is rendered as the additionalContext envelope; the
 *     host support for injecting context at compaction time is not established,
 *     so treat it as best effort rather than as a guarantee
 *   - it is called inside a try/catch here, so throwing degrades to silence
 *     rather than to a broken compaction
 *   - it respects context.deadline; the runtime kills it at the budget and the
 *     session keeps whatever was already written, which is nothing
 *   - it must be idempotent: an automatic compaction can fire twice on the same
 *     material and the second pass must not duplicate the first
 *
 * With no extractor registered the hook is silent, which is the correct
 * behavior for a vault whose staging layer is disarmed or absent.
 */

export type PreCompactExtractor = (
  context: HookContext,
) => Promise<HookOutcome | undefined>;

let extractor: PreCompactExtractor | undefined;

export function registerPreCompactExtractor(
  next: PreCompactExtractor | undefined,
): void {
  extractor = next;
}

export function getPreCompactExtractor(): PreCompactExtractor | undefined {
  return extractor;
}

/** "auto" or "manual", when the host says which one it is. */
export function compactionTrigger(context: HookContext): string | undefined {
  return payloadString(context.payload, "trigger");
}

export async function preCompactHook(
  context: HookContext,
): Promise<HookOutcome | undefined> {
  if (extractor === undefined) {
    return undefined;
  }
  try {
    return await extractor(context);
  } catch {
    return undefined;
  }
}
