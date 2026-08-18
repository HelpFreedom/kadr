#!/usr/bin/env node
/**
 * Patch node-pty & winpty .gyp files to disable SpectreMitigation.
 *
 * node-pty (and its winpty dep) set `SpectreMitigation: 'Spectre'` in their
 * binding.gyp / winpty.gyp.  On Windows dev machines that don't have the
 * "MSVC v143 – C++ x64/x86 Spectre-mitigated libs" VS component installed,
 * the MSBuild target Microsoft.CppBuild.targets fires an MSB8040 error and
 * the whole electron-rebuild / npm install fails.
 *
 * This script rewrites the value to 'false' in both files BEFORE
 * electron-rebuild kicks off, so the gyp generator emits
 * <SpectreMitigation>false</SpectreMitigation> into the vcxproj and the
 * Spectre-libs existence check in Microsoft.CppBuild.targets is skipped.
 *
 * Safe to run multiple times (idempotent).
 */
'use strict'
const fs = require('fs')
const path = require('path')

const REPO_ROOT = path.resolve(__dirname, '..')

const files = [
  'node_modules/node-pty/binding.gyp',
  'node_modules/node-pty/deps/winpty/src/winpty.gyp',
]

function patchFile(relPath) {
  const abs = path.join(REPO_ROOT, relPath)
  if (!fs.existsSync(abs)) return
  const src = fs.readFileSync(abs, 'utf8')
  const patched = src.replace(/'SpectreMitigation':\s*'Spectre'/g, "'SpectreMitigation': 'false'")
  if (patched !== src) {
    fs.writeFileSync(abs, patched)
    console.log(`patched ${relPath}`)
  } else {
    console.log(`already patched (or no match): ${relPath}`)
  }
}

let ok = true
for (const f of files) {
  try {
    patchFile(f)
  } catch (e) {
    console.error(`failed to patch ${f}: ${e.message}`)
    ok = false
  }
}
process.exit(ok ? 0 : 1)
