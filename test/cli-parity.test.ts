import assert from "node:assert/strict";
import { runCommand } from "citty";
import test from "node:test";

import { parityCommand } from "../src/cli/commands/parity.js";
import { PARITY_REFERENCE } from "../src/core/parity.js";

async function capture(action: () => Promise<unknown>): Promise<string> {
  const original = process.stdout.write.bind(process.stdout);
  let captured = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    await action();
  } finally {
    process.stdout.write = original;
  }
  return captured;
}

test("parity prints the rendered reference by default", async () => {
  const output = await capture(() => runCommand(parityCommand, { rawArgs: [] }));
  assert.match(output, /Parity reference \(frozen\)/u);
  assert.ok(output.includes(PARITY_REFERENCE.snapshot));
  assert.ok(
    !/\b[0-9a-f]{7,40}\b/u.test(output),
    "the parity reference must not publish a revision identifier of the private engine",
  );
  for (const module of PARITY_REFERENCE.modules) {
    assert.ok(output.includes(module.name), `should list module ${module.name}`);
  }
});

test("parity --json prints the exact frozen reference", async () => {
  const output = await capture(() => runCommand(parityCommand, { rawArgs: ["--json"] }));
  assert.deepEqual(JSON.parse(output.trim()) as unknown, PARITY_REFERENCE);
});
