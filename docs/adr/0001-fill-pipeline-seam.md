# ADR-0001: The fill pipeline is a seam — propose, then select, then write

Date: 2026-08-28 · Status: accepted

## Context

Fill From Title grew as one orchestrator (`_fillCompute`) that proposed values, decided which lines were ticked, materialised the preview, and — across two callers (`_doFill`, `_autofillRun`) — grouped and wrote them. The tick policy was co-decided in six places and the detached autofill engine reached into the dialog's state shape through an implicit `ctx` union. The bug class regenerated three releases running ("the ticked value was not saved", v1.3.1; the follow-engine gating fixes of v1.6.0/v1.8.0).

## Decision

The pipeline is three modules at one seam:

1. **Proposal engine** (`_propose`) — deep module. Target `{rec, guid, title, colGuid}` + `{cols, kw}` in; the fill payload out as a **value**. Owns all matching and inference: whole-name, initialism, partial, keyword aliases, follow (forward paths, page anchors, back-references), choices, dates, ticked-on-its-own defaults, ordering, hidden-set detection. Pure-ish: reads data, mutates nothing in Thymer's records or the dialog state — its one internal write is a derived `_init` stamp on pool items the engine itself built for the call (scratch, not shared state).
2. **Selection** — the dialog's state machine (`_fillSel/_fillPick/_fillExclusive/_fillIsOn`). UI-only; not part of the engine.
3. **Write plan** (`_fillWritePlan`) — ticked lines in, one grouped write per field out. Two named policies: `"picked"` (the dialog — caller already decided) and `"autofill"` (the detached contract: engine defaults only, blanks only, never replace, per-field opt-in).

`_writeFill` (write, settle, verify, retry) is unchanged and consumes the plan.

Liveness, rendering, and the ~1.1s whole-workspace pass belong to the dialog wrapper (`_fillCompute`), never the engine. The engine's result is discarded when the dialog closed or re-targeted mid-compute.

## Consequences

- The engine's payload shape is the interface and the test surface: a replay harness can drive `_propose` with recorded titles without booting Thymer's UI.
- The old `ctx` union (dialog state vs detached context, distinguished only by a `detached` flag) is deleted; a new key cannot silently break the detached caller because there is no shared shape left to break.
- A previous attempt to trigger the pipeline from **Enter in the page title** was removed (v1.8.0): Thymer's editor routes all keystrokes through one hidden proxy textarea, so the title field's identity is invisible to a plugin. Enter applies inside the dialog instead.

## History note

Removed in v1.8.0 after v1.4.0 shipped it: Enter-in-title could never fire. Do not re-propose keydown-based title triggers without new Thymer API surface.
