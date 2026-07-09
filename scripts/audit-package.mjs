import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const npmCommand = "npm";
const packagePath = join(projectRoot, "package.json");
const requiredFilesField = [
  "bin/",
  "templates/",
  "integrations/",
  "schemas/",
  "MIGRATIONS/",
  "README.md",
  "LICENSE",
  "BRAND.md",
  "PRIVACY.md",
  "SECURITY.md",
  "CHANGELOG.md",
  "RELEASE_CHECKLIST.md",
];
const exactAllowed = new Set([
  "package.json",
  "README.md",
  "LICENSE",
  "BRAND.md",
  "PRIVACY.md",
  "SECURITY.md",
  "CHANGELOG.md",
  "RELEASE_CHECKLIST.md",
]);
const allowedPrefixes = ["bin/", "templates/", "integrations/", "schemas/", "MIGRATIONS/"];

function run(command, args, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      shell: process.platform === "win32",
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    let stdout = "";
    if (capture) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`${command} failed (${signal ?? code ?? "unknown"}).`));
      }
    });
  });
}

function isAllowed(path) {
  return exactAllowed.has(path) || allowedPrefixes.some((prefix) => path.startsWith(prefix));
}

const manifest = JSON.parse(await readFile(packagePath, "utf8"));
if (
  !Array.isArray(manifest.files)
  || manifest.files.length !== requiredFilesField.length
  || requiredFilesField.some((entry) => !manifest.files.includes(entry))
) {
  throw new Error("package.json files must exactly match the public package allowlist.");
}

await run(npmCommand, ["run", "build"]);
const rawPack = await run(npmCommand, ["pack", "--dry-run", "--json"], true);
let packed;
try {
  packed = JSON.parse(rawPack);
} catch {
  throw new Error("npm pack --dry-run --json did not produce valid JSON.");
}

if (!Array.isArray(packed) || packed.length !== 1 || !Array.isArray(packed[0]?.files)) {
  throw new Error("npm pack --dry-run --json returned an unexpected package manifest.");
}

const packedPaths = packed[0].files
  .map((file) => file?.path)
  .filter((path) => typeof path === "string")
  .sort();
const unexpected = packedPaths.filter((path) => !isAllowed(path));
const requiredPackedFiles = ["bin/cli.js", "package.json", "README.md", "LICENSE"];
const missing = requiredPackedFiles.filter((path) => !packedPaths.includes(path));

if (unexpected.length > 0 || missing.length > 0) {
  const details = [
    unexpected.length > 0 ? `unexpected: ${unexpected.join(", ")}` : "",
    missing.length > 0 ? `missing: ${missing.join(", ")}` : "",
  ].filter(Boolean);
  throw new Error(`Package allowlist validation failed (${details.join("; ")}).`);
}

console.log(`Package allowlist passed (${packedPaths.length} files).`);
