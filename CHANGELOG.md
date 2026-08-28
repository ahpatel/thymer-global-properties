# Changelog

## v1.9.1, 2026-08-28

Three small finds from the two-axis review (standards × spec), plus one it only pointed at.

- **The caret stays where you put it.** A fix typed mid-query used to be thrown to the end of the search box by the re-render it triggered. The position is remembered now and restored after every redraw, clamped to the query's length.
- **Dead plural branches cut.** Two ternaries whose both arms were identical ("1 more to choose from" and "did not save") are plain strings.
- **Stores are looked up by key, not by slot.** `_tplStore()` was `_stagedStores()[0]` — positional coupling with no reason to exist.
- **ADR-0001 gains one sentence**: the engine's `_init` stamp on pool items is scratch it built itself, not shared state — closing the review's only "mutates nothing" question.

## v1.9.0, 2026-08-28

An architecture pass: same behaviour, concentrated implementation. No user-visible change — every screen, key and write behaves exactly as 1.8.0 did.

- **One staged store, three configurations.** Templates, Fill keywords, and Inherited/Default rules each hand-rolled the same two-stage persistence (config authoritative, localStorage mirror, rev-merge, stage-then-flush). The mechanism is written once now; the three stores are configurations of it. The rules store no longer piggybacks on the template store's stage, and the Cancel/Save choreography has one owner.
- **One write plan.** "Which ticked lines get written?" was grouped independently by the Fill button and the detached autofill engine, with the eligibility rules re-derived at each new line kind. Both now consume one write plan with two named policies: `"picked"` (the dialog) and `"autofill"` (defaults only, blanks only, never replace, per-field opt-in).
- **A proposal engine with a seam.** The 315-line orchestrator that proposed, ticked, ordered and materialised the preview is now a deep module — target and `{cols, kw}` in, the fill payload out as a value — with the dialog and the detached engine as its only two consumers. The implicit context the two callers shared (and that only a flag distinguished) is gone. Follow-engine fixes now have exactly one home.
- **Recorded, not refactored:** the five per-type property-value switches are deliberately NOT unified — their accessor inventories differ (`records()` vs `linkedRecords()`), and unification would change live-API behaviour in the one region that has corrupted data before. See `docs/adr/0002`. The fill pipeline's seam, the Enter-in-title removal, and the single-file constraint are recorded in `docs/adr/0001` and `0003`; the domain vocabulary now lives in `CONTEXT.md`.

## v1.8.0, 2026-08-27

- **Removed: Enter in the title field.** It never fired, and it never could: Thymer's editor routes every keystroke through one hidden proxy textarea, so a keydown never carries the title field's identity — where the caret sits is state no plugin can see. Enter in the Fill dialog stays; that one is our own DOM and works. The keyboard path to a fill is therefore ⌘⇧G, glance, Enter.
- **Fixed: associations through the page's own values were gated on the wrong schema.** The follow engine skipped a field entirely unless the matched record's collection had a field pointing back — so with the org stored only on the person ("Employer" → Acme Co) and nothing on the company, a pre-filled Acme Co was never consulted and "John/Jim 1:1" proposed nobody. The guard is gone: the page's own values now anchor recommendations whichever way the association is stored, and the top recommendations for two common names are the John and Jim whose org is already on the page.

## v1.7.0, 2026-08-27

**Corrections, one motion.** Guesses are only as good as their correction, so the picker and the dialog now both put what will be written in reach.

- **The search leads.** Open a field's picker and the cursor is already in its search box, at the top. One query filters both groups at once: the matcher's proposals ("from the title", ticks and all) and the field's whole collection below ("all People", "all Companies", "all Options"). A ticked candidate stays visible whatever you type, so what Fill will write never leaves the page while you look for something better.
- **Filling, in one glance.** Under the title band, every ticked value now sits as a chip grouped by field, each with an × to take it back — including the changes made under "On this page", struck for a removal, old → new for a swap. The band updates as you tick, and the footer count and Fill button follow.

## v1.6.0, 2026-08-27

**Common names, resolved through what the title already matched.** "USDA meeting with Keith": the org comes in by abbreviation, and now the Keith who belongs to USDA comes ticked — however many Keiths the workspace holds.

- A title word that was too common to propose on its own ("Keith" is twenty people) no longer dies at the cap. When it survives inside the people of the record the title matched, it is the same two-signal line that was already ticked: the word, and the org.
- Associations now count whichever way they are stored. The engine read what the matched record points at through its own fields; it now also reads Thymer's back-references, so an Employer field living on the person — with nothing on the org at all — connects just the same. Property links only: a note that once named USDA is not a fact about who belongs to it.
- A record can never be proposed into a field on itself, which back-references made newly possible on collections that link their own records.

## v1.5.0, 2026-08-27

**Abbreviations, derived, not typed.** A title word like `EPA` now finds *Environmental Protection Agency*, `JLL` finds *Jones Lang LaSalle*, `DOE` finds *Department of Energy* — the initialism is computed from each record's own name, so there is nothing to maintain and no alias list to type.

- Both ways English shortens: `USA` drops the little words out of *United States of America*, and `DOE` keeps the "of" in *Department of Energy*, so both are indexed and a title word only has to agree with one.
- Words that are themselves acronyms take no part in the derivation, so *NASA Ames Research Center* shortens to `ARC` — which is in fact its abbreviation — and *AT&T Corporation* shortens to nothing worth keeping.
- A hit is as sure as a whole name, or it is a partial: an initialism only one record in the pool could mean comes ticked; one several records share comes unticked and says so, like any partial.
- A short list of business jargon — `CEO`, `KPI`, `OKR`, `EOD` and friends — never derives a match: the title means the meeting, not the person whose initials spell it.
- Nothing changes about aliases; they remain for the abbreviations no initials can derive.

## v1.4.0, 2026-08-27

Two keyboard answers to "why is the hand back on the mouse".

- **Enter applies in Fill From Title.** With the dialog open, Enter writes the ticked values, wherever the focus sits. Right after the shortcut chord the focus is still in the editor, so the whole trip is ⌘⇧G, glance, Enter. A popover open, or a button, link or input focused inside the dialog, keeps Enter for itself, so the pickers and searches work exactly as before.
- **Enter in the title field fills the page.** Title a page and press Enter, and every field the preview would tick fills itself: blanks only, nothing replaced, and only lines sure enough to be ticked on their own. It runs the moment you ask, not on creation, so a page that started empty and was typed into is no longer left to the command. The trigger is identified the only way it can be from outside: an input at the top of the panel whose text is the page title. A property input in the same spot holds a property value, and its text never matches the title, so it can never fire the fill.

Both rides reuse the same write the Fill button uses, with the autofill contract (never replace, verify after write), so a wrong guess can only ever add to an empty field, and a second Enter finds nothing left to do.

## v1.3.2, 2026-08-25

- **An archived property no longer blocks an add.** `active: false` is how Thymer removes a property from the UI while keeping its data, so a collection that has only an archived leftover does not have the property. Adding Action Status to Recipes was refused with "Skipped, already in Recipes: Action Status" because an archived "Deleted (Action Status)" still held the original's internal id. Neither the name nor the id of an archived field blocks an add now; where the id is the clash, the new property gets its own derived id so it cannot inherit the archived one's stored values, and the preview says so. A live property still blocks, on both name and id, and the reason now names it.
- The plugin description is one sentence again. The rest is in this file and in the README.

## v1.3.1, 2026-08-24

Fill From Title, after four days of "the ticked value was not saved" that turned out to be three different things.

- **A field the page does not show now says so.** A collection can carry property sets, and the active set decides what a page displays. Calendar's "Event" set lists only its nine Google fields, so a value written to Serves was stored, correct and invisible. Every line for such a field reads "not shown in Event".
- **Rows under "Fits several fields" are never pre-ticked.** The field is the question on those rows, so the row stays untouched until you answer it. Pre-picking also put two ticked lines on one single-value field, and the write kept only the last of them: that was the missing value.
- **A single-value field can never hold two ticked lines**, however they were ticked. Exclusivity used to be enforced only when you clicked, which left defaults free to collide.
- **A write is verified before it is called done.** A property write does not land synchronously, so the check waits for it, retries once if it is missing, and only then reports. The toast names any field that did not save instead of counting calls.
- **The other candidates for a field are visible without opening the picker**, on their own line: "1 more to choose from", which opens it.

## v1.3.0, 2026-08-23

**New: Fill From Title.** A sixth screen, its own palette command, and ⌘⇧G from anywhere. Run it on a page and it proposes values for that page's fields from its own title. Tick what is right and press Fill; nothing already in a field changes unless you tick it.

Four things become a proposal:

- **A record whose name is in the title**, matched against the collection that field links to. Punctuation and spacing do not have to agree, so `Konst&Kulturakademin` finds *Konst & Kulturakademin*, and accented names match at word boundaries the way ASCII ones do.
- **An option whose label is in the title**, whole or by one of its words when only one option could mean it.
- **What a matched record itself points at**: the company a matched person works at, the habitat a matched company sits in. Records already linked on the page count as matches too, so a person you linked by hand still brings their company.
- **A date written in the title**, through Thymer's own parser, Swedish translated first (`imorgon`, `nästa fredag`, `kl 14:00`). A date needs a day: a month or a year on its own is never one, so a page called "Chimney Yard Party 2026" keeps its own date.

**One row per field.** The chevron beside a value opens the other candidates, along with a search over the whole target collection for anything the matcher never proposed. Multi-value fields add and select several at once; a single-value field that already holds something says what ticking it would displace, in amber.

**Fits several fields** collects records that match a field which can link any record. There the record is certain and the field is the question, so the field is picked from the row.

**On this page**, behind a toggle, lists what the fields already hold: the place to correct a value an earlier fill got wrong. Pick a different one, or strike it.

Partial matches, a single word out of a longer name, are proposed unticked and say so, because "Elin" is three people.

**Keyword Aliases.** Per collection, per field, per value: words or phrases that select a value the record's own name would not match (`möte, samtal → Contact Log`, `KKA → Konst & Kulturakademin`). Comma separated, matched whole and in any case. An alias is your own rule, so a hit by alias comes ticked.

**Fill In Settings.** Autofill at creation lets chosen fields fill themselves on every new page created with a title already in place, while the field is blank and only where the match is sure enough to be ticked on its own. Pages created empty are left alone, and a title still being typed is never matched half written. Each ticked field says in words what it will put there. Fields that link any record are left out and say why. The shortcut is rebound here by pressing new keys.

Everything Fill From Title saves lives on the plugin's own configuration, so it syncs across devices with the templates and rules.

**Also in this release**

- Value pickers search a collection's whole record list. They previously searched only the 400 most recent, so a record outside that window could not be found; only the drawn rows are capped now.
- Popovers no longer flip above their trigger when they do not fit; they keep their place and scroll.
- Clicking outside an open popover closes it in every screen, and clicking another row's chevron switches to that row's popover in one click.

## v1.2.1 — 2026-08-17

- **Fixed: Default Values and Inherited Values were a dead end on a fresh install.** With no rules yet, the import screen replaced the real one whether or not there was anything to import, so a workspace that never had Auto-Init From Ancestor got a heading, one sentence and nothing else: no collection picker, no way to add one. Both screens were unreachable for every new user, which is what the first person to install 1.2.0 hit. The import is offered only when it has something to offer; otherwise the normal screen renders, with its own empty state. Reported by a user, and it was a real defect rather than a misunderstanding.
- **Fixed: the collection picker listed the wrong collections, and Add offered none of the right ones.** Both lists keyed on "has a rule set" rather than "has a rule of THIS mode". A collection that only inherits still holds an entry, so Default Values listed all of them with a useless 0 beside each (14 of 27 in one real workspace), while Add filtered them out for already having an entry, leaving no way to give an inheriting collection a default at all. Both lists are mode-aware now, the list carries its count as a title, and the screen opens on a collection that actually has a rule of that mode instead of the alphabetical first.
- **Fixed: adding a collection could wipe the other screen's rules.** Adding assigned a fresh empty entry over `collections[guid]`. Harmless while Add only ever offered collections with no entry; destructive the moment it correctly offered one holding the other mode's rules. It now only creates an entry that is absent.
- **Fixed: the record cost popover on the Change screen opened at the far left of the window**, outside the dialog. Popover placement took its trigger from the first button inside the anchor, and that cell's visible trigger is a plain span, so it measured the popover's own footer link at the viewport origin.
- With no collection carrying a rule yet, the picker opens straight into adding one rather than on an empty list.

## v1.2.0 — 2026-08-17

The interface rebuilt to Parham's design file (`Global Properties Redesign/`).

- **One modal, two jobs, named in the sidebar.** PROPERTIES decides which fields a collection has (Add Properties, Templates); NEW RECORDS decides what they fill themselves in with (Inherited Values, Default Values).
- **Add Properties is two steps.** Step 1 "What and Where" puts properties and templates on the left and target collections on the right, each with its own search, each target row showing what the apply would do to it. Step 2 "Order" places the new fields among the existing ones, per collection, by dragging.
- **Field order can now be changed**, which is the first thing this plugin does that is not purely additive. Built-in and archived fields keep their exact positions: they are anchored to the number of user fields that preceded them, because in this workspace they are interleaved, not grouped at the ends.
- **Templates are cards.** Add To and Edit; everything that mutates a template lives inside Edit, behind one deliberate step.
- **Fixed: Default Values could not be used at all.** "+ Set a Default" asked which field and then opened nothing, because the value popover had no row to anchor to. Picking a field now puts its row in the table and opens the value picker on it in one gesture.
- **Fixed: the Cancel and Save bar scrolled off the bottom** of a long rules table. The footer is now pinned outside the scrolling region on every screen.
- **Fixed: every screen was inset 24px too far**, from a padded wrapper under panels that already carry their own padding.
- Chevrons are drawn as SVG rather than set as the character U+2304, which cannot be optically centred against a label.
- Line heights are pinned to the design's own metrics, so the layout no longer depends on which font a workspace happens to use.
- **The Change flow.** Reached only from a drifted property's row in Add Properties, never the sidebar, so the direction is fixed by where you entered from. Amber throughout, a per-collection table of what each change does, a record cost counted from the real records, a confirm tick before the button is pressable, and a red band when Bidirectional Fields keeps a field paired. It conforms fields **in place**: the id and label are kept and only the behavioural keys are overwritten, because record values key on the id and a remove-and-re-add would orphan every one of them.
- Collection icons now appear everywhere a collection is listed — pickers, target rows, order tabs, excluded chips.
- **Fixed: accent buttons had white labels.** `--color-primary-text-100` is a primary-tinted TEXT colour, not a colour to put on top of the accent, and it resolves to near-white.
- **Fixed: checkbox outlines were nearly invisible.** The design's 20% veil does not carry on this panel; raised to 40%.
- **Fixed: a popover could be sliced off by the panel's bottom edge.** Popovers are now placed in fixed coordinates that escape both the panel's clip and the scrolling band, flipping above their trigger when there is no room below.
- **Fixed: Cancel left you in the dialog.** It now discards and closes.
- **The whole dialog reads larger.** One token, `--gp-zoom`, scales layout and type together, so every metric stays the design file's own number: 920px of design occupies 1058 real pixels.
- **Pickers follow the shared destination picker's contract**: `+` is an AND, ranking is prefix-first (exact 100, starts-with 45, word-start 25, substring 8) with ties broken by the shorter label, and an unfiltered list stays alphabetical rather than being ranked into length order. Record rows carry the icon of the collection they come from; date tokens get a calendar glyph; a choice keeps the collection's own option order, which is meaningful.
- Only `ti-` icon values are passed through as a class — Thymer also stores non-font "fill" icons that would render blank.
- The value picker is 320px, the same as every other picker.
- **Fixed: exclusion threw away fixed defaults.** Creating a record while standing in an excluded collection abandoned the whole apply, so an Action created from the Journal got no Action Status default even though a default does not come from an ancestor. Exclusion now governs **inheriting only**, in both directions, by dropping the ancestor rather than abandoning the record. The Excluded copy and its per-collection warning were rewritten to match, and that warning counts only inheriting rules.

- **Fixed: a picker's search lost focus after one character.** Every keystroke re-renders the panel and builds a new input; nothing put the caret back. All four pickers now keep focus and the caret position.
- **Keyboard in the pickers**, to the shared destination picker's contract: Up/Down move, Enter takes, focus never leaves the search box, unpickable rows are skipped. The active row is marked the same way hover marks one — one signal per state.
- **Record rows show each record's own icon.** They were all drawing the collection's icon; `getIcon()` gives the real one, and only a record that never had one set falls back.
- **Fixed: every record cost on the Change screen counted zero.** The counter called `rec.getProperty()`, which does not exist — records use `.prop()` — inside a `try/catch`, so it failed silently on every row.

- **One palette command per screen** — `Global Properties: Add Properties / Templates / Rearrange / Inherited Values / Default Values`. Two commands were right when the plugin had two screens; with five, the palette is how you navigate and three of them could not be reached from it at all. Every icon was probed against the running app first: Thymer ships a subset of tabler, and a class outside it renders as nothing rather than as a broken glyph.

- **Rearrange**, a third PROPERTIES panel: collections on the left, that collection's properties on the right, dragged to reorder. It adds and removes nothing — only the order — and writes through the same code path as Add step 2, so built-in and archived fields keep their exact positions. Save stays disabled until something has actually moved, counted by comparing against the live order rather than a flag.
- **Reordering runs on pointer events, not HTML5 drag-and-drop.** The native API never started a drag in the app: it wants `dataTransfer` set in `dragstart`, it interacts badly with a zoomed ancestor, and when it declines there is no error — the row simply does not move. Pointer events respect the panel's zoom and behave the same on a trackpad. A 4px threshold keeps a click from being read as a drag.

- **Popovers sit one step lighter than the panel**, the way Thymer's own menus sit above what they float over. Mapping them to the same token as the panel made them melt into the modal.

- **Fixed: saving a value rule said nothing.** Inherited Values and Default Values are the only screens whose Save leaves the dialog open, so the toast every other screen reports through could not do the job: it lands bottom-centre, in the panel's own surface colour, hard against the panel's bottom edge, and reads as a piece of the dialog rather than as a message. The footer note reads **✓ Saved** in the accent instead, and stays said until the next edit rather than fading.

- **The tick boxes read as Thymer's.** They carry the app's own `ti-check` from its tabler subset instead of the text glyph U+2713, they fill with the selection band rather than the brighter accent, and every box in the Inherited Values table is now one size. The design had sized the two deciding columns at 17 and Ignore Filter at 13, reading it as a qualifier rather than a peer; in the built table that just looked like a table whose boxes did not line up.

- **The three toggle columns explain themselves again.** Ancestor's Value, Link Ancestor and Ignore Filter carry the tooltips Auto-Init From Ancestor had, which the rebuild had dropped. They hang off the column headers rather than off each row's toggle, since that is where the question gets asked. The plugin draws its own tooltip rather than using the native `title` attribute, for the same reason the old one did: `title` is unreliable in Thymer's Electron shell. It is appended to the body, not into the panel, because a fixed child of a zoomed element reads its coordinates in the zoomed space. The headers say they have one by wearing the same dashed underline the hoverable record cost on the Change screen already wears, so "there is more behind this" has one mark in this plugin rather than two, and the mark sits on the words so it survives the headers shortening on a narrow panel.

- **Rearrange marks what you moved.** A moved property now carries the same tint and the same pill the Order step gives a new one, reading **MOVED** instead of NEW, so two screens drawing the same kind of list use the same mark. Which rows count as moved is derived, not flagged: one drag shifts every row between the old slot and the new one, so "its index changed" would light up half the list. The rows outside the longest common subsequence of the live and current orders are the moved ones, which for a single drag is exactly the row dragged, and dragging something back where it started clears its own mark.

- **Ticked collections stack at the top too.** The left column had lifted ticked properties into a SELECTED group since the redesign; the collections column beside it did not, so a target chosen out of sixty rows scrolled away while you were still picking what to put in it. Both columns group the same way now, and both derive the count from the rows on screen so the two cannot disagree.

- **The footer offers only the actions that exist.** With a clean table there is nothing to cancel and nothing to save, so Cancel is not drawn at all and the one button reads **Close**; the pair comes back the moment something is edited. Close deliberately does not take Cancel's discard path, which fixes a real defect: that path cleared the staged rules, and after a Save those *are* the saved state, so cancelling out of a screen you had just saved dropped the save from the config write and left only the localStorage mirror's newer rev to recover it.

- **Fixed: record values were listed alphabetically.** Every record-linked property, not just Action Status, sorted its options by label, which turned a status list into Done, Dropped, In Backlog, In Progress, an order nobody arranged. A value picker now lists records in the order **Thymer itself** lists that collection. Read out of the app's own bundle rather than guessed: `getRecordsInWorkspace()` ends in `sortByField(records, getDefaultRecordSortField(), getDefaultRecordSortDir())`, those two read `sidebar_record_sort_field_id` and `sidebar_record_sort_dir` off the collection's config and fall back to the title ascending, and the record-property picker then lists that array unsorted. Neither alphabetical nor the raw store order is it, and the field cannot be reduced to the timestamps: of 67 collections here, 65 say `updated_at desc`, GTD says `created_at asc`, Life Mngmt. sorts on the Collection field and Applications on a user field. A missing value sorts last in both directions, matching the host, which tests for null before it applies the direction. Verified against the native picker record for record on Action Status.

- **The focused row in a picker is now visible, and no longer impersonates the chosen one.** Keyboard focus and hover shared a 6% grey veil, so arrowing down a list gave almost no sense of where you were. All three states are borrowed from the host's own command palette now: nothing at rest, `--cmdpal-hover-bg-color` under the keyboard or the pointer, and `--cmdpal-selected-bg-color` on the value actually set. The teal was briefly given to the focused row as well, which made a freshly opened picker look like it had two values chosen at once, because the keyboard cursor starts on row one. `--cmdpal-hover-fg-color` is deliberately not used with the plate: it resolves to black in this theme, as `--cmdpal-current-bg/fg` both resolve to white, so only the palette's background tokens can be trusted.

## v1.0.1 — 2026-08-16

- **Fixed: identical properties listing more than once.** The grouping key was built by ignoring `id` and `icon` and keeping everything else, so a property still carrying leftover keys from a type it used to be was treated as different. Nine "Due Date" datetime properties grouped together while two more listed separately, because those two kept a `choices` array from when they were choice fields, with every option archived: dead data, invisible in the interface, and meaningless to a datetime property. The key is now an allowlist of what actually defines a property for its type, and archived choice options are ignored.
- When a group's members differ in ways the key ignores, the copied definition is now taken from the variant the most collections use, breaking ties toward the leanest one, so a copy no longer carries another collection's leftovers.

## v1.0.0 — 2026-08-15

First public release.

- **Add any property to any collection.** Search every property in the workspace by name and add the ones you want, no template involved. The full definition travels: type, multi-value, choice options with their colours, number format, icon, and which collection a linked-record property points at.
- **Templates.** Save a collection's properties as a named set and apply it elsewhere. Templates can be renamed, edited to drop properties they should stop carrying, and deleted without ever touching properties already added to collections.
- **One list for both.** Templates and individual properties are picked from the same screen, in any mix, and merge into one set deduplicated by property.
- **Multi-select on both sides.** Several templates and properties can go into several collections in one pass, with a per-collection tally of what each one will receive.
- **Purely additive.** An apply only appends. Every pre-existing property comes through byte-identical and in its original order, and every other collection setting is untouched. A property whose name the target already uses is skipped.
- **A preview that cannot drift.** The final step is rendered from the same function the apply runs, so what it shows is what happens. Anything there can be unticked to leave it out of that one apply without changing the template.
- **Duplicate definitions are grouped.** The same property built by hand in twenty collections lists once, labelled with the collections that have it. Properties sharing a name but differing in definition stay separate.
- **Formula, built-in and archived properties are never offered.** A `dynamic` property's formula lives in code rather than configuration, so copying one would produce an empty shell; archived properties (`active: false`) are filtered out.
- **Keyboard throughout.** Type to filter, Up and Down to move, Enter to take. Selected items rise to their own section at the top of the list.
- Templates sync through the plugin's configuration and are mirrored to `localStorage`.
