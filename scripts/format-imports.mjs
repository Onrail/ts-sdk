#!/usr/bin/env node
//Normalises every import block so that each statement reads as three columns: the `import [type] {`
//  opener, the symbol block, and the closing `} from "<module>";`. Lines within the symbol block are
//  capped at the last line's budget, so the block's right edge never passes the `}` column and the
//  third column always starts clean. Run with --check to report rather than rewrite.
//
//Within a block (a run of import statements separated only by blank lines) statements are merged per
//  (module, type-ness), then sorted external -> SDK packages in dependency order -> relative, stable
//  within a tier, with a module's type import ahead of its value import. Statements carrying a
//  comment are left verbatim: reflowing them would strand the comment mid-list. So are those
//  binding anything besides the braced symbols (a default or namespace import), which the opener
//  column has no room for.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { packagesDir, isVendored } from './workspace.mjs';

const WIDTH = 100;
const PKG_RANK =
  { utils: 0, 'binary-layout': 1, amount: 2, common: 3, evm: 4, svm: 5, 'fork-svm': 6 };
const STMT = /^import\b[^;]*?from\s+"[^"]*";/gm;

const tsFilesIn = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter(d => d.isFile() && d.name.endsWith('.ts'))
  .map(d => join(d.parentPath, d.name))
  .filter(f => !f.includes('/node_modules/') && !f.includes('/dist/') && !isVendored(f));

const parse = (text, start) => {
  const module = /from\s+"([^"]*)";\s*$/.exec(text)[1];
  const braces = /^import\s+(?:type\s+)?\{([\s\S]*)\}/.exec(text);
  const tier = module.startsWith('.') ? 2 : module.startsWith('@onrail-xyz/') ? 1 : 0;
  return {
    text, start, module, tier,
    end:        start + text.length,
    isType:     text.startsWith('import type'),
    braced:     braces !== null,
    symbols:    braces ? braces[1].split(',').map(s => s.trim()).filter(Boolean) : [],
    hasComment: text.includes('//') || text.includes('/*'),
    rank:       tier === 1 ? PKG_RANK[module.split('/')[1]] : 0,
  };
};

//lays the symbols out over as few lines as the shared cap allows, then picks among those splits the
//  one with the narrowest last segment (which must be the widest, so nothing overhangs the `}`),
//  then the flattest staircase: least total drop between successive widths, least squared slack
const layout = (symbols, prefixLen, tailLen) => {
  const n = symbols.length;
  const w = symbols.map(s => s.length);
  const seg = (i, j, last) =>
    w.slice(i, j).reduce((a, b) => a + b, 0) + 2 * (j - i - 1) + (last ? 0 : 1);
  const cap = WIDTH - prefixLen - tailLen;

  const minLines = Array(n + 1).fill(Infinity);
  minLines[n] = 0;
  for (let i = n - 1; i >= 0; --i)
    for (let j = i + 1; j <= n; ++j) {
      if (seg(i, j, j === n) > cap) break;
      minLines[i] = Math.min(minLines[i], minLines[j] + 1);
    }
  if (!isFinite(minLines[0])) return null;
  if (minLines[0] === 1) return [symbols];

  const search = (lines) => {
    let best = null;
    for (let t = 1; t < n; ++t) {
      const last = seg(t, n, true);
      if (last > cap) continue;
      const memo = new Map();
      const prefix = (i, k, prev) => {
        if (i === t) return k === 0 ? { drop: 0, slack: 0, segs: [] } : null;
        if (k === 0) return null;
        const key = `${i},${k},${prev}`;
        if (memo.has(key)) return memo.get(key);
        let res = null;
        for (let j = i + 1; j <= t; ++j) {
          const width = seg(i, j, false);
          if (width > last) break;
          const sub = prefix(j, k - 1, width);
          if (!sub) continue;
          const cand = {
            drop:  sub.drop + Math.max(prev - width, 0),
            slack: sub.slack + (last - width) ** 2,
            segs:  [symbols.slice(i, j), ...sub.segs],
          };
          if (!res || cand.drop < res.drop || (cand.drop === res.drop && cand.slack < res.slack))
            res = cand;
        }
        memo.set(key, res);
        return res;
      };
      const r = prefix(0, lines - 1, 0);
      if (!r) continue;
      const cand = { last, drop: r.drop, slack: r.slack, segs: [...r.segs, symbols.slice(t, n)] };
      if (!best || cand.last < best.last ||
          (cand.last === best.last && (cand.drop < best.drop ||
            (cand.drop === best.drop && cand.slack < best.slack))))
        best = cand;
    }
    return best?.segs ?? null;
  };

  //a long symbol stranded mid-list can make a widest-last split impossible at any line count; there
  //  one extra line is worth trying, and failing that the tightest block wins over a clean column
  for (const lines of [minLines[0], minLines[0] + 1]) {
    const r = search(lines);
    if (r) return r;
  }

  const linesCapped = (limit) => {
    const ml = Array(n + 1).fill(Infinity);
    ml[n] = 0;
    for (let i = n - 1; i >= 0; --i)
      for (let j = i + 1; j <= n; ++j) {
        const width = seg(i, j, j === n);
        if (width > cap) break;
        if (width <= limit) ml[i] = Math.min(ml[i], ml[j] + 1);
      }
    return ml[0];
  };
  let lo = Math.max(...w), hi = cap;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (linesCapped(mid) <= minLines[0]) hi = mid; else lo = mid + 1;
  }
  const memo = new Map();
  const balance = (i, k) => {
    if (i === n) return k === 0 ? { slack: 0, segs: [] } : null;
    if (k === 0) return null;
    const key = `${i},${k}`;
    if (memo.has(key)) return memo.get(key);
    let res = null;
    for (let j = i + 1; j <= n; ++j) {
      const width = seg(i, j, j === n);
      if (width > cap) break;
      if (width > lo) continue;
      const sub = balance(j, k - 1);
      if (!sub) continue;
      const cand = {
        slack: sub.slack + (lo - width) ** 2,
        segs:  [symbols.slice(i, j), ...sub.segs],
      };
      if (!res || cand.slack < res.slack) res = cand;
    }
    memo.set(key, res);
    return res;
  };
  return balance(0, minLines[0])?.segs ?? null;
};

const render = (stmt) => {
  if (stmt.hasComment || !stmt.braced) return stmt.text;
  const prefix = stmt.isType ? 'import type { ' : 'import { ';
  const tail = ` } from "${stmt.module}";`;
  const segs = layout(stmt.symbols, prefix.length, tail.length);
  if (!segs) return prefix + stmt.symbols.join(', ') + tail;
  return segs
    .map((s, i) => (i === 0 ? prefix : ' '.repeat(prefix.length)) + s.join(', ') +
                   (i < segs.length - 1 ? ',' : tail))
    .join('\n');
};

const formatted = (src) => {
  const stmts = [...src.matchAll(STMT)].map(m => parse(m[0], m.index));
  if (stmts.length === 0) return src;

  const blocks = [[stmts[0]]];
  for (let i = 1; i < stmts.length; ++i) {
    if (src.slice(stmts[i - 1].end, stmts[i].start).trim() === '') blocks.at(-1).push(stmts[i]);
    else blocks.push([stmts[i]]);
  }

  const out = [];
  let pos = 0;
  for (const block of blocks) {
    out.push(src.slice(pos, block[0].start));
    pos = block.at(-1).end;

    const merged = [];
    const seen = new Map();
    for (const stmt of block) {
      if (!stmt.braced || stmt.hasComment) { merged.push(stmt); continue; }
      const key = `${stmt.module} ${stmt.isType}`;
      const target = seen.get(key);
      if (target) {
        for (const symbol of stmt.symbols)
          if (!target.symbols.includes(symbol)) target.symbols.push(symbol);
      }
      else { seen.set(key, stmt); merged.push(stmt); }
    }

    const firstSeen = new Map();
    merged.forEach((stmt, i) => {
      if (!firstSeen.has(stmt.module)) firstSeen.set(stmt.module, i);
    });
    merged.sort((a, b) =>
      a.tier - b.tier || a.rank - b.rank ||
      firstSeen.get(a.module) - firstSeen.get(b.module) ||
      (a.isType ? 0 : 1) - (b.isType ? 0 : 1));

    out.push(merged.map(render).join('\n'));
  }
  out.push(src.slice(pos));
  return out.join('');
};

const check = process.argv.includes('--check');
const changed = [];
for (const file of tsFilesIn(packagesDir)) {
  const src = readFileSync(file, 'utf8');
  const next = formatted(src);
  if (next === src) continue;
  changed.push(file);
  if (!check) writeFileSync(file, next);
}

if (check && changed.length > 0) {
  console.error(`${changed.length} file(s) have unformatted imports:`);
  for (const file of changed) console.error(`  ${file}`);
  console.error('\nrun `pnpm format:imports` to fix');
  process.exit(1);
}
console.log(check ? 'imports formatted correctly' : `formatted ${changed.length} file(s)`);
