# ADR-0002: Do not unify the per-type property value switches

Date: 2026-08-28 · Status: accepted

## Context

An architecture review (2026-08-28) proposed one adapter for Thymer's per-type property values, on the evidence that "read a value of type T" is written five times: `_isEmpty` (1385), `_copyValue` (1395), `_valuesOf` (3536), `_fillCurrent` (4604), `_fillPut`/`_fillLanded` (5678). The v1.2.0 bug ("every record cost counted zero" — `.getProperty()` vs `.prop()`) came from this family.

## Decision

**Not unified, deliberately.** Investigation found the five sites differ in their **accessor inventory**, not just their shaping:

- `_valuesOf` reads record values via `prop.records()`; `_fillCurrent` and `_copyValue` use `prop.linkedRecords()` / `prop.linkedRecord()`. Which of the two exists or behaves correctly is a live-API question — the defensive `prop.records ? ... :` guards exist precisely because the author could not assume it.
- `_isEmpty` tests emptiness via `choice()` and `linkedRecord()` even on fields that may be `many`; `selectedChoices()` / `linkedRecords()` might disagree. Changing the accessor changes the answer.
- `_copyValue` is a cross-record copy with filter rules (link-target filtering), not a read.
- The write side (`_fillPut`/`_fillLanded`, `_applyFixed`) already sits behind the fill pipeline's verified write path.

Unifying would change which Thymer accessors get called — unprovable without the running app, in the one region where a bug previously corrupted record data.

## Consequences

- The per-type knowledge stays local to each engine, each with its paid-for comment. API drift is caught by `window.__gpFillLog` (fill writes) and the Change screen's cost counters.
- **Revisit only when** a fourth consumer appears or Thymer documents the accessor set — and then migrate one caller at a time, with a reproduction in hand.
- This decision is recorded so future architecture reviews do not re-propose the adapter.
