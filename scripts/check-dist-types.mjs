#!/usr/bin/env node
//Guards emitted declarations on three axes: @types/node types leaking out, size, and validity.
//  Every package compiles with "types": ["node"] (TextEncoder/TextDecoder are unavailable
//  otherwise), so an inferred return type flowing out of a node-typed API silently makes a
//  package uninstallable for consumers without @types/node - e.g. TextEncoder.encode() infers
//  NodeJS.NonSharedUint8Array, which is only nameable with those types present. Validity: tsc
//  does not check the declarations it prints, and an inferred type it has to respell can come
//  out as one that does not compile.

import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { rootDir, packagesDir, packageNames } from './workspace.mjs';

//fork-svm wraps a native node addon and is node-only by nature, so node types in its declarations
//  are correct rather than a leak
const nodeOnlyPackages = new Set(['fork-svm']);

//conditional-ladder expansions print as one enormous line (mechanism: DeclarationEmit.md); every
//  hand-written declaration stays well under this, including deliberately long ones like svm's
//  `allAddresses` literal (3000) and binary-layout's `SetItemEndianness` conditional (957)
const lineCeiling = 4000;

//object-type expansions print multi-line and indented, invisible to line width, so file size is
//  the second axis. The largest legitimate file (common's units.d.ts, sized by the brand
//  pattern's structural doubling) is 22 KB; the smallest observed pathology was 155 KB
const sizeCeiling = 65536;

//offenders are recorded as debt rather than silently tolerated. A recorded budget is a ratchet:
//  it follows every improvement down, so ground regained cannot quietly be lost again, and leaves
//  its list once back under the ceiling
const lineDebt = new Map(Object.entries({}));
const sizeDebt = new Map(Object.entries({}));

const declarationsOf = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter(d => d.isFile() && d.name.endsWith('.d.ts'))
  .map(d => join(d.parentPath, d.name));

//a consumer without @types/node still has whatever lib the package's dependencies demand of it:
//  ESNext alone for a package with no external dependencies, DOM too for one on viem or kit, whose
//  declarations name DOM globals
const portable = { esnext: [], 'esnext,dom': [] };

let oversized = 0;
let slack = 0;
for (const pkg of packageNames()) {
  let dist;
  try {
    dist = declarationsOf(join(packagesDir, pkg, 'dist'));
  } catch {
    console.error(`✗ ${pkg}: no dist/ - run build first`);
    process.exit(1);
  }

  for (const file of dist) {
    const contents = readFileSync(file, 'utf-8');
    const rel = relative(packagesDir, file);
    const lines = contents.split('\n');
    const widest = Math.max(...lines.map(l => l.length));
    for (const [actual, ceiling, debt, what] of [
      [widest,          lineCeiling, lineDebt, 'widest declaration (chars)'],
      [contents.length, sizeCeiling, sizeDebt, 'file size (bytes)'         ],
    ]) {
      const budget = debt.get(rel) ?? ceiling;
      if (actual > budget) {
        console.error(`✗ ${rel}: ${what} is ${actual}, over its ${budget} budget`);
        ++oversized;
      }
      else if (debt.has(rel) && actual <= ceiling) {
        console.error(`✗ ${rel}: ${what} is now ${actual} - drop its debt entry`);
        ++slack;
      }
      else if (debt.has(rel) && actual < budget) {
        console.error(`✗ ${rel}: ${what} is now ${actual} - lower its budget from ${budget}`);
        ++slack;
      }
    }
  }

  if (!nodeOnlyPackages.has(pkg)) {
    const { dependencies, peerDependencies } =
      JSON.parse(readFileSync(join(packagesDir, pkg, 'package.json'), 'utf-8'));
    const external = Object.keys({ ...dependencies, ...peerDependencies })
      .some(dep => !dep.startsWith('@onrail-xyz/'));
    portable[external ? 'esnext,dom' : 'esnext'].push(...dist);
  }
}

//typescript's exports map hides bin/, so the binary is found beside its package.json
const tsc = join(dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin', 'tsc');
const tscErrors = (args) => {
  try {
    execFileSync(process.execPath, [tsc, ...args], { encoding: 'utf-8' });
    return '';
  } catch (e) {
    return e.stdout || e.message;
  }
};

const invalid = tscErrors(['-p', join(rootDir, 'tsconfig.dist.json')]);

//only once the declarations are valid does every error without @types/node name a leak.
//  tsconfig.dist.json takes in the node-only packages too, so these runs name their files and
//  restate just the options that decide what a name resolves to
const portableOptions =
  ['--ignoreConfig', '--noEmit', '--skipLibCheck', 'false', '--module', 'nodenext', '--types', ''];
const leaks = invalid ? '' : Object.entries(portable)
  .filter(([, files]) => files.length > 0)
  .map(([lib, files]) => tscErrors([...portableOptions, '--lib', lib, ...files]))
  .join('');

if (leaks || oversized > 0 || slack > 0 || invalid) {
  if (oversized > 0)
    console.error(`\n${oversized} over-wide declaration(s). Annotate the offending exports explicitly.`);
  if (slack > 0)
    console.error(`\n${slack} debt budget(s) looser than their file. Tighten them as indicated.`);
  if (invalid)
    console.error(`\n${invalid}\nPublished declarations do not type-check (node type leaks are checked ` +
      'once they do). Annotate the offending exports explicitly.');
  if (leaks)
    console.error(`\n${leaks}\nPublished declarations need @types/node. Annotate the offending return ` +
      'types explicitly.');
  process.exit(1);
}

console.log('✓ no node types leaked into published declarations');
console.log(`✓ no declaration wider than ${lineCeiling} chars or file over ${sizeCeiling} bytes (${lineDebt.size + sizeDebt.size} on the debt lists)`);
console.log('✓ published declarations type-check without skipLibCheck');
