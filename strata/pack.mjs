#!/usr/bin/env node
// Packs apps/server into the tarball StrataMD bundles, the way upstream's
// publish command does: a trimmed manifest (no dev dependencies, catalog
// references resolved), the workspace LICENSE beside it, then `npm pack`.
// Usage: node strata/pack.mjs --version 0.0.41-strata.1 --out /path/to/dir
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const serverDir = join(root, 'apps/server')
const args = process.argv.slice(2)
const option = (name) => { const index = args.indexOf(name); if (index === -1 || !args[index + 1]) throw new Error(`Missing ${name}`); return args[index + 1] }
const version = option('--version')
const out = resolve(option('--out'))
if (!/^\d+\.\d+\.\d+-strata\.\d+$/.test(version)) throw new Error(`Version must look like 0.0.41-strata.1, got ${version}`)

for (const asset of ['dist/bin.mjs', 'dist/service-launcher.mjs', 'dist/client/index.html', 'dist/resource-monitor/linux-x64/t3-resource-monitor', 'dist/resource-monitor/darwin-x64/t3-resource-monitor', 'dist/resource-monitor/darwin-arm64/t3-resource-monitor', 'dist/resource-monitor/win32-x64/t3-resource-monitor.exe']) {
  if (!existsSync(join(serverDir, asset))) throw new Error(`Missing build asset ${asset}`)
}
const built = await readFile(join(serverDir, 'dist/bin.mjs'), 'utf8')
if (!built.includes(JSON.stringify(version))) throw new Error(`dist/bin.mjs was not built with version ${version}; stamp the version before building`)

const require = createRequire(join(serverDir, 'package.json'))
const { parse } = require('yaml')
const workspace = parse(await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8'))
const catalogs = { default: workspace.catalog ?? {}, ...(workspace.catalogs ?? {}) }
function resolveCatalog(dependencies, where) {
  const resolved = {}
  for (const [name, range] of Object.entries(dependencies ?? {})) {
    const match = /^catalog:(.*)$/.exec(String(range))
    if (!match) { resolved[name] = range; continue }
    const catalog = catalogs[match[1] || 'default']
    if (!catalog || !catalog[name]) throw new Error(`No catalog entry for ${name} (${where})`)
    resolved[name] = catalog[name]
  }
  for (const [name, range] of Object.entries(resolved)) if (/^(workspace|catalog|link|file):/.test(String(range))) throw new Error(`${where}.${name} is ${range}`)
  return resolved
}
const manifestPath = join(serverDir, 'package.json')
const original = await readFile(manifestPath)
const source = JSON.parse(original.toString('utf8'))
const manifest = {
  name: source.name,
  ...(source.repository ? { repository: source.repository } : {}),
  bin: source.bin,
  type: source.type,
  version,
  engines: source.engines,
  files: source.files,
  dependencies: resolveCatalog(source.dependencies, 'dependencies'),
  // Upstream also publishes pnpm workspace overrides. npm ignores a dependency's overrides and rejects pnpm's selector syntax, so they are omitted here.
}
if (manifest.name !== 't3') throw new Error(`Unexpected package name ${manifest.name}`)
const licensePath = join(serverDir, 'LICENSE')
const hadLicense = existsSync(licensePath)
await mkdir(out, { recursive: true })
try {
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  if (!hadLicense) await copyFile(join(root, 'LICENSE'), licensePath)
  const result = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', out], { cwd: serverDir, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`npm pack exited ${result.status}`)
} finally {
  await writeFile(manifestPath, original)
  if (!hadLicense) await rm(licensePath, { force: true })
}
const file = join(out, `t3-${version}.tgz`)
if (!existsSync(file)) throw new Error(`npm pack did not produce ${file}: ${(await readdir(out)).join(', ')}`)
const bytes = await readFile(file)
const sha256 = createHash('sha256').update(bytes).digest('hex')
await writeFile(`${file}.sha256`, `${sha256}  ${basename(file)}\n`)
console.log(JSON.stringify({ file, sha256, bytes: bytes.length }))
