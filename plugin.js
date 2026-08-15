/*
 * Global Properties
 * -----------------
 * Reuse properties across collections. Add any property from anywhere in the
 * workspace to any other collection, or save a whole set of them as a template
 * and apply that instead of rebuilding each property by hand.
 *
 * Two commands, because there are only two things to do:
 *   Global Properties: Add Properties   pick any mix of templates and loose
 *                                       properties, choose targets, confirm
 *   Global Properties: New Template     save a collection's properties as a set
 * Managing templates (rename, drop properties, delete) hangs off the Add
 * Properties screen, since that is where you already are when you notice a
 * template needs fixing.
 *
 * A collection's whole property schema lives in one array on its plugin config
 * (`config.fields`). Each entry is self-contained: type, label, icon, the
 * multi-value flag, a choice property's options WITH their colours, a number
 * property's currency format, and `filter_colguid` (which collection a linked
 * record property points at). So "copy a property" is: lift that object out of
 * one collection's config and append it to another's.
 *
 * THE ONE RULE THIS PLUGIN IS BUILT AROUND: it is purely ADDITIVE. It never
 * rewrites, reorders or removes anything that is already in a target config. An
 * apply reads the target's live config, appends to `fields`, and writes back —
 * every other key, and every pre-existing field, comes through byte-identical.
 * If you find yourself adding a branch that edits an existing field, stop.
 *
 * What it deliberately does NOT do
 * --------------------------------
 * - **Formula properties.** A `dynamic` field's config carries no formula; the
 *   formula lives in the collection plugin's CODE (`this.properties.formula()`).
 *   Copying the field would produce an empty shell wearing the right name, which
 *   is worse than not offering it. They are filtered out at extraction.
 * - **Built-in properties.** Title / Created / Modified / Banner / Collection /
 *   Icon / Parent page are system fields every collection already has. Only
 *   user-defined properties are offered.
 * - **View wiring.** A copied property is added to the collection, not to any
 *   view's columns and not to `page_field_ids`. That is the user's call, and
 *   touching views would break the additive rule.
 * - **Collections whose plugin owns their schema** (`managed.fields`). Such a
 *   plugin can rewrite `fields` on load, so an apply there would appear to work
 *   and then quietly revert. The journal is NOT excluded: its properties are
 *   ordinary user properties, and people may well want them there.
 *
 * Cross-workspace is a non-issue: a global plugin's config is per workspace, so
 * a template physically cannot reach a workspace where its `filter_colguid`
 * values would dangle.
 *
 * No `export` keyword — this file is pushed straight into Thymer's plugin store.
 */
class Plugin extends AppPlugin {

	// ── What is not a user property ─────────────────────────────────────────
	// Built-in ids, from an audit of all 81 collections in the workspace.
	// An explicit list, NOT a shape heuristic: real user fields exist with ids
	// like "fVZQSNA31YKEAHJ" and "FRUNBAL1QKZ9XW" that match no generated
	// pattern, so any regex on the id shape silently drops legitimate
	// properties. If Thymer adds a system field later the worst case is that it
	// shows up in the picker, which is visible and harmless.
	static SYSTEM_FIELD_IDS = new Set([
		"title", "updated_at", "created_at", "banner",
		"collection", "icon", "parent_page",
	]);

	// Second net, by type: "banner" is the built-in banner field, "dynamic" is a
	// formula property whose logic does not live in the config at all.
	static SKIP_TYPES = new Set(["banner", "dynamic"]);

	// Where templates live. The plugin's own config is the authority (it syncs
	// across devices); localStorage is a mirror so a failed config write cannot
	// lose a template. Higher `rev` wins on load.
	//
	// The pt_ prefix predates the rename from "Property Templates" and is kept
	// deliberately: this key and `custom.property_templates` are where existing
	// templates already live, and renaming either would orphan them.
	static LS_PREFIX = "pt_templates_v1_";

	// Instance state as class fields: onUnload() can run on an instance whose
	// onLoad() never ran (the editor's validate/preview cycle), and a teardown
	// that touches undefined state sticks an error in the plugin editor that
	// blocks Save.
	_cmds = [];
	_style = null;
	_ovl = null;
	_state = null;
	_pending = null;

	onLoad() {
		this._injectStyle();
		this._cmds = [
			this.ui.addCommandPaletteCommand({
				label: "Global Properties: Add Properties",
				// ti-layout-grid-add is NOT in Thymer's bundled tabler subset,
				// so it rendered as no icon at all. Probe a candidate before
				// using it: set the class on a throwaway element and check that
				// ::before has real content.
				icon: "ti-library-plus",
				onSelected: () => this._open("apply"),
			}),
			this.ui.addCommandPaletteCommand({
				label: "Global Properties: New Template",
				icon: "ti-align-left",
				onSelected: () => this._open("new"),
			}),
		];
	}

	onUnload() {
		this._flushStore();
		this._closeModal();
		for (const c of this._cmds || []) { try { c.remove(); } catch (e) {} }
		this._cmds = [];
		if (this._style) { this._style.remove(); this._style = null; }
		// Sweep by the same selector the creation uses, in case an earlier
		// onUnload never ran and left an orphan overlay behind.
		for (const el of document.querySelectorAll(".gp-ovl")) el.remove();
	}

	// ══════════════════════════════════════════════════════════════════════
	// Store
	// ══════════════════════════════════════════════════════════════════════

	_lsKey() { return Plugin.LS_PREFIX + this.getWorkspaceGuid(); }

	/** Read the template store. Config is authoritative; localStorage wins only
	 *  when it is strictly newer (a config write that never landed). */
	_loadStore() {
		let fromCfg = null, fromLs = null;
		try {
			const cfg = this.getConfiguration();
			fromCfg = (cfg && cfg.custom && cfg.custom.property_templates) || null;
		} catch (e) {}
		try { fromLs = JSON.parse(localStorage.getItem(this._lsKey()) || "null"); } catch (e) {}
		const empty = { rev: 0, templates: [] };
		const a = fromCfg && Array.isArray(fromCfg.templates) ? fromCfg : empty;
		const b = fromLs && Array.isArray(fromLs.templates) ? fromLs : empty;
		const win = (b.rev || 0) > (a.rev || 0) ? b : a;
		return { rev: win.rev || 0, templates: (win.templates || []).slice() };
	}

	/* Saving the store has to happen in TWO stages, because saveConfiguration()
	 * reloads the plugin and a reload tears down whatever dialog is open. That
	 * used to mean every save threw you back into Thymer mid-task.
	 *
	 *   _stageStore  writes localStorage immediately and remembers the change
	 *   _flushStore  writes the plugin config, and is called when the dialog
	 *                closes, so the reload lands on an empty screen
	 *
	 * Nothing is at risk in between: localStorage carries the newer `rev`, and
	 * _loadStore prefers whichever side is newer, so an app that dies before
	 * the flush still comes back with the change. */
	_stageStore(next) {
		next.rev = Date.now();
		this._pending = next;
		try { localStorage.setItem(this._lsKey(), JSON.stringify(next)); } catch (e) {}
		return next;
	}

	async _flushStore() {
		const next = this._pending;
		if (!next) return false;
		this._pending = null;
		const mine = (await this.data.getAllGlobalPlugins() || [])
			.find((p) => p.getGuid() === this.getGuid());
		if (!mine) return false;
		const cfg = JSON.parse(JSON.stringify(this.getConfiguration()));
		// The config key stays `property_templates` even though the plugin is
		// now called Global Properties: renaming it would orphan every template
		// already saved. Same reason the localStorage key keeps its pt_ prefix.
		cfg.custom = Object.assign({}, cfg.custom || {}, { property_templates: next });
		return await mine.saveConfiguration(cfg);
	}

	// ══════════════════════════════════════════════════════════════════════
	// Collections and fields
	// ══════════════════════════════════════════════════════════════════════

	/** Every collection, with the journal flagged so it can be LABELLED (not
	 *  filtered) in the pickers. Note we do NOT filter on
	 *  sidebar_display_mode: hiding a collection from the sidebar is a display
	 *  preference, not a marker of an internal collection. Filtering on it once
	 *  hid 50 of 65 collections in another plugin. */
	async _collections() {
		const cols = await this.data.getAllCollections() || [];
		return cols.map((c) => {
			let journal = false, managed = false, name = "";
			try { journal = !!c.isJournalPlugin(); } catch (e) {}
			try { managed = !!((c.getConfiguration() || {}).managed || {}).fields; } catch (e) {}
			try { name = c.getName() || ""; } catch (e) {}
			return { api: c, guid: c.getGuid(), name, journal, managed };
		}).sort((a, b) => a.name.localeCompare(b.name));
	}

	/** Valid targets. The journal is deliberately NOT excluded: its properties
	 *  are ordinary user properties and people may well want them there.
	 *  The one exclusion is a collection whose own plugin code owns its schema
	 *  — a managed collection can rewrite `fields` on load and silently revert
	 *  what we add, so an apply there would look like it worked and then quietly
	 *  undo itself. Nothing in this workspace is managed today; the guard costs
	 *  one line and covers the day one is. */
	_isTarget(c) { return !c.managed; }

	/** The user-defined, live, templatable properties of a config.
	 *  `active: false` is how Thymer archives a property: deleted from the UI
	 *  but kept so its data survives. Those must never be offered. Parham's
	 *  convention of renaming them "Deleted (X)" is a habit, not a rule, so the
	 *  flag is what we filter on. */
	_userFields(cfg) {
		return ((cfg && cfg.fields) || []).filter((f) =>
			f && f.id &&
			f.active !== false &&
			!Plugin.SYSTEM_FIELD_IDS.has(f.id) &&
			!Plugin.SKIP_TYPES.has(f.type));
	}

	/** What a template application would do to a target, without doing it.
	 *  This is also exactly what the preview screen renders, so what you are
	 *  shown and what runs cannot drift apart. */
	_plan(tpl, cfg) {
		const haveNames = new Set(((cfg && cfg.fields) || []).map((f) => this._norm(f.label)));
		const haveIds = new Set(((cfg && cfg.fields) || []).map((f) => f.id));
		const add = [], skip = [];
		for (const f of tpl.fields || []) {
			if (haveNames.has(this._norm(f.label))) {
				skip.push({ field: f, why: "a property with this name already exists" });
				continue;
			}
			// Second guard, and the one that protects DATA: a field id is what
			// record values are keyed on. Landing a template field on an id the
			// target already uses would make the new property inherit whatever
			// the old one stored. Different name, same id, so the name check
			// above cannot catch it.
			if (haveIds.has(f.id)) {
				skip.push({ field: f, why: "its internal id is already used by another property" });
				continue;
			}
			add.push(f);
			haveNames.add(this._norm(f.label));
			haveIds.add(f.id);
		}
		return { add, skip };
	}

	/** Apply a template to one collection. Reads the target's config FRESH,
	 *  immediately before writing — never a copy held across a user
	 *  interaction, or we would write back a stale view of the collection and
	 *  undo whatever changed in between.
	 *
	 *  `exclude` is a set of field ids the user unticked on the preview screen:
	 *  a per-apply choice about what to leave out THIS time. It deliberately
	 *  does not touch the template, which stays whole for the next collection. */
	async _apply(tpl, col, exclude) {
		const live = col.api.getConfiguration();
		const plan = this._plan(tpl, live);
		const add = plan.add.filter((f) => !(exclude && exclude.has(f.id)));
		if (!add.length) return { ok: true, added: [], skipped: plan.skip };
		const next = JSON.parse(JSON.stringify(live));   // deep copy: never mutate the live object
		next.fields = live.fields.concat(JSON.parse(JSON.stringify(add)));
		const ok = await col.api.saveConfiguration(next);
		return { ok: !!ok, added: add, skipped: plan.skip };
	}

	// ══════════════════════════════════════════════════════════════════════
	// Small helpers
	// ══════════════════════════════════════════════════════════════════════

	_norm(s) { return String(s == null ? "" : s).trim().toLowerCase(); }

	_esc(s) { return this.ui.htmlEscape(String(s == null ? "" : s)); }

	/** Ranking copied from the shared destination picker so every picker in
	 *  these plugins ranks the same way, prefix-first like Thymer's own.
	 *  Do not retune: when a match seems missing it is a render cap, not this. */
	_score(name, q) {
		const n = this._norm(name), needle = this._norm(q);
		if (!needle) return 1;
		if (n === needle) return 100;
		if (n.startsWith(needle)) return 45;
		if (n.split(/\s+/).some((w) => w.startsWith(needle))) return 25;
		if (n.includes(needle)) return 8;
		return 0;
	}

	/** A one-line human summary of a field, so the pickers show what a property
	 *  actually IS rather than just its name. */
	_fieldDetail(f, colNames) {
		const bits = [f.type];
		if (f.many) bits.push("multiple");
		if (f.type === "choice" && (f.choices || []).length) {
			bits.push((f.choices || []).filter((c) => c.active !== false).length + " options");
		}
		// A record property names the collection it links to. An unresolvable
		// guid means that collection was DELETED, not that a workspace boundary
		// was crossed: templates live on a per-workspace plugin config and
		// cannot travel. Such a property is already broken in its SOURCE
		// collection, so this is reporting a pre-existing fault, not one the
		// copy introduces.
		if (f.type === "record" && f.filter_colguid) {
			bits.push("→ " + (colNames[f.filter_colguid] || "deleted collection"));
		}
		if (f.type === "number" && f.number_format && f.number_format !== "formatted") {
			bits.push(f.number_format);
		}
		if (f.read_only) bits.push("read-only");
		return bits.join(" · ");
	}

	// ══════════════════════════════════════════════════════════════════════
	// Modal shell
	// ══════════════════════════════════════════════════════════════════════

	async _open(screen) {
		this._closeModal();
		const cols = await this._collections();
		const colNames = {};
		for (const c of cols) colNames[c.guid] = c.name;
		// `tplIds` and `targetGuids` are sets because both steps of the apply
		// flow are multi-select: several templates can go into several
		// collections in one pass. `exclude` is the per-apply ogp-out, keyed on
		// field id, and applies across every chosen target.
		this._state = { screen, cols, colNames, store: this._loadStore(),
			src: null, picked: new Set(), name: "", propKeys: new Set(),
			tplIds: new Set(), targetGuids: new Set(), exclude: new Set(),
			editId: null, editName: "", editKeep: new Set(),
			step: 0, tq: "", tActive: 0, busy: false };

		const ovl = document.createElement("div");
		ovl.className = "gp-ovl";
		ovl.innerHTML = '<div class="gp-panel" role="dialog" aria-modal="true"></div>';
		ovl.addEventListener("pointerdown", (e) => { if (e.target === ovl) this._closeModal(); });
		// THE SPACE BAR GUARD. Thymer has a keydown handler on an ancestor, in
		// the BUBBLE phase, that calls preventDefault() on Space without asking
		// whether the target is a text field. Typing a space into any input of
		// ours therefore did nothing while the editor underneath reacted. Both
		// capture phases and the input itself see the event un-prevented; by the
		// time it reaches window it is prevented, which is how the culprit was
		// located. Stopping it here, one node above the inputs and below
		// whatever ancestor is listening, keeps every field in this dialog
		// typable. Escape still works: that handler is on window in the CAPTURE
		// phase, so it runs before this one.
		ovl.addEventListener("keydown", (e) => {
			if (e.target && e.target.tagName === "INPUT") e.stopPropagation();
		}, false);
		document.body.appendChild(ovl);
		this._ovl = ovl;

		// Capture phase, because Thymer swallows Escape inside the editor. That
		// also means this runs BEFORE any handler on an element inside the
		// dialog, so stopPropagation() in a child cannot protect that child:
		// anything with its own Escape meaning has to be handled right here.
		this._onKey = (e) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			this._closeModal();
		};
		window.addEventListener("keydown", this._onKey, true);

		this._render();
	}

	_closeModal() {
		// Any staged template change is written now, on the way out, so the
		// plugin reload it triggers cannot interrupt anything.
		this._flushStore();
		if (this._onKey) { window.removeEventListener("keydown", this._onKey, true); this._onKey = null; }
		if (this._ovl) { this._ovl.remove(); this._ovl = null; }
		this._state = null;
		// Hand keyboard focus back to the editor WITHOUT moving the caret. A
		// dialog that stole focus and merely removes itself leaves the editor
		// dead to typing.
		try { window.g_virtual_input.$textarea.focus(); } catch (e) {}
	}

	_panel() { return this._ovl ? this._ovl.querySelector(".gp-panel") : null; }

	_render() {
		const p = this._panel(), s = this._state;
		if (!p || !s) return;
		const screens = { new: "_renderNew", apply: "_renderApply", manage: "_renderManage", edit: "_renderEdit" };
		p.innerHTML = "";
		p.appendChild(this._header());
		this[screens[s.screen] || "_renderManage"](p);
	}

	_header() {
		const s = this._state;
		const titles = { new: "New Template", apply: "Add Properties",
			manage: "Templates", edit: "Edit Template" };
		const h = document.createElement("div");
		h.className = "gp-head";
		const ver = (this.getConfiguration() || {}).version;
		h.innerHTML = '<h1>' + this._esc(titles[s.screen] || "Property Templates") +
			(ver ? '<span class="gp-ver">' + this._esc(ver) + '</span>' : '') + '</h1>';
		return h;
	}

	/** A row of tabs is overkill for three screens; a quiet footer link back to
	 *  the list is enough, and it keeps each screen single-purpose. */
	/* The footer holds one control at each end: back on the left, the forward
	 * or secondary action on the right. Two links crowded together on the left
	 * read as one sentence, which is what they were doing before. When there is
	 * a primary button it takes the right end; otherwise a link can. */
	_footer(parent, leftHtml, rightLabel, rightFn, rightEnabled, rightHtml) {
		const f = document.createElement("div");
		f.className = "gp-foot";
		const left = document.createElement("div");
		left.className = "gp-foot-left";
		left.innerHTML = leftHtml || "";
		f.appendChild(left);
		if (!rightLabel && rightHtml) {
			const r = document.createElement("div");
			r.className = "gp-foot-right";
			r.innerHTML = rightHtml;
			f.appendChild(r);
		}
		if (rightLabel) {
			const b = document.createElement("button");
			b.className = "gp-done";
			b.textContent = rightLabel;
			b.disabled = rightEnabled === false;
			b.addEventListener("click", rightFn);
			f.appendChild(b);
		}
		parent.appendChild(f);
		return f;
	}

	/* A footer link takes a leading MARK, a literal character, not a tabler
	 * class. Two bare text links side by side read as one sentence ("Add
	 * Properties Templates"); a mark in front of each, plus the two sitting at
	 * opposite ends of the footer, makes them read as two controls.
	 * "+" marks anything that ADDS, and only that: Add Properties and New
	 * Template both do. Back links carry a chevron, sideways navigation
	 * carries nothing.
	 *
	 * Not an icon font: a bare `ti-arrow-left` carries the glyph codepoint but
	 * NOT `font-family: tabler-icons`, which lives on the base `ti` class, so it
	 * renders as a tofu box. Thymer's own markup is
	 * <span class="ti ti-chevron-down">. A literal character has no such trap. */
	_backLink(label, screen, mark) {
		return '<button class="gp-link" data-goto="' + screen + '">' +
			(mark ? '<span class="gp-link-mark">' + this._esc(mark) + '</span>' : '') +
			'<span>' + this._esc(label) + '</span></button>';
	}

	/** A step back INSIDE the apply flow, which keeps what you already picked.
	 *  Distinct from _backLink, which leaves the flow and resets it. */
	_stepLink(label, step, mark) {
		return '<button class="gp-link" data-step="' + step + '">' +
			(mark ? '<span class="gp-link-mark">' + this._esc(mark) + '</span>' : '') +
			'<span>' + this._esc(label) + '</span></button>';
	}

	/** Wire every [data-goto] and [data-step] inside the panel in one place. */
	_wireGoto() {
		const p = this._panel(), s = this._state;
		if (!p || !s) return;
		for (const b of p.querySelectorAll("[data-goto]")) {
			b.addEventListener("click", () => {
				s.screen = b.getAttribute("data-goto");
				s.src = null; s.picked = new Set();
				s.tplIds = new Set(); s.targetGuids = new Set(); s.exclude = new Set();
				s.editId = null; s.editName = ""; s.editKeep = new Set();
				s.propKeys = new Set();
				s.step = 0; s.tq = "";
				this._render();
			});
		}
		for (const b of p.querySelectorAll("[data-step]")) {
			b.addEventListener("click", () => {
				s.step = parseInt(b.getAttribute("data-step"), 10) || 0;
				// Stepping back out of the preview drops the per-apply ogp-outs:
				// they were decided against a target list that is now in play
				// again, so keeping them would silently carry a stale decision.
				if (s.step < 2) s.exclude = new Set();
				this._render();
			});
		}
	}

	/** A searchable list with keyboard navigation.
	 *  `items` are {title, sub, dim, disabled, checked, onPick, onToggle}.
	 *
	 *  Typing filters. Up/Down move the active row, Enter takes it: a pick in a
	 *  single-select list, a tick in a multi-select one. Focus never leaves the
	 *  search box, so you can keep narrowing without reaching for the mouse.
	 *  Disabled rows are skipped rather than landed on and refused. */
	_list(parent, items, opts) {
		opts = opts || {};
		const wrap = document.createElement("div");
		wrap.className = "gp-listwrap";
		let q = "", active = 0, current = [];
		const rankOf = (it) => (typeof it.rank === "function" ? it.rank() : (it.rank || 0));

		const input = document.createElement("input");
		input.className = "gp-search";
		input.type = "text";
		input.placeholder = opts.placeholder || "Search…";
		const list = document.createElement("div");
		list.className = "gp-list";

		const paint = () => {
			current.forEach((r, i) => r.el.classList.toggle("is-active", i === active));
			const row = current[active];
			if (row && row.el.scrollIntoView) row.el.scrollIntoView({ block: "nearest" });
		};
		/** Move to the next selectable row in `dir`, skipping disabled ones. */
		const move = (dir) => {
			if (!current.length) return;
			let i = active;
			for (let n = 0; n < current.length; n++) {
				i += dir;
				if (i < 0 || i >= current.length) return;   // stop at the ends, do not wrap
				if (!current[i].it.disabled) { active = i; paint(); return; }
			}
		};
		const firstSelectable = () => {
			active = current.findIndex((r) => !r.it.disabled);
			if (active < 0) active = 0;
		};
		const choose = () => {
			const row = current[active];
			if (!row || row.it.disabled) return;
			if (opts.multi) {
				const cb = row.el.querySelector("input");
				cb.checked = !cb.checked;
				cb.dispatchEvent(new Event("change", { bubbles: true }));
			} else {
				row.it.onPick();
			}
		};

		const draw = () => {
			const rows = items
				.map((it) => ({ it, sc: this._score(it.title + " " + (it.sub || ""), q) }))
				.filter((r) => r.sc > 0)
				// Rank first, so a mixed list keeps its sections in order and
				// only ranks WITHIN a section. Without this a well-matching
				// property would jump above the templates and the two kinds
				// would interleave differently on every keystroke.
				.sort((a, b) => rankOf(a.it) - rankOf(b.it) ||
					b.sc - a.sc || a.it.title.localeCompare(b.it.title));
			// Keep the keyboard on the SAME item across a redraw. Ticking a row
			// moves it into the Selected section, and without this the active
			// index would still point at the old slot, so the next Enter would
			// hit whatever slid into place.
			const prev = current[active] && current[active].it;
			list.innerHTML = "";
			current = [];
			let lastRank = null;
			if (!rows.length) {
				list.innerHTML = '<div class="gp-empty">' + this._esc(opts.empty || "Nothing matches.") + '</div>';
				return;
			}
			for (const { it } of rows) {
				if (opts.sections && rankOf(it) !== lastRank) {
					lastRank = rankOf(it);
					const label = opts.sections[lastRank];
					if (label) list.appendChild(this.ui.$html(
						'<div class="gp-sec">' + this._esc(label) + '</div>'));
				}
				const body = '<span class="gp-row-main"><span class="gp-row-title">' +
					this._esc(it.title) + '</span>' +
					(it.sub ? '<span class="gp-row-sub">' + this._esc(it.sub) + '</span>' : '') +
					'</span>' + (it.dim ? '<span class="gp-row-dim">' + this._esc(it.dim) + '</span>' : '');
				// Multi-select rows are labels around a checkbox; single-select
				// rows stay buttons. Same body either way, so the two modes look
				// identical apart from the tickbox.
				let el;
				if (opts.multi) {
					el = document.createElement("label");
					el.className = "gp-row is-multi" + (it.disabled ? " is-disabled" : "");
					const cb = document.createElement("input");
					cb.type = "checkbox";
					// `checked` is a FUNCTION, read at draw time. As a plain
					// value it was captured when the list was built, so ticking
					// a row and then typing in the search redrew it unticked
					// while the selection was still held in state: the count in
					// the button and the boxes on screen disagreed.
					cb.checked = typeof it.checked === "function" ? !!it.checked() : !!it.checked;
					cb.disabled = !!it.disabled;
					cb.addEventListener("change", () => it.onToggle(cb.checked));
					el.appendChild(cb);
					el.appendChild(this.ui.$html(body));
				} else {
					el = document.createElement("button");
					el.className = "gp-row" + (it.disabled ? " is-disabled" : "");
					el.disabled = !!it.disabled;
					el.innerHTML = body;
					if (!it.disabled) el.addEventListener("click", () => it.onPick());
				}
				// Hovering moves the active row, so the keyboard and the mouse
				// never disagree about which row Enter would take.
				if (!it.disabled) el.addEventListener("mousemove", () => {
					const i = current.findIndex((r) => r.el === el);
					if (i > -1 && i !== active) { active = i; paint(); }
				});
				current.push({ it, el });
				list.appendChild(el);
			}
			const back = prev ? current.findIndex((r) => r.it === prev) : -1;
			if (back > -1) active = back; else firstSelectable();
			paint();
		};

		input.addEventListener("input", () => { q = input.value; draw(); });
		input.addEventListener("keydown", (e) => {
			if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
			else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
			else if (e.key === "Enter") { e.preventDefault(); choose(); }
		});
		if (opts.search !== false) wrap.appendChild(input);
		wrap.appendChild(list);
		parent.appendChild(wrap);
		wrap._gpDraw = draw;          // so a toggle can re-sort the list
		draw();
		if (opts.search !== false) setTimeout(() => input.focus(), 0);
		return wrap;
	}


	/** Re-sort and repaint the open list, keeping focus and the caret where
	 *  they are. Used when a tick has to move a row into another section. */
	_redrawList() {
		const p = this._panel();
		const wrap = p && p.querySelector(".gp-listwrap");
		if (wrap && wrap._gpDraw) wrap._gpDraw();
	}

	/** A ticked list of properties, shared by "New Template" and "Edit
	 *  template". `keep` is the live Set the caller reads back; ticking mutates
	 *  it in place, and the footer button is re-enabled from its size, so a
	 *  template can never be saved empty. */
	_fieldChecklist(parent, fields, keep, onChange) {
		const s = this._state;
		const box = document.createElement("div");
		box.className = "gp-box";

		const all = document.createElement("button");
		all.className = "gp-link gp-selall";
		const syncAll = () => {
			all.textContent = keep.size === fields.length ? "Clear All" : "Select All";
		};
		all.addEventListener("click", () => {
			if (keep.size === fields.length) keep.clear();
			else for (const f of fields) keep.add(f.id);
			this._render();
		});
		box.appendChild(all);
		syncAll();

		for (const f of fields) {
			const row = document.createElement("label");
			row.className = "gp-check";
			const cb = document.createElement("input");
			cb.type = "checkbox";
			cb.checked = keep.has(f.id);
			cb.addEventListener("change", () => {
				if (cb.checked) keep.add(f.id); else keep.delete(f.id);
				row.classList.toggle("is-off", !cb.checked);
				syncAll();
				const b = this._panel().querySelector(".gp-done");
				if (b) b.disabled = !keep.size;
				if (onChange) onChange();
			});
			row.appendChild(cb);
			if (!keep.has(f.id)) row.classList.add("is-off");
			row.appendChild(this.ui.$html(
				'<span class="gp-row-main"><span class="gp-row-title">' + this._esc(f.label) + '</span>' +
				'<span class="gp-row-sub">' + this._esc(this._fieldDetail(f, s.colNames)) + '</span></span>'));
			box.appendChild(row);
		}
		parent.appendChild(box);
		return box;
	}

	/** A labelled text field. */
	_nameField(parent, label, value, onInput) {
		const wrap = document.createElement("div");
		wrap.className = "gp-field";
		wrap.innerHTML = '<div class="gp-label">' + this._esc(label) + '</div>';
		const inp = document.createElement("input");
		inp.className = "gp-input";
		inp.type = "text";
		inp.value = value;
		inp.addEventListener("input", () => onInput(inp.value));
		inp.addEventListener("keydown", (e) => e.stopPropagation());
		wrap.appendChild(inp);
		parent.appendChild(wrap);
		return inp;
	}

	// ══════════════════════════════════════════════════════════════════════
	// Screen: edit template
	// ══════════════════════════════════════════════════════════════════════

	/* The pen edits the WHOLE template: its name and which properties it
	 * carries. Dropping one here removes it from the template for good, which
	 * is the difference between this screen and the untick on the apply
	 * preview — that one only skips a property for a single apply. */
	_renderEdit(p) {
		const s = this._state;
		const t = s.store.templates.find((x) => x.id === s.editId);
		if (!t) { s.screen = "manage"; return this._renderManage(p); }

		const note = document.createElement("div");
		note.className = "gp-note";
		note.textContent = "Rename the template, and untick any property it should stop carrying. " +
			"Properties already added to collections are not affected.";
		p.appendChild(note);

		this._nameField(p, "Template Name", s.editName, (v) => { s.editName = v; });
		// The warning is live: ticking does not re-render the screen, so it has
		// to be refreshed from the toggle itself or it reports a stale count.
		this._fieldChecklist(p, t.fields, s.editKeep, () => this._syncEditWarn(t));

		const warn = document.createElement("div");
		warn.className = "gp-note gp-fine gp-editwarn";
		p.appendChild(warn);
		this._syncEditWarn(t);

		this._footer(p, this._backLink("Templates", "manage", "‹"),
			"Save Changes", () => this._doSaveEdit(t), !!s.editKeep.size);
		this._wireGoto();
	}

	_syncEditWarn(t) {
		const s = this._state, p = this._panel();
		if (!s || !p) return;
		const el = p.querySelector(".gp-editwarn");
		if (!el) return;
		const removed = t.fields.length - s.editKeep.size;
		el.textContent = removed
			? removed + " " + (removed === 1 ? "property" : "properties") + " will be dropped from this template."
			: "";
	}

	_doSaveEdit(t) {
		const s = this._state;
		if (!s || s.busy || !s.editKeep.size) return;
		s.busy = true;
		const name = (s.editName || "").trim() || t.name;
		const keep = new Set(s.editKeep);
		const store = this._loadStore();
		const row = store.templates.find((x) => x.id === t.id);
		if (!row) { this._closeModal(); return; }
		const before = row.fields.length;
		row.name = name;
		row.fields = row.fields.filter((f) => keep.has(f.id));
		const dropped = before - row.fields.length;
		s.store = this._stageStore(store);
		s.busy = false;
		s.screen = "manage";
		s.editId = null; s.editName = ""; s.editKeep = new Set();
		this._render();
		this._toast(dropped
			? "Saved “" + name + "”, " + dropped + " " + (dropped === 1 ? "property" : "properties") + " dropped."
			: "Saved “" + name + "”.");
	}

	// ══════════════════════════════════════════════════════════════════════
	// Screen: new template
	// ══════════════════════════════════════════════════════════════════════

	_renderNew(p) {
		const s = this._state;
		if (!s.src) {
			const note = document.createElement("div");
			note.className = "gp-note";
			note.textContent = "Pick the collection whose properties you want to save.";
			p.appendChild(note);
			this._list(p, s.cols.map((c) => ({
				title: c.name,
				sub: this._userFields(c.api.getConfiguration()).length + " properties",
				dim: c.journal ? "journal" : "",
				onPick: () => {
					s.src = c;
					s.picked = new Set(this._userFields(c.api.getConfiguration()).map((f) => f.id));
					s.name = c.name + " properties";
					this._render();
				},
			})), { placeholder: "Search collections…" });
			this._footer(p, this._backLink("Add Properties", "apply", "+"),
				null, null, null, this._backLink("Templates", "manage", ""));
			this._wireGoto();
			return;
		}

		const fields = this._userFields(s.src.api.getConfiguration());
		const note = document.createElement("div");
		note.className = "gp-note";
		note.textContent = fields.length
			? "Choose what goes in the template."
			: "This collection has no user-defined properties to save.";
		p.appendChild(note);

		if (fields.length) {
			this._fieldChecklist(p, fields, s.picked);

			const nameWrap = document.createElement("div");
			nameWrap.className = "gp-field";
			nameWrap.innerHTML = '<div class="gp-label">Template Name</div>';
			const inp = document.createElement("input");
			inp.className = "gp-input";
			inp.type = "text";
			inp.value = s.name;
			inp.addEventListener("input", () => { s.name = inp.value; });
			nameWrap.appendChild(inp);
			p.appendChild(nameWrap);
		}

		this._footer(p,
			this._backLink("Back", "new", "‹"),
			"Save Template",
			() => this._doSave(),
			!!s.picked.size);
		this._wireGoto();
	}

	_doSave() {
		const s = this._state;
		if (!s || s.busy || !s.picked.size) return;
		s.busy = true;
		const fields = this._userFields(s.src.api.getConfiguration())
			.filter((f) => s.picked.has(f.id));
		const store = this._loadStore();
		store.templates.push({
			id: "T" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase(),
			name: (s.name || "").trim() || (s.src.name + " properties"),
			srcGuid: s.src.guid,
			srcName: s.src.name,
			at: new Date().toISOString(),
			fields: JSON.parse(JSON.stringify(fields)),
		});
		const n = fields.length;
		const label = (s.name || "").trim() || (s.src.name + " properties");
		// Stage, do not flush: the write lands when the dialog is closed, so
		// saving leaves you in the plugin instead of back in Thymer. Land on
		// the template list, where the new template is now visible.
		s.store = this._stageStore(store);
		s.busy = false;
		s.screen = "manage";
		s.src = null;
		s.picked = new Set();
		this._render();
		this._toast("Saved “" + label + "” with " + n + " " + (n === 1 ? "property" : "properties") + ".");
	}

	// ══════════════════════════════════════════════════════════════════════
	// Screen: apply
	// ══════════════════════════════════════════════════════════════════════

	/* The apply flow is three steps, and BOTH pick-steps are multi-select:
	 * several templates can go into several collections in one pass.
	 *   step 0 - which templates
	 *   step 1 - which collections
	 *   step 2 - preview and confirm
	 * Step 2 always shows the union of the chosen templates' properties, and a
	 * per-collection line underneath, so "what happens where" is on screen
	 * before anything is written. */
	_renderApply(p) {
		const s = this._state;
		if (s.step === 0) return this._pickSources(p);
		if (s.step === 1) return this._applyPickTargets(p);
		return this._applyPreview(p);
	}

	/** Every user-defined property in the workspace, one row each, tagged with
	 *  the collection it lives in. The same property name in six collections is
	 *  six rows on purpose: they are genuinely different definitions, and which
	 *  one you copy decides the type, the options and the link target. */
	_allProperties() {
		const s = this._state, out = [];
		for (const c of s.cols) {
			let fields = [];
			try { fields = this._userFields(c.api.getConfiguration()); } catch (e) { continue; }
			for (const f of fields) out.push({ key: c.guid + ":" + f.id, col: c, field: f });
		}
		return out.sort((a, b) =>
			a.field.label.localeCompare(b.field.label) || a.col.name.localeCompare(b.col.name));
	}

	/** A property's definition with the id stripped out, as a stable string.
	 *  Field ids are per collection, so the same property built by hand in
	 *  twenty collections has twenty ids and would list twenty times. The id is
	 *  also the one part that does NOT matter when copying: the target gets a
	 *  definition, and the id only decides collision detection. Everything else
	 *  (type, icon, many, choices, link target, format) is what makes two
	 *  properties the same or different, so that is the signature. */
	/** Ignores `id` and `icon`. The id is per collection and decides only
	 *  collision detection. The icon is decoration: two Timeblock properties
	 *  identical in type, link target and multi-value differed only by icon
	 *  (ti-align-left vs ti-notes) and listed twice, which is not a distinction
	 *  worth making the user resolve. Everything functional (type, many,
	 *  choices, link target, format, read_only) stays in the signature. */
	_propSignature(f) {
		const o = {};
		for (const k of Object.keys(f).sort()) {
			if (k === "id" || k === "icon") continue;
			o[k] = f[k];
		}
		return JSON.stringify(o);
	}

	/** One row per distinct property DEFINITION, with the collections that have
	 *  it. Measured on this workspace: 360 raw properties collapse to 178, and
	 *  "Action Status" goes from 21 identical rows to one. Two properties with
	 *  the same name but different definitions stay separate rows, and the
	 *  collection list is what tells them apart. */
	_propertyGroups() {
		const bySig = new Map();
		for (const r of this._allProperties()) {
			const sig = this._propSignature(r.field);
			if (!bySig.has(sig)) bySig.set(sig, { key: sig, cols: [], variants: new Map() });
			const g = bySig.get(sig);
			g.cols.push(r.col.name);
			// Members of a group can still differ by icon. Copying has to pick
			// one, so pick the icon the most collections actually use rather
			// than whichever happened to be read first.
			const vk = r.field.icon || "";
			if (!g.variants.has(vk)) g.variants.set(vk, { field: r.field, n: 0 });
			g.variants.get(vk).n++;
		}
		const out = [];
		for (const g of bySig.values()) {
			let best = null;
			for (const v of g.variants.values()) if (!best || v.n > best.n) best = v;
			out.push({ key: g.key, field: best.field, cols: g.cols });
		}
		return out.sort((a, b) =>
			a.field.label.localeCompare(b.field.label) || b.cols.length - a.cols.length);
	}

	/** The union of every chosen template's fields, in template order, deduped
	 *  by field id. Two templates carrying the same property is normal (both
	 *  were cut from the same collection), and the target must see it once. */
	_unionFields() {
		const s = this._state, seen = new Set(), out = [];
		// Templates first, then loose properties, deduped by field id. Property
		// groups are already deduped by definition; the id check catches the
		// remaining case, where two DIFFERENT definitions carry the same id in
		// different collections and adding both would land one property on
		// another's data.
		for (const t of s.store.templates) {
			if (!s.tplIds.has(t.id)) continue;
			for (const f of t.fields) {
				if (seen.has(f.id)) continue;
				seen.add(f.id);
				out.push(f);
			}
		}
		for (const g of this._propertyGroups()) {
			if (!s.propKeys.has(g.key) || seen.has(g.field.id)) continue;
			seen.add(g.field.id);
			out.push(g.field);
		}
		return out;
	}

	_chosenTargets() {
		const s = this._state;
		return s.cols.filter((c) => s.targetGuids.has(c.guid));
	}

	/* One list, two kinds of thing: saved templates first, then every
	 * individual property in the workspace. They are the same choice ("what do
	 * I want to add?") so they belong in one place, and both feed the same
	 * union downstream. Templates stay pinned above properties rather than
	 * being ranked in with them, so the curated set is always where you left
	 * it. */
	_pickSources(p) {
		const s = this._state;
		const note = document.createElement("div");
		note.className = "gp-note";
		note.textContent = "Pick any mix of saved templates and individual properties from anywhere " +
			"in the workspace.";
		p.appendChild(note);

		const items = [];
		for (const t of s.store.templates) {
			items.push({
				// A ticked row moves to the top, so a handful of picks scattered
				// through 180 rows stay visible instead of scrolling away.
				rank: () => (s.tplIds.has(t.id) ? -1 : 0),
				title: t.name,
				sub: t.fields.length + " " + (t.fields.length === 1 ? "property" : "properties") +
					" · from " + t.srcName,
				checked: () => s.tplIds.has(t.id),
				onToggle: (on) => {
					if (on) s.tplIds.add(t.id); else s.tplIds.delete(t.id);
					this._syncStepBtn();
					this._redrawList();
				},
			});
		}
		for (const g of this._propertyGroups()) {
			items.push({
				rank: () => (s.propKeys.has(g.key) ? -1 : 1),
				title: g.field.label,
				sub: this._fieldDetail(g.field, s.colNames) + " · in " + g.cols[0] +
					(g.cols.length > 1 ? " and " + (g.cols.length - 1) + " more" : ""),
				checked: () => s.propKeys.has(g.key),
				onToggle: (on) => {
					if (on) s.propKeys.add(g.key); else s.propKeys.delete(g.key);
					this._syncStepBtn();
					this._redrawList();
				},
			});
		}

		this._list(p, items, {
			placeholder: "Search templates and properties…",
			multi: true,
			empty: "Nothing matches that.",
			sections: { "-1": "Selected", 0: "Templates", 1: "Properties" },
		});

		this._footer(p, this._backLink("Manage Templates", "manage", ""),
			"Continue", () => { s.step = 1; this._render(); },
			!!(s.tplIds.size || s.propKeys.size));
		this._syncStepBtn();
		this._wireGoto();
	}

	_applyPickTargets(p) {
		const s = this._state;
		const tpl = { fields: this._unionFields() };
		const note = document.createElement("div");
		note.className = "gp-note";
		note.textContent = tpl.fields.length === 1
			? "Add this property to which collections?"
			: "Add these " + tpl.fields.length + " properties to which collections?";
		p.appendChild(note);

		this._list(p, s.cols.filter((c) => this._isTarget(c)).map((c) => {
			const plan = this._plan(tpl, c.api.getConfiguration());
			return {
				rank: () => (s.targetGuids.has(c.guid) ? -1 : 0),
				title: c.name,
				sub: plan.add.length
					? "adds " + plan.add.length + (plan.skip.length ? ", skips " + plan.skip.length : "")
					: "already has all of them",
				dim: c.journal ? "journal" : "",
				// Nothing to do here, so nothing to tick. Ticking it would put a
				// collection in the summary that the apply would then no-op on.
				disabled: !plan.add.length,
				checked: () => s.targetGuids.has(c.guid),
				onToggle: (on) => {
					if (on) s.targetGuids.add(c.guid); else s.targetGuids.delete(c.guid);
					this._syncStepBtn();
					this._redrawList();
				},
			};
		}), { placeholder: "Search collections…", multi: true,
			sections: { "-1": "Selected", 0: "Collections" } });

		this._footer(p, this._stepLink("Back", 0, "‹"),
			"Continue", () => { s.step = 2; this._render(); }, !!s.targetGuids.size);
		this._syncStepBtn();
		this._wireGoto();
	}

	/** Both pick-steps share one Continue button whose label carries the count,
	 *  so the choice is legible without counting ticks by eye. */
	_syncStepBtn() {
		const s = this._state, p = this._panel();
		if (!s || !p) return;
		const b = p.querySelector(".gp-done");
		if (!b) return;
		if (s.step === 0) {
			const n = s.tplIds.size + s.propKeys.size;
			const f = this._unionFields().length;
			b.textContent = n ? "Continue with " + f + " " + (f === 1 ? "Property" : "Properties") : "Continue";
			b.disabled = !n;
		} else {
			const n = s.targetGuids.size;
			b.textContent = n ? "Continue with " + n + " " + (n === 1 ? "Collection" : "Collections") : "Continue";
			b.disabled = !n;
		}
	}

	_applyPreview(p) {
		const s = this._state;
		const tpl = { fields: this._unionFields() };
		const targets = this._chosenTargets();

		// One plan per target, all from _plan() — the same function the apply
		// runs, so what is shown and what happens cannot drift apart.
		const plans = targets.map((c) => ({ col: c, plan: this._plan(tpl, c.api.getConfiguration()) }));

		// A property is offered for unticking if ANY chosen target would take
		// it. One that every target already has is not a decision to make.
		const addable = tpl.fields.filter((f) =>
			plans.some((pl) => pl.plan.add.some((a) => a.id === f.id)));

		const note = document.createElement("div");
		note.className = "gp-note";
		note.textContent = targets.length === 1
			? "This is everything that will change in " + targets[0].name +
				". Untick anything you do not want."
			: "Untick anything you do not want added. This applies to all " +
				targets.length + " collections.";
		p.appendChild(note);

		const box = document.createElement("div");
		box.className = "gp-box";
		// Unticking leaves a property out of THIS apply only. The template is
		// not edited, so it still carries the property to the next collection.
		for (const f of addable) {
			const row = document.createElement("label");
			row.className = "gp-res is-add";
			const cb = document.createElement("input");
			cb.type = "checkbox";
			cb.checked = !s.exclude.has(f.id);
			cb.addEventListener("change", () => {
				if (cb.checked) s.exclude.delete(f.id); else s.exclude.add(f.id);
				row.classList.toggle("is-off", !cb.checked);
				this._renderTargetLines(plans);
				this._syncApplyBtn(plans);
			});
			row.appendChild(cb);
			row.appendChild(this.ui.$html(
				'<span class="gp-row-main"><span class="gp-row-title">' + this._esc(f.label) + '</span>' +
				'<span class="gp-row-sub">' + this._esc(this._fieldDetail(f, s.colNames)) + '</span></span>'));
			if (s.exclude.has(f.id)) row.classList.add("is-off");
			box.appendChild(row);
		}
		// With one target, name each skip and why. With several, the reasons
		// differ per collection, so they belong on the per-collection lines
		// below instead of in one undifferentiated list.
		if (targets.length === 1) {
			for (const sk of plans[0].plan.skip) {
				box.appendChild(this.ui.$html(
					'<div class="gp-res is-skip"><span class="gp-res-ic">–</span>' +
					'<span class="gp-row-main"><span class="gp-row-title">' + this._esc(sk.field.label) + '</span>' +
					'<span class="gp-row-sub">skipped: ' + this._esc(sk.why) + '</span></span></div>'));
			}
		}
		p.appendChild(box);

		if (targets.length > 1) {
			const tl = document.createElement("div");
			tl.className = "gp-targets";
			p.appendChild(tl);
			this._renderTargetLines(plans);
		}

		const foot = document.createElement("div");
		foot.className = "gp-note gp-fine";
		foot.textContent = "Nothing else in " +
			(targets.length === 1 ? targets[0].name : "these collections") +
			" is touched. New properties are added to the collection, not to any view. " +
			"Add them as columns yourself where you want them.";
		p.appendChild(foot);

		this._footer(p, this._stepLink("Back", 1, "‹"), "Add", () => this._doApply(), true);
		this._syncApplyBtn(plans);
		this._wireGoto();
	}

	/** The per-collection tally under the property list, redrawn on every tick
	 *  so unticking a property visibly changes what each collection gets. */
	_renderTargetLines(plans) {
		const s = this._state, p = this._panel();
		if (!p) return;
		const host = p.querySelector(".gp-targets");
		if (!host) return;
		host.innerHTML = "";
		for (const { col, plan } of plans) {
			const n = plan.add.filter((f) => !s.exclude.has(f.id)).length;
			host.appendChild(this.ui.$html(
				'<div class="gp-tline' + (n ? '' : ' is-off') + '">' +
				'<span class="gp-row-title">' + this._esc(col.name) + '</span>' +
				'<span class="gp-row-dim">' + (n ? "adds " + n : "nothing to add") +
				(plan.skip.length ? ", skips " + plan.skip.length : "") + '</span></div>'));
		}
	}

	/** The button label has to survive a trap: with several targets there are
	 *  TWO honest counts, and they differ. Five distinct properties can be six
	 *  additions, because a property missing from two collections is added
	 *  twice. Showing "Add 6 properties" above five tickboxes reads as a bug
	 *  even though both numbers are right. So: one collection gets a property
	 *  count, several collections get a collection count, and the per-collection
	 *  lines carry the detail. Never two competing numbers in one label. */
	_syncApplyBtn(plans) {
		const s = this._state, p = this._panel();
		if (!s || !p) return;
		const b = p.querySelector(".gp-done");
		if (!b) return;
		let total = 0;
		for (const { plan } of plans) total += plan.add.filter((f) => !s.exclude.has(f.id)).length;
		const cols = plans.filter(({ plan }) =>
			plan.add.some((f) => !s.exclude.has(f.id))).length;
		if (!total) { b.textContent = "Nothing Selected"; b.disabled = true; return; }
		b.textContent = cols > 1
			? "Add to " + cols + " Collections"
			: "Add " + total + " " + (total === 1 ? "Property" : "Properties");
		b.disabled = false;
	}

	async _doApply() {
		const s = this._state;
		if (!s || s.busy) return;
		s.busy = true;
		const btn = this._panel() && this._panel().querySelector(".gp-done");
		if (btn) { btn.disabled = true; btn.textContent = "Adding…"; }

		const tpl = { fields: this._unionFields() };
		const targets = this._chosenTargets();
		const exclude = s.exclude;
		// Sequential, not Promise.all: each apply is a config write to a
		// different plugin, and letting them overlap buys nothing while making
		// a partial failure much harder to report accurately.
		const done = [], failed = [];
		for (const col of targets) {
			try {
				const res = await this._apply(tpl, col, exclude);
				if (res.ok) done.push({ name: col.name, n: res.added.length });
				else failed.push(col.name);
			} catch (e) {
				failed.push(col.name);
			}
		}
		this._closeModal();

		// Count only the collections that actually RECEIVED something. A target
		// whose every property was already there, or was unticked, succeeded
		// without changing anything, and counting it overstates what happened.
		const changed = done.filter((d) => d.n > 0);
		const total = changed.reduce((a, d) => a + d.n, 0);
		if (!failed.length) {
			if (!total) this._toast("Nothing to add. Those collections already have these properties.");
			else this._toast(changed.length === 1
				? "Added " + total + " " + (total === 1 ? "property" : "properties") + " to " + changed[0].name + "."
				: "Added " + total + " properties across " + changed.length + " collections.");
		} else if (changed.length) {
			this._toast("Added " + total + " properties to " + changed.length +
				" collections. Failed on: " + failed.join(", ") + ".");
		} else {
			this._toast("Nothing was added. Failed on: " + failed.join(", ") + ".");
		}
	}

	// ══════════════════════════════════════════════════════════════════════
	// Screen: manage
	// ══════════════════════════════════════════════════════════════════════

	/* Templates get their own search once there are enough of them to hunt
	 * through. It matches the name, the source collection, AND the property
	 * labels inside, so "which template had Status in it" is findable. */
	static SEARCH_FROM = 4;

	_renderManage(p) {
		const s = this._state;
		if (!s.store.templates.length) return this._renderEmpty(p);

		if (s.store.templates.length >= Plugin.SEARCH_FROM) {
			const inp = document.createElement("input");
			inp.className = "gp-search";
			inp.type = "text";
			inp.placeholder = "Search templates…";
			inp.value = s.tq || "";
			inp.addEventListener("input", () => {
				s.tq = inp.value;
				s.tActive = 0;
				this._drawTemplateRows();
				// Redrawing the rows does not touch the input, so the caret
				// stays where the user left it and typing is uninterrupted.
			});
			// Same keyboard contract as the pickers: Up/Down move, Enter takes.
			// Enter here means "apply this template", the row's primary action.
			inp.addEventListener("keydown", (e) => {
				const rows = this._panel().querySelectorAll(".gp-trow");
				if (e.key === "ArrowDown") { e.preventDefault(); this._moveTemplateActive(1); }
				else if (e.key === "ArrowUp") { e.preventDefault(); this._moveTemplateActive(-1); }
				else if (e.key === "Enter") {
					e.preventDefault();
					const row = rows[s.tActive || 0];
					if (row) row.querySelector('[data-act="apply"]').click();
				}
			});
			p.appendChild(inp);
		}

		// The rows live in their own plain container. It carries NO border:
		// each template row already draws one, and nesting a bordered list
		// inside a bordered box put a second frame around the whole set.
		const box = document.createElement("div");
		box.className = "gp-manage";
		p.appendChild(box);
		this._drawTemplateRows();

		this._footer(p, this._backLink("Add Properties", "apply", "+"),
			null, null, null, this._backLink("New Template", "new", "+"));
		this._wireGoto();
	}

	_moveTemplateActive(dir) {
		const s = this._state, p = this._panel();
		if (!s || !p) return;
		const rows = p.querySelectorAll(".gp-trow");
		if (!rows.length) return;
		s.tActive = Math.max(0, Math.min((s.tActive || 0) + dir, rows.length - 1));
		rows.forEach((r, i) => r.classList.toggle("is-active", i === (s.tActive || 0)));
		const row = rows[s.tActive || 0];
		if (row && row.scrollIntoView) row.scrollIntoView({ block: "nearest" });
	}

	_drawTemplateRows() {
		const s = this._state, p = this._panel();
		if (!s || !p) return;
		const box = p.querySelector(".gp-manage");
		if (!box) return;
		box.innerHTML = "";

		const q = s.tq || "";
		const rows = s.store.templates
			.map((t) => ({
				t,
				sc: this._score(t.name + " " + t.srcName + " " +
					t.fields.map((f) => f.label).join(" "), q),
			}))
			.filter((r) => r.sc > 0);

		if (!rows.length) {
			box.appendChild(this.ui.$html('<div class="gp-empty">No template matches that.</div>'));
			return;
		}

		for (const { t } of rows) {
			const row = document.createElement("div");
			row.className = "gp-trow";
			row.innerHTML =
				'<div class="gp-trow-head">' +
					'<span class="gp-row-main"><span class="gp-row-title">' + this._esc(t.name) + '</span>' +
					'<span class="gp-row-sub">' + t.fields.length + " " +
						(t.fields.length === 1 ? "property" : "properties") +
						" · from " + this._esc(t.srcName) + '</span></span>' +
					'<span class="gp-tacts">' +
						'<button class="gp-btn" data-act="apply" title="Apply this template">→</button>' +
						'<button class="gp-btn" data-act="rename" title="Edit this template">✎</button>' +
						'<button class="gp-btn" data-act="delete" title="Delete">×</button>' +
					'</span>' +
				'</div>' +
				'<div class="gp-trow-body">' + (t.fields.map((f) =>
					'<span class="gp-chip">' + this._esc(f.label) +
					'<span class="gp-chip-t">' + this._esc(f.type) + '</span></span>').join("")) + '</div>';
			row.querySelector('[data-act="apply"]').addEventListener("click", () => {
				s.screen = "apply";
				s.tplIds = new Set([t.id]);
				s.targetGuids = new Set();
				s.exclude = new Set();
				s.step = 1;              // straight past the template picker
				this._render();
			});
			row.querySelector('[data-act="rename"]').addEventListener("click", () => {
				s.screen = "edit";
				s.editId = t.id;
				s.editName = t.name;
				s.editKeep = new Set(t.fields.map((f) => f.id));
				this._render();
			});
			row.querySelector('[data-act="delete"]').addEventListener("click", () => this._beginDelete(row, t));
			box.appendChild(row);
		}
		if (p.querySelector(".gp-search")) {
			const rows = box.querySelectorAll(".gp-trow");
			const i = Math.min(s.tActive || 0, rows.length - 1);
			s.tActive = i < 0 ? 0 : i;
			rows.forEach((r, n) => r.classList.toggle("is-active", n === s.tActive));
		}
	}

	_renderEmpty(p) {
		const e = document.createElement("div");
		e.className = "gp-note";
		e.textContent = "No templates yet. Save the properties of a collection you have already set up, " +
			"then add them to another collection in two clicks.";
		p.appendChild(e);
		this._footer(p, this._backLink("Add Properties", "apply", "+"),
			null, null, null, this._backLink("New Template", "new", "+"));
		this._wireGoto();
	}

	/* Delete is INLINE, not window.confirm, and the pen opens the edit screen
	 * rather than a native prompt. Electron ships prompt() as a stub that
	 * throws, so the original pen ran into an exception and did nothing at all:
	 * no dialog, no error the user could see. Nothing here may depend on a
	 * native dialog.
	 */
	/** Two-step delete in the row itself: the × arms it, and the confirm
	 *  commits. No native dialog, and no way to lose a template on one click. */
	_beginDelete(row, t) {
		const acts = row.querySelector(".gp-tacts");
		if (!acts || acts.querySelector(".gp-confirm")) return;
		acts.innerHTML = '<span class="gp-confirm">Delete?' +
			'<button class="gp-btn gp-yes" title="Delete">✓</button>' +
			'<button class="gp-btn gp-no" title="Keep">×</button></span>';
		acts.querySelector(".gp-no").addEventListener("click", () => this._drawTemplateRows());
		acts.querySelector(".gp-yes").addEventListener("click", () => {
			const store = this._loadStore();
			store.templates = store.templates.filter((x) => x.id !== t.id);
			this._state.store = this._stageStore(store);
			this._render();
			this._toast("Deleted “" + t.name + "”. Properties already added to collections are untouched.");
		});
	}

	// ══════════════════════════════════════════════════════════════════════
	// Toast
	// ══════════════════════════════════════════════════════════════════════

	/** The dialog is gone by the time a write finishes (saving our own config
	 *  reloads the plugin), so the result needs somewhere to land. Appended to
	 *  body, self-removing, and swept in onUnload by its own class. */
	_toast(text) {
		for (const el of document.querySelectorAll(".gp-toast")) el.remove();
		const t = document.createElement("div");
		t.className = "gp-toast";
		t.textContent = text;
		document.body.appendChild(t);
		setTimeout(() => t.classList.add("is-in"), 10);
		setTimeout(() => { t.classList.remove("is-in"); setTimeout(() => t.remove(), 300); }, 4200);
	}

	// ══════════════════════════════════════════════════════════════════════
	// Style
	// ══════════════════════════════════════════════════════════════════════

	/* The palette and the 4px radius are the house style settled on 2026-08-15:
	 * four named values used everywhere so the panel reads as one surface.
	 * Dark themes get literals; light themes keep Thymer's cmdpal tokens,
	 * because a #1A1A1E plate under light-theme text is unreadable.
	 * NO BACKTICKS anywhere below, comments included, or this literal
	 * terminates early and the plugin will not parse. */
	_injectStyle() {
		const css = `
:root {
	--gp-panel-bg: var(--cmdpal-bg-color, var(--app-bg, #26262b));
	--gp-field-bg: color-mix(in srgb, currentColor 6%, transparent);
	--gp-line: color-mix(in srgb, currentColor 16%, transparent);
	--gp-accent: var(--color-primary-500, #4caea1);
}
html.is-dark {
	--gp-panel-bg: #1A1A1E;
	--gp-field-bg: #212126;
}
@media (prefers-color-scheme: dark) {
	html:not(.is-light) {
		--gp-panel-bg: #1A1A1E;
		--gp-field-bg: #212126;
	}
}
.gp-ovl {
	position: fixed; inset: 0; z-index: 99998;
	background: rgba(0,0,0,.45);
	display: flex; align-items: center; justify-content: center; padding: 24px;
}
.gp-panel {
	position: relative; z-index: 99999;
	width: min(560px, 100%); max-height: min(680px, calc(100dvh - 48px));
	display: flex; flex-direction: column;
	padding: 24px; border-radius: 4px;
	background: var(--gp-panel-bg);
	border: 1px solid rgba(127,127,127,.4);
	box-shadow: 0 24px 64px rgba(0,0,0,.5);
	font-size: var(--text-size-small, .875rem);
	color: var(--cmdpal-fg-color, var(--text-color, inherit));
}
.gp-head h1 {
	font-size: 1.0625rem; font-weight: 600;
	margin: 0 -24px 22px; padding: 0 24px 22px;
	border-bottom: 1px solid var(--gp-line);
}
.gp-head .gp-ver {
	margin-left: 8px; font-size: var(--text-size-smaller, .8125rem);
	font-weight: 400; opacity: .45;
}
.gp-note { font-size: .8125rem; opacity: .6; line-height: 1.6; margin-bottom: 14px; }
.gp-fine { margin: 12px 0 0; }
.gp-listwrap { display: flex; flex-direction: column; min-height: 0; flex: 1; }
.gp-search, .gp-input {
	-webkit-appearance: none; appearance: none;
	width: 100%; box-sizing: border-box;
	background: var(--gp-field-bg); border: 1px solid var(--gp-line);
	border-radius: 4px; padding: 8px 11px; font-size: .875rem;
	color: inherit; font-family: inherit; box-shadow: none; margin-bottom: 10px;
}
.gp-search:focus, .gp-input:focus { outline: none; border-color: var(--gp-accent); }
.gp-list, .gp-box, .gp-manage { overflow-y: auto; flex: 1; min-height: 0; }
.gp-box { border: 1px solid var(--gp-line); border-radius: 4px; padding: 6px; }
/* .gp-manage carries NO border of its own: every template row already draws
   one, and a bordered list of bordered rows reads as a double frame. */
.gp-row {
	display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
	background: transparent; border: 0; color: inherit; font: inherit;
	padding: 8px 11px; border-radius: 4px; cursor: pointer;
}
/* The keyboard's active row is marked ONE way: a filled background, the same
   treatment hover uses and the same thing Thymer's own command palette does.
   An accent edge on top of a grey fill was two competing signals for one
   state. */
.gp-row:hover, .gp-row.is-active { background: var(--gp-field-bg); }
.gp-trow.is-active { background: var(--gp-field-bg); }
/* A ticked row gets NO surface of its own. The checkbox already says it is
   picked, and in the mixed list the Selected section says it again; a third
   signal turned a run of ticked rows into one solid block instead. */
.gp-row.is-disabled { opacity: .35; cursor: default; }
.gp-row.is-disabled:hover { background: transparent; }
.gp-row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.gp-row-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gp-row-sub { font-size: .75rem; opacity: .5; }
.gp-row-dim { font-size: .75rem; opacity: .4; flex: none; }
.gp-empty { padding: 14px 11px; font-size: .8125rem; opacity: .5; }
/* Section heading inside a mixed list. Quiet: it labels a group, it is not a
   thing you can act on. */
.gp-sec {
	padding: 10px 11px 4px; font-size: .75rem; opacity: .45;
	letter-spacing: .04em; text-transform: uppercase;
}
.gp-list .gp-sec:first-child { padding-top: 2px; }
.gp-check {
	display: flex; align-items: center; gap: 10px;
	padding: 8px 11px; border-radius: 4px; cursor: pointer;
}
.gp-check:hover { background: var(--gp-field-bg); }
.gp-check input[type="checkbox"] {
	width: 16px; height: 16px; margin: 0; flex: none; accent-color: var(--gp-accent);
}
.gp-field { margin-top: 16px; }
.gp-label { font-size: .75rem; opacity: .55; margin-bottom: 6px; }
.gp-link {
	display: inline-flex; align-items: center; gap: 6px;
	background: transparent; border: 0; padding: 0; cursor: pointer;
	color: var(--gp-accent); font: inherit; font-size: .8125rem;
	opacity: .85; transition: opacity .12s ease, filter .12s ease;
}
.gp-link-mark { font-size: 15px; line-height: 1; opacity: .9; }
/* Hover brightens, it does not underline. An underline on an accent-coloured
   control reads as a hyperlink in running text; these are buttons. */
.gp-link:hover { opacity: 1; filter: brightness(1.25); text-decoration: none; }
.gp-selall { display: block; margin: 4px 0 8px 11px; }
.gp-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 18px; }
/* 24px, not 12: at 12 the two labels ran together and read as one sentence. */
.gp-foot-left, .gp-foot-right { display: flex; align-items: center; gap: 24px; }
.gp-done {
	min-width: 96px; padding: 8px 18px; border-radius: 4px; cursor: pointer;
	border: 1px solid transparent;
	background: var(--ed-button-primary-bg, var(--color-primary-500, #3aa37f));
	color: #fff; font: inherit; font-weight: 600;
}
.gp-done:hover:not(:disabled) { filter: brightness(1.18); }
.gp-done:disabled { opacity: .4; cursor: default; }
.gp-res { display: flex; align-items: center; gap: 10px; padding: 8px 11px; border-radius: 4px; }
.gp-res-ic { width: 14px; text-align: center; font-weight: 600; flex: none; }
.gp-res.is-add .gp-res-ic { color: var(--gp-accent); }
.gp-res.is-skip { opacity: .45; }
/* An addable row is a tickbox you can turn off for this apply only. */
.gp-res.is-add { cursor: pointer; }
.gp-res.is-add:hover { background: var(--gp-field-bg); }
.gp-res input[type="checkbox"], .gp-row.is-multi input[type="checkbox"] {
	width: 16px; height: 16px; margin: 0; flex: none; accent-color: var(--gp-accent);
}
/* An unticked row is dimmed and nothing more. The empty checkbox already
   says it is out; a strikethrough on top of that reads as "deleted". */
.gp-res.is-off, .gp-check.is-off { opacity: .4; }
.gp-row.is-multi { cursor: pointer; }
/* Per-collection tally under the property list, when more than one is chosen */
.gp-targets { margin-top: 12px; border-top: 1px solid var(--gp-line); padding-top: 10px; }
.gp-tline {
	display: flex; align-items: baseline; justify-content: space-between;
	gap: 12px; padding: 4px 2px; font-size: .8125rem;
}
.gp-tline.is-off { opacity: .4; }
/* Inline rename field, sized to sit in the row it replaces */
.gp-rename { margin: 0; padding: 4px 8px; }
/* Two-step delete, armed in the row itself */
.gp-confirm { display: inline-flex; align-items: center; gap: 4px; font-size: .75rem; opacity: .9; }
.gp-confirm .gp-yes { color: var(--gp-accent); opacity: .9; }
.gp-trow { border: 1px solid var(--gp-line); border-radius: 4px; margin-bottom: 8px; }
.gp-trow:last-child { margin-bottom: 0; }
.gp-trow-head { display: flex; align-items: center; gap: 10px; padding: 10px 12px; }
.gp-trow-body { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 12px 11px; }
.gp-chip {
	display: inline-flex; align-items: center; gap: 6px;
	background: var(--gp-field-bg); border-radius: 4px;
	padding: 3px 8px; font-size: .75rem;
}
.gp-chip-t { opacity: .45; }
.gp-tacts { display: flex; gap: 2px; flex: none; }
.gp-btn {
	width: 26px; height: 26px; border: 0; border-radius: 4px; cursor: pointer;
	background: transparent; color: inherit; font: inherit; opacity: .45;
}
.gp-btn:hover { opacity: .95; background: color-mix(in srgb, currentColor 10%, transparent); }
.gp-toast {
	position: fixed; left: 50%; bottom: 54px; transform: translate(-50%, 12px);
	z-index: 100000; max-width: min(520px, calc(100vw - 48px));
	background: var(--gp-panel-bg); color: var(--cmdpal-fg-color, var(--text-color, inherit));
	border: 1px solid rgba(127,127,127,.4); border-radius: 4px;
	padding: 10px 16px; font-size: .8125rem;
	box-shadow: 0 12px 32px rgba(0,0,0,.45);
	opacity: 0; transition: opacity .2s ease, transform .2s ease;
}
.gp-toast.is-in { opacity: 1; transform: translate(-50%, 0); }
`;
		const el = document.createElement("style");
		el.setAttribute("data-gp-style", "1");
		el.textContent = css;
		document.head.appendChild(el);
		this._style = el;
	}
}
