# Changelog

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
