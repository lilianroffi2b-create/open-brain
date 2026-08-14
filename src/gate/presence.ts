import { randomBytes } from "node:crypto";

import { ExpectedError } from "../core/errors.js";

/**
 * Proof that a human is at the other end of a kernel write.
 *
 * Open Brain sells one sentence: nothing reaches the preference kernel without
 * a human deciding it. That sentence was false as long as the decision was a
 * command line flag, because a flag is something the caller writes about
 * itself, and a caller that can write the request can write the approval too.
 *
 * A terminal on standard input is not proof a human is there. It is an
 * ergonomic signal, not a security guarantee: a process that allocates its own
 * pseudo-terminal (`posix_openpt` and equivalents, available to any script
 * without a real user in the loop) reports `isTTY === true` with nobody
 * watching. This check catches an ordinary pipeline built by mistake or by
 * habit; it does not catch a process built specifically to defeat it, and
 * cannot without a second channel this module does not have. A person can
 * also hand their terminal to an agent, which is the weaker and more common
 * case this was written for. Say what this buys plainly: it raises the bar
 * for an accidental or careless automated write. It does not raise it against
 * a deliberate one.
 *
 * Both doors into the kernel use this module, `sync validate` and `prefs add`
 * or `prefs log`, because a guarantee that holds on one door and not on the
 * other is defined by the weaker door.
 *
 * The escape hatch is deliberate. A security check that makes the product
 * unusable for people who drive their vault from an agent is a check that gets
 * turned off globally on the first day, and then both the security and the
 * ergonomics are gone. So the hatch exists, it is explicit, it names exactly
 * the one guarantee it removes, and every call that uses it says so on stderr.
 */

/** The name of the escape hatch, kept in one place so every help text agrees. */
export const UNATTENDED_FLAG = "unattended";

/** The help line of the escape hatch. It says what it turns off, in full. */
export const UNATTENDED_DESCRIPTION =
  "Write without a terminal on standard input. This turns off exactly one guarantee, "
  + "the one that says a human, and not the agent composing this command, approved this "
  + "write to the preference kernel. Everything else still applies: the batch, the frozen "
  + "decision, the undo record, the redline journal. Use it when you drive your vault from "
  + "an agent and accept that trade.";

/** Printed on stderr by every call that used the hatch. Never silent. */
export const UNATTENDED_WARNING =
  "--unattended: this write to the preference kernel carries no proof that a human was "
  + "present. That is the only guarantee the flag removes; everything recorded about the "
  + "write is unchanged.";

export interface HumanPresence {
  /** Standard input is a terminal. The one fact a pipeline cannot fake. */
  interactive: boolean;
  /** The caller explicitly waived the check with the documented flag. */
  unattended: boolean;
}

/** A refusal a human is meant to read and act on, printed as a single line. */
export class HumanPresenceError extends ExpectedError {
  public constructor(message: string) {
    super(message);
    this.name = "HumanPresenceError";
  }
}

/** Reads the presence of a human from the process, once, at the CLI edge. */
export function humanPresenceFromStdin(unattended: boolean): HumanPresence {
  return { interactive: process.stdin.isTTY === true, unattended };
}

/**
 * Refuses a kernel write that nothing proves a human asked for. The message
 * names the command, the missing proof, and the exact cost of the hatch,
 * because this is the first wall an agent-driven user hits and a wall with no
 * door written on it is a wall people go around.
 */
export function assertHumanPresence(presence: HumanPresence, command: string): void {
  if (presence.interactive || presence.unattended) {
    return;
  }
  throw new HumanPresenceError(
    `${command} writes to the preference kernel, and standard input is not a terminal, `
    + "so nothing here proves a human is present. Run it yourself in a terminal, or pass "
    + "--unattended to write anyway. --unattended turns off exactly one guarantee: that a "
    + "human, and not the agent composing this command, approved this write.",
  );
}

/**
 * A short token, drawn at random, printed by `sync show` and retyped into
 * `sync validate`. Random rather than derived: a token computed from the batch
 * is a token the caller can compute too, which would prove nothing about
 * anybody having read the batch.
 */
export function newConfirmationToken(): string {
  return randomBytes(4).toString("hex");
}
