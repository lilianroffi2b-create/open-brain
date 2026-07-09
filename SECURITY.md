# Security policy

## Supported releases

Security fixes are assessed for the current supported release line. Pre-release builds may change quickly and should not be treated as production-hardened software.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

When private vulnerability reporting is enabled for the repository, use that channel and include:

- a concise description of the issue;
- the affected version or commit;
- safe reproduction steps; and
- the potential impact.

Do not include credentials, access tokens, private vault contents, personal data, or client data. If private reporting is not yet available, use the maintainer's private contact channel rather than a public issue.

## Response process

Reports are triaged for reproducibility, impact, and affected versions. A fix, mitigation, or status update will be provided when practical. Please allow time for a coordinated fix before public disclosure.

## Security boundaries

OpenBrain is a local tool. It cannot protect secrets that are placed in a repository, pasted into an AI provider, or committed to a public issue. Treat any token ever committed to version control as compromised and rotate it outside the repository.
