import { readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
export const packagesDir = join(rootDir, 'packages');

//by directory name; packages/ also collects entries that are not packages (e.g. macOS's .DS_Store)
export const packageNames = () => readdirSync(packagesDir, { withFileTypes: true })
  .filter(d => d.isDirectory() && existsSync(join(packagesDir, d.name, 'package.json')))
  .map(d => d.name);

//vendored verbatim from litesvm - neither its surface nor its formatting is ours to decide
export const isVendored = (file) => file.includes('/liteSvm/');
