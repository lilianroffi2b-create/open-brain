/**
 * Error type for expected, user-facing failures such as a missing vault, an
 * invalid flag combination, or a guarded refusal. The CLI catches these at the
 * top level and prints a single clean line without a stack trace. Throwing
 * performs no I/O, so core modules may raise it while staying pure.
 */
export class ExpectedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ExpectedError";
  }
}
