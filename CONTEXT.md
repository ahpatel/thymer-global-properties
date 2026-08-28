# Domain model — Global Properties

A [Thymer](https://thymer.com) plugin that decides **which properties a collection has** and **what a new record starts with**. One modal, six screens. This file is the shared vocabulary for code and conversation; ADRs in `docs/adr/` record decisions that are not to be re-litigated.

## The workspace's nouns

- **Collection** — a Thymer collection; its whole property schema lives in one array on its plugin config (`config.fields`). Also: **Journal** (a collection plugin whose pages are dates), **managed collection** (a plugin owns its schema and can rewrite it — never touched here).
- **Record** — a page in a collection. Has a **title**, a `collection` system property, and values per field.
- **Field / property** — one entry in `config.fields`: type (`record`, `choice`, `datetime`, `number`, `text`, …), `many` (multi-value), and for record fields a `filter_colguid` naming the one collection it links to. A record field **without** `filter_colguid` links anywhere (**unscoped**).
- **Built-in fields** — title, created, modified, banner, collection, icon, parent page. Never offered, never copied.
- **Template** — a saved set of properties, applied to any collection in one step.
- **Property set** — a collection's named subset of fields; the default set decides what a page *shows*. A written value can be invisible because of this.

## New records

- **Inherited value** — a field a new record copies from the record it was created **inside** (the **ancestor**). The **ancestor's value** or a **link to the ancestor**; **ignore filter** links across collections; **excluded** collections inherit nothing (but keep defaults).
- **Default value** — a fixed starting value per field per collection. Defaults are unconditional; inheritance only suppresses inheritance.

## Fill From Title

- **Target** — the page in front of the user, `{ rec, guid, title, colGuid }`.
- **Proposal** — one candidate value for one field, carrying its **evidence**: a whole-name match, an **initialism** (derived abbreviation: `EPA` → Environmental Protection Agency), a **partial** (one word of a longer name — weak, unticked), a **keyword alias** (the user's own rule — strong, ticked), a **date written in the title**, or a **follow** (what a matched or anchored record itself points at, either direction).
- **Anchor** — a record already linked on the page (or matched by the title) whose own associations supply candidates for other fields. "USDA meeting with Keith": USDA is matched, the Keiths associated with USDA are the proposal.
- **Tick** — the line will be written. **Ticked on its own** (`defOn`) means the evidence was sure enough to pre-select it. Replaces never happen without a hand.
- **Fill** — write the ticked lines: the **write plan** groups them per field and `_writeFill` writes, settles, verifies, retries. Blanks-only and never-replace are the detached contract.
- **Proposal engine** (`_propose`) — the deep module: target + `{cols, kw}` in, the fill payload out as a value. See ADR-0001.
- **Write plan** (`_fillWritePlan`) — ticked lines in, one grouped write per field out. Two policies: `"picked"` (the dialog) and `"autofill"` (the detached engine).
- **Detached engine** — the fill pipeline run with no dialog, on a record created with a title already in place (autofill at creation). Honors the per-field opt-in (`kw.auto`); the dialog does not.
- **Keyword aliases** — per collection, per field, per value: words that select a value the record's own name would not match.
- **Fill shortcut** — ⌘⇧G (rebindable) opens Fill From Title. Enter inside the dialog applies the ticked values. Enter in the page title does *not* trigger anything (see ADR-0001's history note).

## Persistence

- **Staged store** — the one persistence mechanism: plugin config is authoritative and syncs; a per-workspace localStorage mirror carries a `rev`; loads prefer the strictly newer side; saves stage to the mirror immediately and flush all stores to config in one write when the dialog closes. Templates, keywords, and rules are three configurations of it.

## Deliberately not

- **Additive only** — applies to collections never edit or remove existing properties; order is the one exception, where the interface says so.
- **No formula properties, no built-ins, no managed collections** — see README "What it deliberately leaves alone".
- **Property values are not unified behind one adapter** — see ADR-0002.
- **Single file, no exports, no build step** — see ADR-0003.
