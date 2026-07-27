// Runs one hook in a real child process so a test can observe the exit code,
// stdout, and stderr the host CLI would actually see. In-process assertions
// cannot prove the contract, because the contract is about process behavior.
//
// Usage: node --import tsx test/fixtures/hook-runner.ts <event> [handler]
// Handlers: real (default), silent, context, block, throw, hang, huge

import { handlerFor } from "../../src/cli/commands/hook.js";
import { isHookEvent } from "../../src/hooks/events.js";
import { runHook, type HookHandler } from "../../src/hooks/runtime.js";

const event = process.argv[2] ?? "";
const mode = process.argv[3] ?? "real";

if (!isHookEvent(event)) {
  process.stderr.write(`unknown event: ${event}\n`);
  process.exit(9);
}

const HANDLERS: Record<string, HookHandler> = {
  silent: async () => undefined,
  context: async () => ({ context: "INJECTED CONTEXT" }),
  block: async () => ({ block: "BLOCKED FOR A REASON" }),
  throw: async () => {
    throw new Error("handler exploded");
  },
  hang: async () => new Promise(() => undefined),
  huge: async () => ({ context: "x".repeat(50) }),
};

const handler = mode === "real" ? handlerFor(event) : HANDLERS[mode];
if (handler === undefined) {
  process.stderr.write(`unknown handler: ${mode}\n`);
  process.exit(9);
}

await runHook(event, handler);
