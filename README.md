# Velox — a faster drop-in for makefun-site 1.0.0

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/dankurniaone/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/dankurniaone/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

An entry for the [make.fun bounty "Build a static site faster, 22 November 2026"](https://make.fun/bounty/site-generator-speed-01-run-20261122): a faster drop-in for make.fun's own makefun-site 1.0.0 that answers exactly as it does on every case, then wins on CPU time.

## What it is

`solve.js` is a dependency-free ES module whose `run(input)` returns makefun-site's answer for one generated site `{ site, templates, files }` — the output tree (every page's `index.html`, the index and tag pages, `build-report.txt`, every static file), byte for byte. `main.ts` is the program the harness runs: it reads every case from `/input/cases.json`, answers each with `run`, and writes `/output/answers.json`.

## How it is faster

The reference is rebuilt, not wrapped, with the slow parts cut out:

- **One line split per source**, shared by the front-matter parser and the Markdown renderer, instead of splitting the body twice.
- **Markdown rendered straight to text** — no token objects, no second pass — with an inline scanner that jumps from one special character (`\`, `` ` ``, `*`, `[`) to the next instead of walking every character.
- **Slugs on a plain ASCII fast path**: most titles are ASCII, so the NFKD normalisation and the mark-stripping regex only run when a non-ASCII character actually shows up.
- **Templates compiled to functions**: each parsed template also compiles to a small function that appends to the output directly, with its loop bindings resolved at parse time instead of searched through a scope chain on every variable. A tree walker stays in the file as the fallback if a template cannot be compiled, so the answers are the same either way.
- **Broken links resolved once per directory and target** (a miss is never cached, because the same target from another source is its own broken link), and reading time counted line by line instead of by joining the whole body.

## Exactness

Verified against the reference on the kit's practice set (3/3 cases byte-exact) and on 12 further cases drawn from four fresh seeds with the kit's own generator (12/12 exact). On this machine the practice set runs in ~185 ms against the house baseline's ~530 ms — about 2.9x faster.

## Layout

- `solve.js` — the fast implementation (ES module, no dependencies)
- `main.ts` — the harness driver (Node 22)
- `package.json` — `{"type": "module"}`
- `LICENSE` — MIT

Built for the make.fun bounty linked above; the generator it matches is make.fun's own makefun-site 1.0.0.
