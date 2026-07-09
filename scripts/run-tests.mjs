import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const testRoot = join(projectRoot, "test");

async function collectTests(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTests(path));
    } else if (
      entry.isFile()
      && entry.name.endsWith(".test.ts")
      && !entry.name.endsWith(".golden.test.ts")
      && !relative(testRoot, path).split(/[\\/]/u).includes("golden")
    ) {
      files.push(path);
    }
  }
  return files;
}

function runNodeTests(files) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--test", ...files],
      { cwd: projectRoot, stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Test runner failed (${signal ?? code ?? "unknown"}).`));
      }
    });
  });
}

const tests = (await collectTests(testRoot)).sort();
if (tests.length === 0) {
  console.error("No non-golden TypeScript tests were found.");
  process.exitCode = 1;
} else {
  await runNodeTests(tests);
}
