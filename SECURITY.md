# Security policy

## Supported releases

Security fixes are assessed for the current supported release line. Pre-release builds may change quickly and should not be treated as production-hardened software.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use GitHub's private vulnerability reporting for this repository at https://github.com/lilianroffi2b-create/open-brain/security/advisories/new and include:

- a concise description of the issue;
- the affected version or commit;
- safe reproduction steps; and
- the potential impact.

Do not include credentials, access tokens, private vault contents, personal data, or client data. If private reporting is not yet available, use the maintainer's private contact channel rather than a public issue.

## Response process

Reports are triaged for reproducibility, impact, and affected versions. A fix, mitigation, or status update will be provided when practical. Please allow time for a coordinated fix before public disclosure.

## Security boundaries

OpenBrain is a local tool. It cannot protect secrets that are placed in a repository, pasted into an AI provider, or committed to a public issue. Treat any token ever committed to version control as compromised and rotate it outside the repository.

## The vault key

Everything OpenBrain writes to prove something happened is a file inside the vault: the frozen decision of a review, the apply state, the undo record, the provenance journal of the preference kernel. Those records are sealed with an HMAC whose key lives **outside** the vault, at `~/.config/open-brain/vault-<id>.key`, where `<id>` is derived from the real path of the vault. The file is created on first use with mode `0600` inside a `0700` directory. On Windows the permission bits are advisory and the protection is the per-user profile directory the key sits in.

What this buys: writing files in the vault, which is what a misbehaving agent, a bad merge, or a hostile note can do, is no longer enough to forge a decision, an undo record, or a line of the provenance journal. What it does not buy: nothing here defends against a process running as you with read access to your home directory.

Consequences worth knowing before you move things around:

- **Moving a vault** changes its identifier, so the seals written at the old path no longer verify. Copy `vault-<id>.key` to the identifier of the new path, or accept that existing batches read as unverifiable and start new ones.
- **Losing the key** does not lose the vault. The kernel, the notes and the journal are all still there and readable; what is lost is the ability to vouch for them, so checks report `unverifiable` rather than `match`.
- **Never commit the key**, and never copy it into the vault. It is the one file that must not travel with the repository.
- Records written before the keyed seals existed (0.1.0-alpha.2 and earlier) do not verify. A batch prepared under the old format must be prepared again; a kernel whose journal predates the change reads as `unverifiable` until its next recorded write.

## Known limitations

Two checks in this project catch carelessness, not a deliberate attacker who has read this file. Both are named here instead of implied to be stronger than they are.

- **The human-presence check is an ergonomic signal, not a guarantee.** `sync validate`, `sync undo`, `prefs add`, and `prefs log` require a terminal on standard input by default. A process that opens its own pseudo-terminal reports one anyway, with nobody watching, and nothing here can close that without a second channel this project does not have. What it does catch: an ordinary script or pipeline that writes to the kernel without anyone in front of it, built without going out of its way to fake presence. See `src/gate/presence.ts` for the detail.
- **The pre-effect guard recognizes known ways of writing a file, not every way.** It is a deny list of command shapes, interpreter calls, and write primitives, widened each time a gap is found and demonstrated. It is not, and cannot be by construction, a proof that no unrecognized tool, interpreter, or indirection writes past it. The second, independent layer, the provenance journal and redline state under `.open-brain/local/`, is what catches a write the guard missed: not before it happens, but named and undeniable after. Treat the guard as raising the cost of an accidental or unsophisticated write, and the journal as the backstop that makes any write, however it got there, impossible to hide.

If you find a way past either check, it is a vulnerability report (see above), not a known limitation: the distinction is whether it is named on this page already.
