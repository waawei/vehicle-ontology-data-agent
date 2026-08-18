import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const skippedDirectories = new Set([
  ".git",
  ".venv",
  ".pytest_cache",
  ".ruff_cache",
  ".mypy_cache",
  "node_modules",
  "dist",
  "coverage",
  "runtime",
  "test-results",
  "playwright-report",
  "__pycache__",
]);
const forbiddenFiles = [
  /^\.env(?!\.example$)/,
  /\.pem$/,
  /\.key$/,
  /\.pfx$/,
  /\.xlsx?$/,
  /\.sqlite3?$/,
];
const patterns = [
  { label: "API key", expression: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { label: "AWS access key", expression: /\bAKIA[A-Z0-9]{16}\b/ },
  {
    label: "private key",
    expression: new RegExp(`-${"----BEGIN"} (?:RSA |EC |OPENSSH )?PRIVATE KEY-${"----"}`),
  },
  { label: "private relay URL", expression: new RegExp(["api", "oai", "sb"].join("\\."), "i") },
  { label: "local source path", expression: new RegExp("CarIllustration" + "Aanlysis", "i") },
  { label: "production short-rental table", expression: new RegExp("ads_clgl_" + "ycc" + "ldd_df", "i") },
  { label: "production long-rental table", expression: new RegExp("ads_adm_" + "ltr_car_" + "dtal_df", "i") },
];

const failures = [];
await walk(root);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Public release scan passed.");
}

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      entry.isDirectory()
      && (skippedDirectories.has(entry.name) || entry.name.endsWith(".egg-info"))
    ) continue;
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      await walk(absolute);
      continue;
    }
    if (!entry.isFile()) continue;
    if (forbiddenFiles.some((expression) => expression.test(entry.name))) {
      failures.push(`${relative}: forbidden public file type`);
      continue;
    }
    const buffer = await readFile(absolute);
    const text = buffer.toString("utf8");
    for (const pattern of patterns) {
      if (pattern.expression.test(text)) failures.push(`${relative}: ${pattern.label}`);
    }
  }
}
