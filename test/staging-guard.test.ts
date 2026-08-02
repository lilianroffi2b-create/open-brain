import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CONFIG } from "../src/core/config.js";
import { evaluateGuard, protectedRelativePaths } from "../src/staging/guard.js";
import type { GuardVerdict } from "../src/staging/guard.js";

/**
 * The non-regression suite of the rewritten guard.
 *
 * Every command that the Python guard refused for a real reason must stay
 * refused. Every command it refused only because a protected path appeared
 * somewhere in the text must now pass. The two lists are kept side by side on
 * purpose: a change that fixes one and breaks the other is not a fix.
 */

const VAULT = "/tmp/openbrain-guard-vault";
const LEDGER = "10_memory/preferences/_ledger.json";
const CORE = "10_memory/preferences/_core.md";

/** The same rule the guard applies: the platform decides, not this file. */
const FOLDS_CASE = process.platform === "darwin" || process.platform === "win32";

function bash(command: string, cwd?: string): GuardVerdict {
  return evaluateGuard({
    tool: "Bash",
    toolInput: cwd === undefined ? { command } : { command, cwd },
    vaultRoot: VAULT,
    config: DEFAULT_CONFIG,
  });
}

function denies(command: string): void {
  const verdict = bash(command);
  assert.equal(verdict.decision, "deny", `should have refused: ${command}`);
  assert.ok(verdict.reason && verdict.reason.length > 0, `refusal needs a reason: ${command}`);
  assert.ok(verdict.rule && verdict.rule.length > 0, `refusal needs a rule: ${command}`);
}

function allows(command: string): void {
  const verdict = bash(command);
  assert.equal(
    verdict.decision,
    "allow",
    `should have allowed: ${command} (rule ${verdict.rule ?? "none"})`,
  );
}

// ---------------------------------------------------------------------------
// The measured false positives, which must now pass
// ---------------------------------------------------------------------------

const READS_THAT_MUST_PASS: readonly string[] = [
  `git log --oneline -- ${CORE}`,
  `git log --oneline -- ${CORE} | head -20`,
  `git show HEAD:${LEDGER}`,
  `git show HEAD:${LEDGER} | jq .`,
  `git blame ${CORE} | tail`,
  `cat ${CORE} | sed -n '1,10p'`,
  `cat ${CORE}`,
  `cat ${CORE} | head -5`,
  `grep -n rule ${CORE}`,
  `git diff HEAD -- ${CORE}`,
  `git log -p -- ${LEDGER} > /tmp/out.txt`,
  `jq . ${LEDGER} | head`,
  `wc -l ${LEDGER}`,
  `sed -n '1,5p' ${CORE}`,
  `diff ${CORE} /tmp/other.md`,
  `cp ${CORE} /tmp/backup.md`,
  `git status --short`,
  `git cat-file -p HEAD:${LEDGER} | wc -l`,
  `rm -rf /tmp/unrelated`,
  `echo hello > /tmp/out.txt`,
  `open-brain prefs list`,
  `open-brain prefs validate --root .`,
  `tar -tf /tmp/archive.tar | grep preferences`,
];

test("a command that only reads a protected path is allowed", () => {
  for (const command of READS_THAT_MUST_PASS) {
    allows(command);
  }
});

// ---------------------------------------------------------------------------
// Direct mutations
// ---------------------------------------------------------------------------

const DIRECT_MUTATIONS: readonly string[] = [
  `echo x > ${CORE}`,
  `printf '%s' hi >> ${LEDGER}`,
  `cat /tmp/forged.md >| ${CORE}`,
  `exec 3<> ${LEDGER}`,
  `rm ${LEDGER}`,
  `rm -f ${CORE}`,
  `rm -rf 10_memory/preferences`,
  `rm -rf 10_memory`,
  `mv ${CORE} /tmp/stash.md`,
  `mv /tmp/forged.json ${LEDGER}`,
  `cp /tmp/forged.json ${LEDGER}`,
  `cp -R /tmp/fake 10_memory`,
  `cp /tmp/forged.md 10_memory/preferences/`,
  `cp -t 10_memory/preferences /tmp/forged.md`,
  `install -m 644 /tmp/forged.md ${CORE}`,
  `ln -sf /dev/null ${LEDGER}`,
  `ln ${LEDGER} /tmp/alias.json`,
  `ln -s ${CORE} /tmp/alias.md`,
  `tee ${CORE} < /tmp/forged.md`,
  `sed -i '' 's/a/b/' ${CORE}`,
  `sed -i.bak s/a/b/ ${LEDGER}`,
  `dd if=/dev/zero of=${LEDGER}`,
  `truncate -s 0 ${LEDGER}`,
  `touch ${CORE}`,
  `chmod 000 ${LEDGER}`,
  `chown root ${CORE}`,
  `chmod -R 777 10_memory`,
  `unlink ${LEDGER}`,
  `rsync -a /tmp/fake/ 10_memory/preferences/`,
  `rsync -a /tmp/fake/ 10_memory/`,
  `shred -u ${LEDGER}`,
  `tar -x -f /tmp/archive.tar -C 10_memory`,
];

test("a direct write to the preference kernel is refused", () => {
  for (const command of DIRECT_MUTATIONS) {
    denies(command);
  }
});

// ---------------------------------------------------------------------------
// Nested shells, cd, interpreters, git
// ---------------------------------------------------------------------------

const INDIRECT_MUTATIONS: readonly string[] = [
  `cd 10_memory/preferences && rm _ledger.json`,
  `cd 10_memory && cd preferences && echo x > _core.md`,
  `bash -c "echo x > ${CORE}"`,
  `sh -c 'rm ${LEDGER}'`,
  `zsh -c 'printf x >> ${CORE}'`,
  `bash -c "sh -c 'rm ${LEDGER}'"`,
  `eval "rm ${LEDGER}"`,
  `python3 -c "open('${LEDGER}', 'w').write('{}')"`,
  `python3 -c "from pathlib import Path; Path('${CORE}').write_text('x')"`,
  `python -c "import os; os.replace('/tmp/forged.json', '${LEDGER}')"`,
  `python3 -c "import shutil; shutil.move('/tmp/forged.md', '${CORE}')"`,
  `node -e "require('fs').writeFileSync('${LEDGER}', '{}')"`,
  `git restore ${LEDGER}`,
  `git restore --source HEAD~1 -- ${CORE}`,
  `git checkout HEAD -- ${LEDGER}`,
  `git checkout -- ${CORE}`,
  `git reset --hard`,
  `git reset --hard HEAD~1`,
  `git clean -fd`,
  `git rm -f ${LEDGER}`,
  `git mv ${CORE} /tmp/elsewhere.md`,
  `git stash pop`,
  `git apply /tmp/patch.diff`,
  `git -C ${VAULT} restore ${CORE}`,
];

test("an indirect write through a shell, an interpreter, or git is refused", () => {
  for (const command of INDIRECT_MUTATIONS) {
    denies(command);
  }
});

// ---------------------------------------------------------------------------
// Control constructs, heredocs, dynamic targets
// ---------------------------------------------------------------------------

const CONTROL_AND_DYNAMIC: readonly string[] = [
  `if true; then rm ${LEDGER}; fi`,
  `set -e\nrm ${CORE}`,
  `for f in a b; do rm ${LEDGER}; done`,
  `while true; do truncate -s 0 ${CORE}; done`,
  `P=${CORE}; printf x > "$P"`,
  `TARGET="10_memory/preferences"; rm -rf "$TARGET"`,
  `echo x > $(echo ${CORE})`,
  `$(echo rm) ${LEDGER}`,
  `\`echo rm\` ${CORE}`,
  `cat > ${CORE} <<'EOF'\nhello\nEOF\n`,
  `bash <<'SH'\nrm ${LEDGER}\nSH\n`,
  `python3 <<'PY'\nfrom pathlib import Path\nPath('${CORE}').write_text('x')\nPY\n`,
  `(cd 10_memory/preferences && rm _core.md)`,
  `test -f ${LEDGER} && rm ${LEDGER}`,
  `test -f ${LEDGER} || touch ${LEDGER}`,
  `rm /tmp/one; rm ${CORE}`,
];

test("a control construct or a dynamic target does not hide a write", () => {
  for (const command of CONTROL_AND_DYNAMIC) {
    denies(command);
  }
});

// ---------------------------------------------------------------------------
// Wrappers
// ---------------------------------------------------------------------------

const WRAPPED_MUTATIONS: readonly string[] = [
  `env rm ${LEDGER}`,
  `env FOO=bar rm ${CORE}`,
  `sudo rm ${CORE}`,
  `sudo -u root truncate -s 0 ${LEDGER}`,
  `nohup rm ${LEDGER}`,
  `time rm ${CORE}`,
  `nice -n 10 rm ${LEDGER}`,
  `command rm ${CORE}`,
  `builtin echo x > ${CORE}`,
  `/bin/rm ${LEDGER}`,
  `xargs rm ${CORE}`,
  `timeout 5 rm ${LEDGER}`,
];

test("a mutator behind a wrapper is still a mutator", () => {
  for (const command of WRAPPED_MUTATIONS) {
    denies(command);
  }
});

// ---------------------------------------------------------------------------
// The semantic bypass: the preference CLI itself
// ---------------------------------------------------------------------------

const PREFERENCE_CLI_MUTATIONS: readonly string[] = [
  "open-brain prefs add --id short-answers --text x --weight 2",
  "open-brain prefs log --id short-answers --signal validated_sync",
  "open-brain prefs regen",
  "open-brain --root . prefs add --id x --text y --weight 2",
  "npx open-brain prefs repair --apply",
  "node dist/open-brain.js prefs log --id x --signal y",
  "open-brain prefs propose --id x",
];

test("mutating the kernel through the preference CLI is refused", () => {
  for (const command of PREFERENCE_CLI_MUTATIONS) {
    const verdict = bash(command);
    assert.equal(verdict.decision, "deny", `should have refused: ${command}`);
    assert.equal(verdict.rule, "preference-cli-mutation");
  }
});

// ---------------------------------------------------------------------------
// File and patch tools
// ---------------------------------------------------------------------------

test("the file tools are judged on the path they would write", () => {
  for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) {
    for (const path of [
      CORE,
      LEDGER,
      `${VAULT}/${CORE}`,
      `40_sources/../${LEDGER}`,
      // A name differing only in case is the same file where the filesystem
      // folds case and a different one where it does not, so the row it
      // belongs to is the platform's, not this file's.
      ...(FOLDS_CASE ? ["10_MEMORY/PREFERENCES/_CORE.MD"] : []),
      "10_memory/preferences/subdir/../_ledger.json",
      "10_memory/preferences/anything-else.json",
    ]) {
      const verdict = evaluateGuard({
        tool,
        toolInput: { file_path: path },
        vaultRoot: VAULT,
        config: DEFAULT_CONFIG,
      });
      assert.equal(verdict.decision, "deny", `${tool} on ${path} should have been refused`);
    }
  }

  const elsewhere = evaluateGuard({
    tool: "Write",
    toolInput: { file_path: "40_sources/notes.md" },
    vaultRoot: VAULT,
    config: DEFAULT_CONFIG,
  });
  assert.equal(elsewhere.decision, "allow");
});

test("a patch is judged on the files it declares", () => {
  const denied = evaluateGuard({
    tool: "apply_patch",
    toolInput: { patch: `*** Begin Patch\n*** Update File: ${LEDGER}\n@@\n-a\n+b\n*** End Patch` },
    vaultRoot: VAULT,
    config: DEFAULT_CONFIG,
  });
  assert.equal(denied.decision, "deny");

  const unified = evaluateGuard({
    tool: "apply_patch",
    toolInput: { patch: `--- a/${CORE}\n+++ b/${CORE}\n@@\n-a\n+b\n` },
    vaultRoot: VAULT,
    config: DEFAULT_CONFIG,
  });
  assert.equal(unified.decision, "deny");

  const allowed = evaluateGuard({
    tool: "apply_patch",
    toolInput: { patch: "*** Begin Patch\n*** Update File: 40_sources/notes.md\n*** End Patch" },
    vaultRoot: VAULT,
    config: DEFAULT_CONFIG,
  });
  assert.equal(allowed.decision, "allow");
});

test("a tool that cannot write is never analyzed", () => {
  for (const tool of ["Read", "Grep", "Glob", "WebFetch", "Task"]) {
    const verdict = evaluateGuard({
      tool,
      toolInput: { file_path: LEDGER, command: `rm ${LEDGER}` },
      vaultRoot: VAULT,
      config: DEFAULT_CONFIG,
    });
    assert.equal(verdict.decision, "allow", `${tool} is not a mutating tool`);
  }
});

// ---------------------------------------------------------------------------
// Fail-closed
// ---------------------------------------------------------------------------

test("invariant 25: anything unreadable fails closed", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["no command at all", {}],
    ["a command that is not a string", { command: 42 }],
    ["a command array with a hole", { command: ["rm", 3] }],
    ["a null command", { command: null }],
    ["a null byte in the command", { command: `rm ${LEDGER}\u0000 --force` }],
    ["an unterminated quote", { command: 'echo "unterminated' }],
    ["an unterminated substitution", { command: "echo $(echo hi" }],
    ["an unterminated heredoc", { command: "cat <<EOF\nbody\n" }],
    [
      "a nesting depth beyond four",
      { command: "echo $(echo $(echo $(echo $(echo $(echo hi)))))" },
    ],
  ];

  for (const [label, toolInput] of cases) {
    const verdict = evaluateGuard({
      tool: "Bash",
      toolInput,
      vaultRoot: VAULT,
      config: DEFAULT_CONFIG,
    });
    assert.equal(verdict.decision, "deny", `${label} must fail closed`);
  }

  const noRoot = evaluateGuard({
    tool: "Bash",
    toolInput: { command: "echo hi" },
    vaultRoot: "",
    config: DEFAULT_CONFIG,
  });
  assert.equal(noRoot.decision, "deny");
  assert.equal(noRoot.rule, "vault-root-unresolved");

  const noTool = evaluateGuard({
    tool: "",
    toolInput: { command: "echo hi" },
    vaultRoot: VAULT,
    config: DEFAULT_CONFIG,
  });
  assert.equal(noTool.decision, "deny");

  const noPath = evaluateGuard({
    tool: "Write",
    toolInput: {},
    vaultRoot: VAULT,
    config: DEFAULT_CONFIG,
  });
  assert.equal(noPath.decision, "deny");
});

// ---------------------------------------------------------------------------
// Shape of the seam
// ---------------------------------------------------------------------------

test("the verdict is the shape the hook expects, and evaluation is pure", () => {
  const verdict = bash(`rm ${LEDGER}`);
  assert.deepEqual(Object.keys(verdict).sort(), ["decision", "reason", "rule"]);
  assert.equal(verdict.decision, "deny");
  assert.match(verdict.reason ?? "", /open-brain sync/u);

  const allowed = bash("echo hi");
  assert.deepEqual(allowed, { decision: "allow" });

  // Called twice with the same input, it answers the same thing: no state
  // survives between calls.
  assert.deepEqual(bash(`rm ${LEDGER}`), verdict);
  assert.deepEqual(protectedRelativePaths(DEFAULT_CONFIG), [
    "10_memory/preferences/_ledger.json",
    "10_memory/preferences/_core.md",
  ]);
});

test("a working directory outside the vault does not create a false refusal", () => {
  assert.equal(bash("rm _core.md", "/tmp/elsewhere").decision, "allow");
  assert.equal(bash("rm _core.md", `${VAULT}/10_memory/preferences`).decision, "deny");
});

test("the guard follows the configured memory path, it never hard codes it", () => {
  const renamed = {
    ...DEFAULT_CONFIG,
    paths: { ...DEFAULT_CONFIG.paths, memory: "memory" },
  };
  const denied = evaluateGuard({
    tool: "Bash",
    toolInput: { command: "rm memory/preferences/_ledger.json" },
    vaultRoot: VAULT,
    config: renamed,
  });
  assert.equal(denied.decision, "deny");

  const stale = evaluateGuard({
    tool: "Bash",
    toolInput: { command: `rm ${LEDGER}` },
    vaultRoot: VAULT,
    config: renamed,
  });
  assert.equal(stale.decision, "allow", "the old location is no longer the kernel");
});
