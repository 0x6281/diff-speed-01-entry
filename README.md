# diff-speed-01-entry

A fast drop-in for makefun-diff 1.0.0: `solve.js` returns, for every `{ old, new }`,
exactly the patch makefun-diff 1.0.0 returns, as one string — and does it much faster.

## How it is faster

The baseline (jsdiff-derived) allocates a path object and a component object for every
`(d, k)` step of the Myers search, and materialises every line as a string twice
(`text.split('\n')`, then re-appending `'\n'`). This entry avoids both:

- **No substrings while diffing.** Each text is scanned once for its line start offsets
  (an `Int32Array`); a line is only sliced out of its text when the patch is emitted.
- **Line ids.** Each distinct line is hashed once (FNV-1a over its code units) and given
  a small integer id, so the Myers core compares ints, not strings. Equal hashes are
  confirmed by comparing code units, so a hash collision can never change the answer.
- **Flat V-arrays.** The Myers search keeps `V[d]`, the furthest old-lines-consumed on
  each diagonal at depth `d`, as one `Int32Array` per depth (kept for the backtrack).
  No object is allocated per diagonal. The edit script is recovered by backtracking
  through the V history with the same deletion-wins-ties rule the forward pass used.
- **Direct emission.** The patch is written straight from the edit script's runs; no
  intermediate component list is built. Prefix/suffix trimming runs on the id arrays.

## Practice result

Practice set (4 cases, ~21k–31k lines each, ~3,500–4,000 edits each):
`main.ts` on the practice set produces answers byte-identical to the reference
`expected.json` (4/4 cases), and two runs are byte-identical. A 502-case fuzz test
against makefun-diff 1.0.0 (edge cases plus random small/medium/large texts,
including heavy line duplication to stress the deletion-wins-ties rule) also
matches on every case.

Speed (Node 22, same machine, median of 5 runs per case after warm-up, diff time only;
an independent audit measured 2.9–3.0x on CPU time, and the same answers byte-identical):

| case | makefun-diff 1.0.0 | this entry | speedup |
|------|-------------------|------------|---------|
| g-0001 | 435 ms | 133 ms | 3.28x |
| g-0002 | 447 ms | 141 ms | 3.16x |
| g-0003 | 371 ms | 119 ms | 3.10x |
| g-0004 | 366 ms | 117 ms | 3.12x |
| **total** | **1,619 ms** | **511 ms** | **3.17x** |

Peak RSS ~165 MB on the practice set (limit 1,024 MB). Total repo size ~16 KB (limit 1 MiB).

## Files

- `solve.js` — the fast implementation (self-contained, no imports, no dependencies).
- `main.ts` — the driver (reads `/input/cases.json`, writes `/output/answers.json`).
