#!/usr/bin/env node
// Packs apps/server into the tarball ExarchMD bundles, the way upstream's
// publish command does: a trimmed manifest (no dev dependencies, catalog
// references resolved), the workspace LICENSE beside it, then `npm pack`.
// Usage: node exarch/pack.mjs --version 0.0.41-exarch.1 --out /path/to/dir
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = join(root, "apps/server");
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  if (index === -1 || !args[index + 1]) throw new Error(`Missing ${name}`);
  return args[index + 1];
};
const version = option("--version");
const out = resolve(option("--out"));
const target = args.includes("--target") ? option("--target") : null;
const platforms = ["linux-x64", "darwin-x64", "darwin-arm64", "win32-x64"];
if (target !== null && !platforms.includes(target)) throw new Error(`Unsupported target ${target}`);
if (!/^\d+\.\d+\.\d+-exarch\.\d+$/.test(version))
  throw new Error(`Version must look like 0.0.41-exarch.1, got ${version}`);

for (const asset of [
  "dist/bin.mjs",
  "dist/claude-history-worker.mjs",
  "dist/client/index.html",
  ...(target ? [target] : platforms).map(platform =>
    `dist/resource-monitor/${platform}/t3-resource-monitor${platform.startsWith("win32") ? ".exe" : ""}`),
]) {
  if (!existsSync(join(serverDir, asset))) throw new Error(`Missing build asset ${asset}`);
}
const built = (await Promise.all((await readdir(join(serverDir, "dist")))
  .filter(file => file.endsWith(".mjs"))
  .map(file => readFile(join(serverDir, "dist", file), "utf8")))).join("\n");
if (!built.includes(JSON.stringify(version)))
  throw new Error(
    `dist/bin.mjs was not built with version ${version}; stamp the version before building`,
  );

const require = createRequire(join(serverDir, "package.json"));
const { parse } = require("yaml");
const workspace = parse(await readFile(join(root, "pnpm-workspace.yaml"), "utf8"));
const catalogs = { default: workspace.catalog ?? {}, ...(workspace.catalogs ?? {}) };
function resolveCatalog(dependencies, where) {
  const resolved = {};
  for (const [name, range] of Object.entries(dependencies ?? {})) {
    const match = /^catalog:(.*)$/.exec(String(range));
    if (!match) {
      resolved[name] = range;
      continue;
    }
    const catalog = catalogs[match[1] || "default"];
    if (!catalog || !catalog[name]) throw new Error(`No catalog entry for ${name} (${where})`);
    resolved[name] = catalog[name];
  }
  for (const [name, range] of Object.entries(resolved))
    if (/^(workspace|catalog|link|file):/.test(String(range)))
      throw new Error(`${where}.${name} is ${range}`);
  return resolved;
}
// npm does not apply pnpm patches. Preserve patched files for dependencies
// the CLI loads from disk; bundled JavaScript already includes its patches.
const { isRuntimeExternalCliDependency } = await import("../scripts/lib/cli-external-packages.ts");
const runtimePatches = [];
for (const [selector, patchPath] of Object.entries(workspace.patchedDependencies ?? {})) {
  const separator = selector.lastIndexOf("@");
  const name = selector.slice(0, separator);
  if (!isRuntimeExternalCliDependency(name)) continue;
  const packageRoot = join(serverDir, "node_modules", name);
  const installed = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  if (installed.version !== selector.slice(separator + 1)) throw new Error(`Patch version mismatch for ${selector}`);
  const patch = await readFile(join(root, patchPath), "utf8");
  const paths = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(match => match[1]);
  if (!paths.length) throw new Error(`No patched runtime files in ${patchPath}`);
  const files = [];
  for (const path of paths) files.push({ path, contents: await readFile(join(packageRoot, path), "utf8") });
  runtimePatches.push({ name, version: installed.version, source: patchPath, files });
}
await writeFile(join(serverDir, "dist/runtime-patches.json"), JSON.stringify(runtimePatches, null, 2) + "\n");

const manifestPath = join(serverDir, "package.json");
const original = await readFile(manifestPath);
const source = JSON.parse(original.toString("utf8"));
const manifest = {
  name: source.name,
  ...(source.repository ? { repository: source.repository } : {}),
  bin: source.bin,
  type: source.type,
  version,
  engines: source.engines,
  files: [...new Set([...(source.files ?? []), "NOTICE"])],
  dependencies: resolveCatalog(source.dependencies, "dependencies"),
  // Upstream also publishes pnpm workspace overrides. npm ignores a dependency's overrides and rejects pnpm's selector syntax, so they are omitted here.
};
if (manifest.name !== "t3") throw new Error(`Unexpected package name ${manifest.name}`);
const licensePath = join(serverDir, "LICENSE");
const hadLicense = existsSync(licensePath);
const noticePath = join(serverDir, "NOTICE");
const originalNotice = existsSync(noticePath) ? await readFile(noticePath) : null;
await mkdir(out, { recursive: true });
try {
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  if (!hadLicense) await copyFile(join(root, "LICENSE"), licensePath);
  await copyFile(join(root, "exarch/THIRD_PARTY_NOTICES.md"), noticePath);
  const result = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", out], {
    cwd: serverDir,
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`npm pack exited ${result.status}`);
} finally {
  await writeFile(manifestPath, original);
  if (!hadLicense) await rm(licensePath, { force: true });
  if (originalNotice === null) await rm(noticePath, { force: true });
  else await writeFile(noticePath, originalNotice);
}
const file = join(out, `t3-${version}.tgz`);
if (!existsSync(file))
  throw new Error(`npm pack did not produce ${file}: ${(await readdir(out)).join(", ")}`);
const bytes = await readFile(file);
const sha256 = createHash("sha256").update(bytes).digest("hex");
await writeFile(`${file}.sha256`, `${sha256}  ${basename(file)}\n`);
console.log(JSON.stringify({ file, sha256, bytes: bytes.length }));
