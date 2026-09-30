#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { packagesDir, packageNames } from './workspace.mjs';

const newVersion = process.argv[2];
//an unvalidated version would be written into every manifest and, prefixed with ^, into every
//  internal peer range, where a malformed range breaks installs rather than this script
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/.test(newVersion ?? '')) {
  console.error('Usage: node scripts/bump-versions.mjs <version>');
  console.error('Example: node scripts/bump-versions.mjs 1.0.2');
  process.exit(1);
}

for (const pkg of packageNames()) {
  const pkgPath = join(packagesDir, pkg, 'package.json');
  const pkgJson = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  pkgJson.version = newVersion;

  //internal packages reference each other as peers and are released in lockstep, so their ranges
  //  have to track the new version
  for (const dep of Object.keys(pkgJson.peerDependencies ?? {}))
    if (dep.startsWith('@onrail-xyz/'))
      pkgJson.peerDependencies[dep] = `^${newVersion}`;

  writeFileSync(pkgPath, JSON.stringify(pkgJson, null, 2) + '\n');
  console.log(`✓ ${pkgJson.name} → ${newVersion}`);
}

console.log(`\nAll packages bumped to ${newVersion}`);

