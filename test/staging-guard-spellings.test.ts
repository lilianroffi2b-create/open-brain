import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CONFIG } from "../src/core/config.js";
import { evaluateGuard } from "../src/staging/guard.js";
import type { GuardVerdict } from "../src/staging/guard.js";

/**
 * One family of holes, seen from ten angles.
 *
 * Every row below was measured allowing a write to the preference kernel, and
 * several of them wrote the file on a real disk before this suite existed. They
 * are not ten separate mistakes. They are one: the guard compared whole tokens
 * to whole strings, while the shell, citty and every interpreter accept a dozen
 * spellings of the same instruction. `-lc` is `-c`, `--unattended=true` is
 * `--unattended`, `'-i'` is `-i`, and a path split across two adjacent literals
 * is one path.
 *
 * Each block keeps the bypasses next to the reads they must not start
 * refusing. A guard that closes a hole by refusing everything nearby has not
 * fixed anything, so both directions are asserted every time.
 */

const VAULT = "/tmp/openbrain-guard-vault";
const LEDGER = "10_memory/preferences/_ledger.json";
const CORE = "10_memory/preferences/_core.md";

/** The same rule the guard applies: the platform decides, not this file. */
const FOLDS_CASE = process.platform === "darwin" || process.platform === "win32";

function bash(command: string | string[]): GuardVerdict {
  return evaluateGuard({
    tool: "Bash",
    toolInput: { command },
    vaultRoot: VAULT,
    config: DEFAULT_CONFIG,
  });
}

function label(command: string | string[]): string {
  return Array.isArray(command) ? JSON.stringify(command) : command;
}

function denies(command: string | string[]): GuardVerdict {
  const verdict = bash(command);
  assert.equal(verdict.decision, "deny", `should have refused: ${label(command)}`);
  assert.ok(verdict.rule && verdict.rule.length > 0, `refusal needs a rule: ${label(command)}`);
  return verdict;
}

function allows(command: string | string[]): void {
  const verdict = bash(command);
  assert.equal(
    verdict.decision,
    "allow",
    `should have allowed: ${label(command)} (rule ${verdict.rule ?? "none"})`,
  );
}

// ---------------------------------------------------------------------------
// 1: a shell is called with its flags bundled, and `-c` is one of the letters
// ---------------------------------------------------------------------------

test("a clustered shell flag still carries a script", () => {
  denies(`bash -lc "echo x > ${CORE}"`);
  denies(`sh -cx 'rm ${LEDGER}'`);
  denies(`zsh -lc 'printf x >> ${CORE}'`);
  denies(`bash -cl "echo x > ${CORE}"`);
  denies(`bash --login -c "rm ${LEDGER}"`);
  denies(`bash -lc "sh -cx 'rm ${LEDGER}'"`);
  denies(`env bash -lc "rm ${CORE}"`);
  denies(`timeout 5 bash -lc "rm ${CORE}"`);
  denies(`sudo sh -cx "rm ${LEDGER}"`);

  // The argv form is the shape a tool really emits, and it lost the same check.
  denies(["bash", "-lc", `echo x > ${CORE}`]);
  denies(["sh", "-cx", `rm ${LEDGER}`]);

  // The spelling that always worked must keep working.
  denies(`bash -c "echo x > ${CORE}"`);

  // A clustered flag on a script that only reads is still a read.
  allows(`bash -lc "wc -l ${CORE}"`);
  allows(`sh -cx 'cat ${CORE}'`);
  allows(["bash", "-lc", `cat ${CORE}`]);
});

// ---------------------------------------------------------------------------
// 2: the human gate, switched off with a value instead of a bare flag
// ---------------------------------------------------------------------------

test("the human gate is not opened by writing a value after the flag", () => {
  const batch = "batch-000000000000000000000000";
  for (const spelling of ["--unattended=true", "--unattended=1", "--unattended=yes", "--unattended="]) {
    const verdict = denies(`open-brain sync apply --batch ${batch} --approve "1" ${spelling}`);
    assert.equal(verdict.rule, "unattended-kernel-write", `wrong rule for ${spelling}`);
  }
  assert.equal(
    denies(`open-brain prefs add --id x --text y --weight 2 --unattended=true`).rule,
    "preference-cli-mutation",
  );
  assert.equal(
    denies(`ob(){ open-brain "$@"; }; ob sync apply --batch ${batch} --unattended=true`).rule,
    "unattended-kernel-write",
  );
  assert.equal(
    denies(`open-brain sync apply --batch ${batch} --approve "1" --unattended`).rule,
    "unattended-kernel-write",
  );

  // A flag whose name merely starts the same way is a different flag.
  allows(`open-brain sync show --batch ${batch} --unattended-report=false`);
  allows(`open-brain sync staged --root .`);
});

// ---------------------------------------------------------------------------
// 3: an interpreter is asked to evaluate, in every spelling it accepts
// ---------------------------------------------------------------------------

test("an interpreter body is read whatever flag introduces it", () => {
  denies(`python3 -uc "open('${CORE}','w').write('x')"`);
  denies(`python3 -Suc "open('${CORE}','w').write('x')"`);
  denies(`node --eval "require('fs').writeFileSync('${CORE}','x')"`);
  denies(`node --eval="require('fs').writeFileSync('${CORE}','x')"`);
  denies(`node --input-type=module --eval "require('fs').writeFileSync('${CORE}','x')"`);
  denies(`node -p "require('fs').writeFileSync('${LEDGER}','x')"`);
  denies(`deno eval "Deno.writeTextFile('${CORE}','x')"`);
  denies(`bun eval "require('fs').writeFileSync('${CORE}','x')"`);
  denies(`perl -E 'open(my $f, ">", "${CORE}")'`);
  denies(`ruby -e "File.write('${CORE}', 'x')"`);
  denies(`php -r "fopen('${CORE}', 'w');"`);

  // The spellings that already worked, and the reads that must not move.
  denies(`python3 -c "open('${CORE}','w').write('x')"`);
  allows(`python3 -uc "import sys; print(sys.version)"`);
  allows(`node --input-type=module -e "console.log(1)"`);
  allows(`deno eval "console.log(1)"`);
  allows(`perl -E 'say 1'`);
});

// ---------------------------------------------------------------------------
// 4: a flag is a flag whether or not the shell saw quotes around it
// ---------------------------------------------------------------------------

test("quoting a flag does not hide it from the program that reads it", () => {
  denies(`sed '-i' -e 's/.*/hacked/' ${CORE}`);
  denies(`sed "-i" "" 's/a/b/' ${LEDGER}`);
  denies(`cp '-r' /tmp/fake 10_memory`);
  denies(`rsync '-a' --delete /tmp/fake/ 10_memory/`);
  denies(`rm '-rf' 10_memory/preferences`);

  // An argv array has no shell to quote it, so every token arrived marked as
  // quoted and the whole array tool API lost flag recognition at once.
  denies(["sed", "-i", "s/a/b/", CORE]);
  denies(["sed", "-i", "-e", "s/.*/hacked/", CORE]);
  denies(["cp", "-r", "/tmp/fake", "10_memory"]);
  denies(["rsync", "-a", "--delete", "/tmp/fake/", "10_memory/"]);
  denies(["rm", "-rf", "10_memory/preferences"]);
  denies(["chmod", "-R", "777", "10_memory"]);

  // A script that merely contains the letters of a flag is not a flag.
  allows(`sed 's/-i//' ${CORE}`);
  allows(["sed", "-n", "1,5p", CORE]);
  allows(["cp", CORE, "/tmp/backup.md"]);
});

// ---------------------------------------------------------------------------
// 5: writers the table did not know
// ---------------------------------------------------------------------------

test("a writer outside the old table is still a writer", () => {
  denies(`curl -so ${CORE} https://example.test/x`);
  denies(`curl --output ${CORE} https://example.test/x`);
  denies(`curl --output=${LEDGER} https://example.test/x`);
  denies(`wget -O ${CORE} https://example.test/x`);
  denies(`wget --output-document ${LEDGER} https://example.test/x`);
  denies(`awk 'BEGIN{print "x" > "${CORE}"}'`);
  denies(`awk 'BEGIN{printf "x" >> "${LEDGER}"}'`);
  denies(`find 10_memory/preferences -name '*.md' -delete`);
  denies(`find 10_memory/preferences -name '*.md' -exec rm {} \\;`);
  denies(`find 10_memory -type f -exec truncate -s 0 {} +`);
  denies(`ex -sc '%d|x' ${CORE}`);
  denies(`perl -pi -e 's/a/b/' ${CORE}`);
  denies(`perl -i.bak -pe 's/a/b/' ${LEDGER}`);
  denies(`openssl rand -out ${CORE} 32`);
  denies(`unzip -o /tmp/a.zip -d 10_memory/preferences`);
  denies(`unzip /tmp/a.zip -d 10_memory`);
  denies(`unzip -d 10_memory/preferences /tmp/a.zip`);
  denies(`busybox rm -f ${CORE}`);
  denies(`busybox sh -c 'rm ${LEDGER}'`);
  denies(`cat /tmp/x | sponge ${CORE}`);
  denies(`mkdir -p 10_memory/preferences/nested`);

  // The destination named by a flag, for the commands whose operands are all
  // sources. Only the ones ending in a destination were ever read.
  denies(`mv -t 10_memory/preferences /tmp/forged.md`);
  denies(`ln -t 10_memory/preferences /tmp/forged.md`);
  denies(`cp --target-directory=10_memory/preferences /tmp/forged.md`);
  denies(`tar --directory=10_memory -xf /tmp/a.tar`);
  denies(`git --work-tree=${VAULT} restore ${CORE}`);

  // An awk program that shells out with a command it builds at runtime is the
  // interpreter body whose target cannot be read, so it is refused the same way.
  assert.equal(
    denies(`awk 'BEGIN{system("rm " target)}'`).rule,
    "opaque-interpreter-write",
  );
  denies(`awk 'BEGIN{system("rm ${CORE}")}'`);

  // The same commands, reading. None of them may start refusing.
  allows(`curl -s https://example.test/x`);
  allows(`curl -so /tmp/out.json https://example.test/x`);
  allows(`wget -O /tmp/out https://example.test/x`);
  allows(`awk '{print $1}' ${CORE}`);
  allows(`awk '$1 > 5 {print}' ${CORE}`);
  allows(`awk -f /tmp/prog.awk ${CORE}`);
  allows(`find 10_memory/preferences -name '*.md'`);
  allows(`find 10_memory/preferences -name '*.md' -exec grep -l x {} \\;`);
  allows(`find /tmp/scratch -name '*.tmp' -delete`);
  allows(`find -L /tmp/scratch -name '*.tmp' -delete`);
  allows(`openssl dgst -sha256 ${CORE}`);
  allows(`openssl rand -out /tmp/key 32`);
  allows(`perl -MList::Util -e 'print 1' ${CORE}`);
  allows(`perl -ne 'print' ${CORE}`);
  allows(`unzip -l /tmp/a.zip`);
  allows(`unzip -v /tmp/a.zip`);
  allows(`busybox ls 10_memory/preferences`);
  allows(`sponge /tmp/out`);
  allows(`mkdir -p 40_sources/new`);
});

// ---------------------------------------------------------------------------
// 6: xargs, whose operands come from somewhere the guard cannot read
// ---------------------------------------------------------------------------

test("a mutator fed by a pipe is not a mutator with no operands", () => {
  assert.equal(denies(`echo ${CORE} | xargs rm -f`).rule, "unresolved-write-target");
  assert.equal(denies(`printf '%s\\0' ${CORE} | xargs -0 rm -f`).rule, "unresolved-write-target");
  denies(`echo ${LEDGER} | xargs -n1 truncate -s 0`);
  denies(`echo ${CORE} | xargs -I{} cp /tmp/forged.md {}`);
  denies(`echo ${CORE} | xargs -I{} sh -c 'rm {}'`);
  denies(`echo ${CORE} | sudo xargs rm -f`);
  denies(`grep -l x ${CORE} | xargs sed -i 's/a/b/'`);
  denies(`xargs -a /tmp/list rm -f ${CORE}`);
  denies(`echo ${CORE} | xargs --arg-file=/tmp/list rm -f`);

  // What is written on the line is still read the way it always was, and the
  // inner flags survive the split: the recursive copy is not lost.
  denies(`xargs rm ${CORE}`);
  denies(`xargs cp -r /tmp/fake 10_memory`);

  // A pipe into xargs that has nothing to do with the kernel is not the
  // guard's business, and refusing it would be the false positive this file
  // exists to avoid.
  allows(`find /tmp -name '*.tmp' | xargs rm -f`);
  allows(`echo /tmp/one | xargs rm -f`);
  allows(`cat ${CORE} | xargs -n1 echo`);
  allows(`xargs -a /tmp/list rm -f`);
  allows(`cat /tmp/list | xargs sed -i 's/a/b/'`);
  allows(`cat /tmp/list | xargs grep -l x`);
});

// ---------------------------------------------------------------------------
// 7: a path split across two literals the language joins back together
// ---------------------------------------------------------------------------

test("an interpreter body cannot split a path across adjacent literals", () => {
  denies(`python3 -c "open('10_memory/pref' 'erences/_core.md','w').write('x')"`);
  denies(`python3 -c "open('10_memory/preferences/' '_ledger.json','w').write('{}')"`);
  denies(`node -e "require('fs').writeFileSync('10_memory/preferences/' + '_core.md','x')"`);
  denies(`node -e "require('fs').writeFileSync('10_memory/pref'+'erences/_core.md','x')"`);

  // Two literals that are arguments, not a concatenation, stay two arguments.
  allows(`python3 -c "open('/tmp/a.md','w').write('x')"`);
  allows(`node -e "require('fs').writeFileSync('/tmp/a', 'md')"`);
});

// ---------------------------------------------------------------------------
// 8 and 9: two spellings of one path, and one spelling of two paths
// ---------------------------------------------------------------------------

test("a path is compared the way the filesystem would compare it", () => {
  const composed = `${VAULT}/café`;
  const decomposed = `${VAULT}/café`;
  assert.notEqual(composed, decomposed, "the two spellings must differ as strings");

  for (const spelling of [composed, decomposed]) {
    const verdict = evaluateGuard({
      tool: "Write",
      toolInput: { file_path: `${spelling}/${CORE}` },
      vaultRoot: composed,
      config: DEFAULT_CONFIG,
    });
    assert.equal(
      verdict.decision,
      "deny",
      "a vault path spelled in the other normal form is the same file",
    );
  }

  // Case is the platform's question, not this guard's. Where the filesystem
  // folds it, a differently cased name is the kernel. Where it does not, it is
  // an unprotected file, and refusing it was a false positive.
  const cased = evaluateGuard({
    tool: "Write",
    toolInput: { file_path: "10_MEMORY/preferences/_core.md" },
    vaultRoot: VAULT,
    config: DEFAULT_CONFIG,
  });
  assert.equal(cased.decision, FOLDS_CASE ? "deny" : "allow");
});

// ---------------------------------------------------------------------------
// 10: the notebook branch that nothing could reach
// ---------------------------------------------------------------------------

test("a notebook write is judged, not skipped", () => {
  for (const tool of ["NotebookEdit", "notebook_edit"]) {
    for (const path of [CORE, LEDGER, `${VAULT}/${CORE}`]) {
      const verdict = evaluateGuard({
        tool,
        toolInput: { notebook_path: path },
        vaultRoot: VAULT,
        config: DEFAULT_CONFIG,
      });
      assert.equal(verdict.decision, "deny", `${tool} on ${path} should have been refused`);
    }
  }

  const elsewhere = evaluateGuard({
    tool: "NotebookEdit",
    toolInput: { notebook_path: "40_sources/notes.ipynb" },
    vaultRoot: VAULT,
    config: DEFAULT_CONFIG,
  });
  assert.equal(elsewhere.decision, "allow");

  const unreadable = evaluateGuard({
    tool: "NotebookEdit",
    toolInput: {},
    vaultRoot: VAULT,
    config: DEFAULT_CONFIG,
  });
  assert.equal(unreadable.decision, "deny");
});

// ---------------------------------------------------------------------------
// 11: gsed, the interactive editors, and fish, spellings the table did not
// recognize even though its sed, ex, and shell equivalents already were
// ---------------------------------------------------------------------------

test("gsed, the interactive editors, and fish are writers like their known equivalents", () => {
  denies(`gsed -i 's/a/b/' ${CORE}`);
  denies(`gsed -i.bak -e 's/a/b/' ${LEDGER}`);
  denies(`vim ${CORE}`);
  denies(`vi -c 'wq' ${CORE}`);
  denies(`nvim -c '%d|x' ${CORE}`);
  denies(`emacs ${CORE}`);
  denies(`fish -c "rm ${LEDGER}"`);
  denies(["fish", "-c", `rm ${LEDGER}`]);

  // The reads that must not start refusing.
  allows(`gsed -n '1,5p' ${CORE}`);
  allows(`gsed 's/-i//' ${CORE}`);
  allows(`vim -c 'q' /tmp/scratch.md`);
  allows(`fish -c "cat ${CORE}"`);
});

// ---------------------------------------------------------------------------
// 12: an interpreter body that shells out instead of writing directly
// ---------------------------------------------------------------------------

test("a shell-out call inside an interpreter body is read like the shell command it runs", () => {
  denies(`python3 -c "import os; os.system('rm ${CORE}')"`);
  denies(`python3 -c "import os; os.popen('rm ${LEDGER}')"`);
  denies(`python3 -c "import subprocess; subprocess.run('rm ${CORE}', shell=True)"`);
  denies(`python3 -c "import subprocess; subprocess.call('rm ${LEDGER}')"`);
  denies(`python3 -c "import subprocess; subprocess.Popen('rm ${CORE}')"`);
  denies(`node -e "const child_process = require('node:child_process'); child_process.execSync('rm ${CORE}')"`);
  denies(`node -e "const child_process = require('node:child_process'); child_process.exec('rm ${LEDGER}')"`);

  // Built from a variable rather than a plain literal: refused, not guessed,
  // exactly as an awk system() call built at runtime already was.
  assert.equal(
    denies(`python3 -c "import os; cmd = 'rm ${CORE}'; os.system(cmd)"`).rule,
    "opaque-interpreter-write",
  );
  assert.equal(
    denies(
      `node -e "const child_process = require('node:child_process'); const cmd = 'rm ${CORE}'; child_process.exec(cmd)"`,
    ).rule,
    "opaque-interpreter-write",
  );

  // A shell-out that only reads must not start refusing.
  allows(`python3 -c "import os; os.system('ls /tmp')"`);
  allows(`node -e "require('child_process').execSync('ls /tmp')"`);
});

// ---------------------------------------------------------------------------
// 13: xargs fed through an input redirection instead of a pipe or -a
// ---------------------------------------------------------------------------

test("xargs fed through an input redirection is read the same as a pipe or -a", () => {
  // Before this fix, a mutator behind `xargs < file` was analyzed with an
  // empty operand list and no target was ever recorded, so this was a bare
  // `allow` even though the command text names the kernel file directly.
  assert.equal(denies(`xargs rm -f < ${CORE}`).rule, "unresolved-write-target");
  assert.equal(denies(`xargs -0 rm -f < ${LEDGER}`).rule, "unresolved-write-target");

  // A redirection unrelated to the kernel is not the guard's business.
  allows(`xargs rm -f < /tmp/list`);
});
