# ADR-0003: One file, no exports, no build step

Date: 2026-08-28 · Status: accepted

## Context

`plugin.js` is pushed straight into Thymer's plugin store, which loads it verbatim. There is no bundler, no transpiler, and the file deliberately carries **no `export` keyword**. The file is ~7,200 lines: one `Plugin extends AppPlugin` class plus a CSS template literal.

## Decision

Stay single-file. Deepening happens **inside** the class: small interfaces, deep implementations, clear section ownership (staged stores, proposal engine, write plan, creation engine) — not file splits, not modules, not a build step.

## Consequences

- "Extract a module" always means "extract a method group with a narrow interface on the same class", never "move to a new file".
- Tests, if added, load the whole file into a JS context with stubs for `AppPlugin`, `DateTime`, and `window`, and drive the pure statics (`_fillMatch`, `_fillPartial`, `_fillInit`, `_fillCanon`, `_fillDates`, `_propose`) — the file's own comments record replay numbers proving this surface is complete.
- Any proposal that requires `export`, an import graph, or a build pipeline contradicts this ADR and must argue against it first.
