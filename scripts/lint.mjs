import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const ignoredDirectories = new Set([
  ".git",
  "bin",
  "coverage",
  "node_modules",
]);
const textExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
  ".txt",
  ".yml",
  ".yaml",
]);
const forbiddenEmDash = String.fromCodePoint(0x2014);

async function collectFiles(directory) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        files.push(...await collectFiles(join(directory, entry.name)));
      }
      continue;
    }

    if (entry.isFile() && textExtensions.has(extension(entry.name))) {
      files.push(join(directory, entry.name));
    }
  }

  return files;
}

function extension(filename) {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot);
}

const violations = [];
for (const path of await collectFiles(projectRoot)) {
  const contents = await readFile(path, "utf8");
  const displayPath = relative(projectRoot, path);
  const lines = contents.split(/\r?\n/u);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/[\t ]+$/u.test(line)) {
      violations.push(`${displayPath}:${index + 1}: trailing whitespace`);
    }
    if (line.includes(forbiddenEmDash)) {
      violations.push(`${displayPath}:${index + 1}: em dash is not allowed`);
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Lint passed.");
}
