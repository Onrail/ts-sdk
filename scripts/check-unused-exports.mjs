#!/usr/bin/env node
//Reports symbols carrying `export` that nothing outside their own file uses. Advisory only: a
//  deliberately-exported-but-unused symbol is legitimate, so this never fails the build.
//
//Only symbols *off* a package's public surface are considered. What index.ts re-exports is API,
//  and an API roster must cohere on its own - usage counts do not adjudicate what belongs in it.
//The keyword stops carrying information precisely where index.ts curates a named subset: there
//  `export` no longer means "public", so leftovers accumulate beside the curated list unnoticed.
//
//Uses are found by word-boundary text search across the package's other src and test files, which
//  over-counts (a mention in a comment reads as a use). That biases towards missing findings
//  rather than inventing them - the right direction for a check nobody should have to argue with.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { packagesDir, packageNames, isVendored } from './workspace.mjs';

const stripExt = (spec) => spec.replace(/\.(js|ts)$/, '');

const tsFilesIn = (dir) => existsSync(dir)
  ? readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(d => d.isFile() && d.name.endsWith('.ts'))
    .map(d => join(d.parentPath, d.name))
    .filter(f => !isVendored(f))
  : [];

//the modules and named symbols index.ts republishes - i.e. the package's public surface
const publicSurfaceOf = (indexSrc) => {
  const modules = new Set();
  const named = new Map();

  for (const [, spec] of indexSrc.matchAll(/export\s+\*(?:\s+as\s+\w+)?\s+from\s*['"](\.\/[^'"]+)['"]/g))
    modules.add(stripExt(spec));

  for (const [, names, spec] of indexSrc.matchAll(/export\s*\{([^}]*)\}\s*from\s*['"](\.\/[^'"]+)['"]/g)) {
    const mod = stripExt(spec);
    if (!named.has(mod))
      named.set(mod, new Set());

    for (const [source] of clauseEntries(names))
      named.get(mod).add(source);
  }

  return { modules, named };
};

//each entry as [name at its source, name published]: `type a as b` is [a, b], `a` is [a, a]
const clauseEntries = (clause) => clause
  .split(',')
  .map(n => n.trim().replace(/^type\s+/, ''))
  .filter(Boolean)
  .map(n => n.split(/\s+as\s+/))
  .map(([source, published = source]) => [source, published]);

const declaredExportsOf = (src) => {
  const names = [];
  const decl =
    /^export\s+(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:const|let|var|function\*?|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm;
  for (const [, name] of src.matchAll(decl))
    names.push(name);

  //local export lists (`export { a, b }`) - the `from` form is a re-export, not a declaration
  for (const [, clause, from] of src.matchAll(/export\s*\{([^}]*)\}\s*(?:from\s*['"]([^'"]+)['"])?/g))
    if (from === undefined)
      names.push(...clauseEntries(clause).map(([, published]) => published));

  return names;
};

let findings = 0;
for (const pkg of packageNames()) {
  const src = join(packagesDir, pkg, 'src');
  const index = join(src, 'index.ts');
  if (!existsSync(index))
    continue;

  const { modules, named } = publicSurfaceOf(readFileSync(index, 'utf-8'));
  const sources = tsFilesIn(src).filter(f => f !== index);
  const consumers = [...sources, ...tsFilesIn(join(packagesDir, pkg, 'tests'))]
    .map(f => [f, readFileSync(f, 'utf-8')]);

  for (const file of sources) {
    const mod = stripExt(relative(src, file)).split('\\').join('/');
    if (modules.has(`./${mod}`))
      continue; //wholly republished - every export in it is API

    const surfaced = named.get(`./${mod}`) ?? new Set();
    for (const name of declaredExportsOf(readFileSync(file, 'utf-8'))) {
      if (surfaced.has(name))
        continue;

      //`$` is an identifier character but not a word character to \b, so `\b$x` could only match
      //  inside a longer identifier
      const mention = new RegExp(`(?<![\\w$])${RegExp.escape(name)}(?![\\w$])`);
      const used = consumers.some(([f, text]) => f !== file && mention.test(text));
      if (!used) {
        console.log(`  ${relative(packagesDir, file)}: ${name}`);
        ++findings;
      }
    }
  }
}

console.log(findings === 0
  ? '✓ no unused non-public exports'
  : `\n${findings} symbol(s) exported but used only within their own file - drop the keyword ` +
    `unless the export is deliberate (advisory, not a failure)`);
