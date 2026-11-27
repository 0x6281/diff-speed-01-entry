// Fast makefun-diff 1.0.0: make.fun's own line diff, written from its rule (the baseline's
// vendor/makefun-diff/index.js header states it; this module is an original implementation of
// that rule, not a copy of the baseline or of jsdiff). run(input) returns, for { old, new },
// exactly the patch makefun-diff 1.0.0 returns, as one string.
//
// The rule, briefly: lines are cut after every "\n" (a last line with no "\n" is a line too);
// the common prefix is kept, then the common suffix of what is left; between them Myers's
// greedy search from the first lines, keeping on each diagonal the path furthest into the old
// text and, when a deletion and an insertion reach the same point, taking the DELETION's,
// never moving past either text's end, pruning no edge diagonal, and following every run of
// equal lines as far as it goes; the first path to reach both ends is the script. The patch
// is "makefun-diff/1 old=N new=M hunks=H deleted=D inserted=I", then each hunk "@ os ol ns nl"
// with "=" kept, "-" deleted, "+" inserted lines, deletions before insertions in each change
// run, up to 3 kept lines before and after each run, runs at most 6 kept lines apart sharing
// a hunk, and a line with no trailing newline written with one and followed by a "%" line.
//
// How it is faster than the baseline (which allocates a path object and a component object
// per (d, k) step of the Myers search, and materialises every line as a string twice):
//   - Lines are never materialised while diffing. Each text is scanned once for its line
//     start offsets (an Int32Array); a line is only sliced out of its text when the patch
//     is emitted.
//   - Each distinct line is hashed once (FNV-1a over its code units, no substring) and
//     given a small integer id; the Myers core compares ids (ints), not strings. Equal
//     hashes are confirmed by comparing code units, so a hash collision can never change
//     the answer.
//   - The Myers search runs on flat Int32Arrays: V[d] is the furthest old-lines-consumed
//     on each diagonal at depth d (one Int32Array per depth, kept for the backtrack), no
//     object is allocated per diagonal. The edit script is recovered by backtracking
//     through the V history with the same deletion-wins-ties rule the forward pass used.
//   - The patch is emitted straight from the edit script's runs; no intermediate
//     component list is built.

/** Ops, as the patch writes them. */
const KEEP = 0;
const DELETE = 1;
const INSERT = 2;

/** The patch's first word and the context a hunk shows around each change run. */
const FORMAT = 'makefun-diff/1';
const CONTEXT = 3;

/**
 * A text's line starts: starts[i] is the start offset of line i, starts[count] is the
 * text's length (the end of the last line). Line i is [starts[i], starts[i+1]).
 * The empty text has no lines; "\n" has one, an empty line.
 * (indexOf is the native scan; a charCodeAt loop over the same text is ~70% slower.)
 */
function lineStarts(text) {
  const n = text.length;
  if (n === 0) return new Int32Array(1);
  const starts = [0];
  let pos = 0;
  while (true) {
    const idx = text.indexOf('\n', pos);
    if (idx === -1) break;
    if (idx + 1 < n) starts.push(idx + 1);
    pos = idx + 1;
  }
  starts.push(n);
  return Int32Array.from(starts);
}

/**
 * A line's fingerprint (no substring is made): its length plus its first and last
 * 8 code units. Two different lines can share one (rare: 31 in 24,262 distinct lines
 * of the practice set); the interner confirms a match by comparing code units, so a
 * collision can never change the answer. Short lines are hashed whole.
 */
function hashLine(text, start, end) {
  const len = end - start;
  let h = (Math.imul(len, 2654435761) | 0) ^ 0x811c9dc5;
  const take = len < 8 ? len : 8;
  for (let i = 0; i < take; i++) h = (Math.imul(h, 31) + text.charCodeAt(start + i)) | 0;
  if (len > take) {
    const tailStart = len - 8;
    for (let i = tailStart; i < len; i++) h = (Math.imul(h, 31) + text.charCodeAt(start + i)) | 0;
  }
  return h | 0;
}

/**
 * The edit script of the two id arrays as runs [{ kind, count }], in order, by the header's
 * rule. The forward pass keeps V[d], the furthest old-lines-consumed on each diagonal at
 * depth d; the backtrack walks it back with the same deletion-wins-ties rule.
 */
function editRuns(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  // vs[d] is an Int32Array(2d+1); vs[d][k + d] is the furthest x on diagonal k at depth d
  // (after its snake), or -1 when that diagonal was not reached at that depth.
  const vs = [];
  // Depth 0: the snake from (0, 0).
  let v0 = new Int32Array(1);
  let x = 0;
  let y = 0;
  while (x < n && y < m && a[x] === b[y]) { x++; y++; }
  v0[0] = x;
  vs.push(v0);
  if (x >= n && y >= m) return [{ kind: KEEP, count: x }];
  let D = -1;
  let K = 0;
  for (let d = 1; d <= n + m; d++) {
    const vd = new Int32Array(2 * d + 1);
    vd.fill(-1);
    const vPrev = vs[d - 1];
    const dm1 = d - 1;
    let found = false;
    for (let k = -d; k <= d; k += 2) {
      // V[d-1][k-1] sits at vPrev[k + d - 2]; V[d-1][k+1] at vPrev[k + d].
      const vDown = (k - 1 >= -dm1 && k - 1 <= dm1) ? vPrev[k + d - 2] : -1;
      const vUp = (k + 1 >= -dm1 && k + 1 <= dm1) ? vPrev[k + d] : -1;
      // A deletion is possible while an old line is left; an insertion while a new one is.
      const canRemove = vDown !== -1 && vDown < n;
      const canAdd = vUp !== -1 && (vUp - 1 - k) < m;
      if (!canRemove && !canAdd) continue;
      // The candidate further into the old text, and the deletion when both reach one point.
      const byDeletion = canRemove ? vDown : -2;
      const byInsertion = canAdd ? vUp - 1 : -2;
      let xx = byDeletion >= byInsertion ? vDown + 1 : vUp;
      let yy = xx - k;
      while (xx < n && yy < m && a[xx] === b[yy]) { xx++; yy++; }
      vd[k + d] = xx;
      if (xx >= n && yy >= m) { D = d; K = k; found = true; break; }
    }
    vs.push(vd);
    if (found) break;
  }
  if (D === -1) throw new Error('makefun-diff: the search ended without reaching both ends');

  // Backtrack from (D, K). opsRev collects the ops in reverse order.
  const opsRev = [];
  let k = K;
  for (let d = D; d >= 1; d--) {
    const vPrev = vs[d - 1];
    const dm1 = d - 1;
    const vDown = (k - 1 >= -dm1 && k - 1 <= dm1) ? vPrev[k + d - 2] : -1;
    const vUp = (k + 1 >= -dm1 && k + 1 <= dm1) ? vPrev[k + d] : -1;
    const canRemove = vDown !== -1 && vDown < n;
    const canAdd = vUp !== -1 && (vUp - 1 - k) < m;
    const byDeletion = canRemove ? vDown : -2;
    const byInsertion = canAdd ? vUp - 1 : -2;
    const deletion = byDeletion >= byInsertion;
    // The snake at this depth: from the edit point to V[d][k].
    const editX = deletion ? vDown + 1 : vUp;
    const snakeLen = vs[d][k + d] - editX;
    for (let i = 0; i < snakeLen; i++) opsRev.push(KEEP);
    if (deletion) {
      opsRev.push(DELETE);
      k--;
    } else {
      opsRev.push(INSERT);
      k++;
    }
  }
  // The depth-0 snake, from (0, 0) to (V[0][0], V[0][0]).
  const firstSnake = vs[0][0];
  for (let i = 0; i < firstSnake; i++) opsRev.push(KEEP);

  // Reverse and group into runs.
  const runs = [];
  for (let i = opsRev.length - 1; i >= 0; i--) {
    const kind = opsRev[i];
    const last = runs.length > 0 ? runs[runs.length - 1] : undefined;
    if (last !== undefined && last.kind === kind) last.count++;
    else runs.push({ kind, count: 1 });
  }
  return runs;
}

/** A line as the patch writes it: its op, the line, a newline, and "%" when it had none. */
function written(op, text, start, end) {
  if (text.charCodeAt(end - 1) === 10) return op + text.slice(start, end);
  return op + text.slice(start, end) + '\n%\n';
}

/** make.fun's own patch of input.old into input.new (the header). */
function diffPatch(oldText, newText) {
  const sOld = lineStarts(oldText);
  const sNew = lineStarts(newText);
  const n = sOld.length - 1;
  const m = sNew.length - 1;

  // Give each distinct line a small integer id (hash once, confirm equal hashes by
  // comparing code units, so a collision can never change the answer).
  const idsOld = new Int32Array(n);
  const idsNew = new Int32Array(m);
  const byHash = new Map();
  let nextId = 0;
  const intern = (ti, text, starts, i) => {
    const start = starts[i];
    const end = starts[i + 1];
    const len = end - start;
    const h = hashLine(text, start, end);
    let list = byHash.get(h);
    if (list === undefined) {
      const id = nextId++;
      byHash.set(h, [{ id, ti, start, len }]);
      return id;
    }
    for (let j = 0; j < list.length; j++) {
      const c = list[j];
      if (c.len !== len) continue;
      const ct = c.ti === 0 ? oldText : newText;
      let eq = true;
      for (let p = 0; p < len; p++) {
        if (text.charCodeAt(start + p) !== ct.charCodeAt(c.start + p)) { eq = false; break; }
      }
      if (eq) return c.id;
    }
    const id = nextId++;
    list.push({ id, ti, start, len });
    return id;
  };
  for (let i = 0; i < n; i++) idsOld[i] = intern(0, oldText, sOld, i);
  for (let j = 0; j < m; j++) idsNew[j] = intern(1, newText, sNew, j);

  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && idsOld[prefix] === idsNew[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && idsOld[n - 1 - suffix] === idsNew[m - 1 - suffix]) suffix++;
  const runs = [];
  if (prefix > 0) runs.push({ kind: KEEP, count: prefix });
  runs.push(...editRuns(idsOld.subarray(prefix, n - suffix), idsNew.subarray(prefix, m - suffix)));
  if (suffix > 0) runs.push({ kind: KEEP, count: suffix });

  // The change runs: each a stretch of deletions and insertions between two kept lines.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const r of runs) {
    if (r.kind === KEEP) {
      o += r.count;
      p += r.count;
      continue;
    }
    let c = changes.length > 0 ? changes[changes.length - 1] : undefined;
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (r.kind === DELETE) {
      c.dels += r.count;
      o += r.count;
      deleted += r.count;
    } else {
      c.ins += r.count;
      p += r.count;
      inserted += r.count;
    }
  }

  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks.length > 0 ? hunks[hunks.length - 1] : undefined;
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }
  const out = [`${FORMAT} old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(written('=', oldText, sOld[at], sOld[at + 1]));
      for (let i = 0; i < c.dels; i++) out.push(written('-', oldText, sOld[c.o + i], sOld[c.o + i + 1]));
      for (let i = 0; i < c.ins; i++) out.push(written('+', newText, sNew[c.p + i], sNew[c.p + i + 1]));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(written('=', oldText, sOld[at], sOld[at + 1]));
  }
  return out.join('');
}

/** makefun-diff 1.0.0's answer for one case's input. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  return diffPatch(input.old, input.new);
}
