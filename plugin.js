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
	_fillKw = null;
	_onFillKey = null;
	_onTitleKey = null;
	_titleLast = { guid: null, at: 0, title: "", raw: "" };
	_ovl = null;
	_state = null;
	_pending = null;
	_pendingRules = null;
	_pendingKw = null;
	_rulesCache = null;

	onLoad() {
		// Live handles for CDP verification, same convention as Saved Searches.
		// Reassigned on every load, because a code push swaps the instance and
		// driving the previous one looks exactly like a data bug.
		// KEYED BY WORKSPACE, and this is not optional: the plugin is installed
		// in two workspaces and BOTH instances live in the same renderer, so a
		// bare handle belongs to whichever loaded last. Deploying to Experiments
		// silently repointed it, and the main workspace's 58 rules read as 0.
		window.__gp = this;
		(window.__gpAll || (window.__gpAll = {}))[this.getWorkspaceGuid()] = this;
		this._injectStyle();
		this._hookCreation();
		// The Fill From Title chord. ⌘⇧G was verified free on the corrected
		// 147-chord audit (⌘⇧F is the search panel; ⌥+letter would steal the
		// editor's special characters). Changeable from the Fill screen; the
		// user's choice lives in the same store as the aliases.
		try { this._fillKw = this._loadKeywords(); } catch (e) { this._fillKw = null; }
		this._onFillKey = (e) => {
			if (this._ovl) return;                       // the dialog is open: its own keys rule
			const sc = (this._fillKw && this._fillKw.shortcut) || Plugin.FILL_SHORTCUT_DEFAULT;
			if (!sc || !e.key) return;
			if (e.key.toLowerCase() !== sc.key) return;
			if (e.metaKey !== !!sc.meta || e.shiftKey !== !!sc.shift ||
				e.altKey !== !!sc.alt || e.ctrlKey !== !!sc.ctrl) return;
			e.preventDefault();
			e.stopPropagation();
			this._open("fill");
		};
		window.addEventListener("keydown", this._onFillKey, true);
		// Enter in the page TITLE field runs Fill From Title, silently, on the
		// record in front of you. Same capture-phase window listener, same
		// discipline: never react to a chord, never while the dialog is open.
		//
		// The title field is identified the only way it can be from outside:
		// an input at the very top of the panel, above the body editor, whose
		// TEXT IS THE PAGE TITLE. That last test is the load-bearing one — a
		// property input in the same place holds a property value, and its
		// value never matches the title, so the fill quietly never runs.
		// The value is captured at the keydown and re-checked after the title
		// has had a moment to commit, so "still being typed" cannot match
		// half a title either.
		this._onTitleKey = (e) => {
			if (this._ovl) return;
			if (e.key !== "Enter" || e.repeat || e.isComposing) return;
			if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
			const tgt = e.target;
			if (!tgt || tgt.nodeType !== 1) return;
			const tag = (tgt.tagName || "").toLowerCase();
			if (tag !== "input" && tag !== "textarea") return;
			if (tgt.closest && tgt.closest(".gp-ovl")) return;
			let panel = null;
			try { panel = this.ui.getActivePanel(); } catch (err) {}
			if (!panel || !panel.getType || panel.getType() !== "edit_panel") return;
			const rec = panel.getActiveRecord && panel.getActiveRecord();
			if (!rec || !rec.guid) return;
			const pel = panel.getElement && panel.getElement();
			if (!pel || !pel.contains(tgt)) return;
			const pr = pel.getBoundingClientRect();
			const tr = tgt.getBoundingClientRect();
			if (tr.width < 1 || tr.top - pr.top > 160) return;
			// The body editor's own proxy is a textarea too: excluded by
			// identity, whatever it looks like on screen.
			try { if (window.g_virtual_input && tgt === window.g_virtual_input.$textarea) return; } catch (err) {}
			// Never swallow the key: Thymer's own Enter still runs (commits the
			// title, moves the caret). The fill rides along, delayed, and only
			// writes what the preview would have ticked into a blank field.
			this._titleEnterSchedule(rec.guid, (tgt.value != null ? String(tgt.value) : ""));
		};
		window.addEventListener("keydown", this._onTitleKey, true);
		// One command per screen. Two commands were right when the plugin had
		// two screens; with five, the palette is how you navigate and three of
		// them were unreachable from it. Every icon below was probed against the
		// running app first — Thymer ships a SUBSET of tabler, and a class that
		// is not in it renders as nothing at all rather than as a broken glyph.
		this._cmds = Plugin.COMMANDS.map((c) => this.ui.addCommandPaletteCommand({
			label: "Global Properties: " + c.label,
			icon: c.icon,
			onSelected: () => this._open(c.screen),
		}));
	}

	onUnload() {
		this._flushStore();
		this._closeModal();
		if (this._onFillKey) { window.removeEventListener("keydown", this._onFillKey, true); this._onFillKey = null; }
		if (this._onTitleKey) { window.removeEventListener("keydown", this._onTitleKey, true); this._onTitleKey = null; }
		for (const c of this._cmds || []) { try { c.remove(); } catch (e) {} }
		this._cmds = [];
		if (this._style) { this._style.remove(); this._style = null; }
		// Sweep by the same selector the creation uses, in case an earlier
		// onUnload never ran and left an orphan overlay behind. The tooltip and
		// the toast live on BODY rather than inside the overlay, so they need
		// sweeping by their own class or they outlive the dialog.
		for (const el of document.querySelectorAll(".gp-ovl")) el.remove();
		for (const el of document.querySelectorAll(".gp-tip")) el.remove();
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
	_stageStore(next, rules) {
		next.rev = Date.now();
		this._pending = next;
		if (rules) { rules.rev = next.rev; this._pendingRules = rules; this._rulesCache = rules; }
		try { localStorage.setItem(this._lsKey(), JSON.stringify(next)); } catch (e) {}
		return next;
	}

	async _flushStore() {
		const next = this._pending, rules = this._pendingRules, kw = this._pendingKw;
		if (!next && !rules && !kw) return false;
		this._pending = null;
		this._pendingRules = null;
		this._pendingKw = null;
		const mine = (await this.data.getAllGlobalPlugins() || [])
			.find((p) => p.getGuid() === this.getGuid());
		if (!mine) return false;
		const cfg = JSON.parse(JSON.stringify(this.getConfiguration()));
		cfg.custom = Object.assign({}, cfg.custom || {});
		// The config key stays `property_templates` even though the plugin is
		// now called Global Properties: renaming it would orphan every template
		// already saved. Same reason the localStorage key keeps its pt_ prefix.
		if (next) cfg.custom.property_templates = next;
		if (rules) cfg.custom[Plugin.RULES_KEY] = rules;
		if (kw) cfg.custom[Plugin.KW_KEY] = kw;
		return await mine.saveConfiguration(cfg);
	}

	/* Fill From Title keywords: per collection, per choice field, per option, a
	 * list of words or phrases that select that option when found in a title
	 * ("Möte" -> Contact Log). Same two-stage save as everything else here. */
	static KW_KEY = "fill_keywords";
	static KW_LS = "pt_fillkw_v1_";

	_loadKeywords() {
		let a = null, b = null;
		try { a = (this.getConfiguration().custom || {})[Plugin.KW_KEY] || null; } catch (e) {}
		try { b = JSON.parse(localStorage.getItem(Plugin.KW_LS + this.getWorkspaceGuid()) || "null"); } catch (e) {}
		const empty = { rev: 0, map: {} };
		a = a && a.map ? a : empty; b = b && b.map ? b : empty;
		const win = (b.rev || 0) > (a.rev || 0) ? b : a;
		// `auto` (colGuid -> [fieldIds] that fill themselves when a new record
		// arrives WITH a title) and `shortcut` (the Fill From Title chord) rode
		// in later, 1.3.0-dev.
		return { rev: win.rev || 0, map: JSON.parse(JSON.stringify(win.map || {})),
			auto: JSON.parse(JSON.stringify(win.auto || {})),
			shortcut: win.shortcut ? JSON.parse(JSON.stringify(win.shortcut)) : null };
	}

	_stageKeywords(kw) {
		kw.rev = Date.now();
		this._pendingKw = kw;
		this._fillKw = kw;                 // the shortcut listener reads this cache
		try { localStorage.setItem(Plugin.KW_LS + this.getWorkspaceGuid(), JSON.stringify(kw)); } catch (e) {}
		return kw;
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
			let journal = false, managed = false, name = "", icon = "";
			// The icon is a tabler class on the collection's own config; there is
			// no getIcon(). It needs the base `ti` class to render as anything
			// but tofu — the class alone carries the codepoint, not the font.
			try { icon = (c.getConfiguration() || {}).icon || ""; } catch (e) {}
			try { journal = !!c.isJournalPlugin(); } catch (e) {}
			try { managed = !!((c.getConfiguration() || {}).managed || {}).fields; } catch (e) {}
			try { name = c.getName() || ""; } catch (e) {}
			return { api: c, guid: c.getGuid(), name, icon, journal, managed };
		}).sort((a, b) => a.name.localeCompare(b.name));
	}

	/** A collection's icon, as Thymer's own markup. Needs the base `ti` class:
	 *  `ti-notes` alone carries the glyph codepoint but not the tabler font, so
	 *  it renders as a tofu box. Falls back to the default collection glyph. */
	_colIcon(col) {
		// ONLY ti- values may be passed through as a class. Thymer also stores
		// non-font "fill" icons (blinking-dot and friends) that it renders as
		// CSS; used as a class they produce a blank. Documented in
		// SHARED-DESTINATION-PICKER.md, measured there across 66 collections.
		const raw = (col && col.icon) || "";
		const cls = /^ti-/.test(raw) ? raw : "ti-notes";
		return '<span class="gp-colicon ti ' + this._esc(cls) + '"></span>';
	}

	/** The same, resolved from a guid — the rules screens hold guids, not rows. */
	_colIconFor(guid) {
		return this._colIcon((this._state.cols || []).find((c) => c.guid === guid));
	}

	/* Reordering runs on POINTER events, not HTML5 drag-and-drop.
	 *
	 * The native API never started a drag here. It is the fragile one: it wants
	 * dataTransfer set in dragstart, it interacts badly with a zoomed ancestor,
	 * and when it declines there is no error — the row simply does not move.
	 * Pointer events have none of that: they are the same events a click uses,
	 * they respect the panel's zoom because every coordinate comes from
	 * getBoundingClientRect, and they work identically on a trackpad.
	 *
	 * `host` survives the redraws (only its children are replaced), so the
	 * pointer capture lives there rather than on a row that is about to be
	 * thrown away mid-drag.
	 *
	 *   onMove(from, to)  reorder the model and redraw
	 *   onEnd(moved)      commit, once, only if something actually moved
	 */
	_sortable(host, onMove, onEnd) {
		// Bound ONCE per host. Every reorder redraws the list, and the redraw
		// called this again, so after N moves there were N sets of listeners on
		// the same element: one pointerdown started N drags and one pointermove
		// applied N reorders, which reads as the list fighting you and then as
		// the plugin being stuck. Only the callbacks are refreshed.
		if (host._gpSort) { host._gpSort.onMove = onMove; host._gpSort.onEnd = onEnd; return; }
		const cb = host._gpSort = { onMove, onEnd };
		let drag = null;
		const rowAt = (y) => {
			for (const r of host.children) {
				const i = r.getAttribute("data-sort");
				if (i === null) continue;
				const b = r.getBoundingClientRect();
				if (y >= b.top && y <= b.bottom) return +i;
			}
			return null;
		};
		host.addEventListener("pointerdown", (e) => {
			if (e.button !== 0) return;
			const row = e.target.closest && e.target.closest("[data-sort]");
			// A control inside the row (the NEW tickbox) keeps its own click.
			if (!row || !host.contains(row) || e.target.closest("button")) return;
			drag = { index: +row.getAttribute("data-sort"), y: e.clientY, moved: false };
			host.setPointerCapture(e.pointerId);
			// Without this the pointer press starts a text selection instead.
			e.preventDefault();
		});
		host.addEventListener("pointermove", (e) => {
			if (!drag) return;
			// A few pixels of slop, so a click is never read as a drag.
			if (!drag.moved && Math.abs(e.clientY - drag.y) < 4) return;
			drag.moved = true;
			const to = rowAt(e.clientY);
			if (to === null || to === drag.index) return;
			cb.onMove(drag.index, to);
			drag.index = to;
		});
		const end = (e) => {
			if (!drag) return;
			const moved = drag.moved;
			drag = null;
			try { host.releasePointerCapture(e.pointerId); } catch (err) {}
			cb.onEnd(moved);
		};
		host.addEventListener("pointerup", end);
		host.addEventListener("pointercancel", end);
	}

	/* Every popover search: focus survives the re-render that each keystroke
	 * causes, with the caret left at the end. Without this the field loses focus
	 * after one character, because typing re-renders the whole panel and builds
	 * a brand new input. */
	_popSearch(parent, placeholder, value, onInput) {
		const inp = this._search(parent, placeholder, value, onInput);
		inp.classList.add("gp-popsearch");
		setTimeout(() => {
			try { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); } catch (e) {}
		}, 0);
		return inp;
	}

	/* Keyboard in the pickers, to the shared destination picker's contract:
	 * type to filter, Up/Down to move, Enter to take, and focus never leaves the
	 * search box. Rows that cannot be picked are skipped rather than landed on.
	 * The active row is marked ONE way — a filled background — the same signal
	 * hover uses, per the house rule of one signal per state. */
	_popNav(pop) {
		const s = this._state;
		const rows = [...pop.querySelectorAll(".gp-poprow")].filter((r) => !r.classList.contains("is-off"));
		if (!rows.length) return;
		if (typeof s.popActive !== "number") s.popActive = 0;
		s.popActive = Math.max(0, Math.min(s.popActive, rows.length - 1));
		const paint = () => {
			rows.forEach((r, i) => r.classList.toggle("is-active", i === s.popActive));
			const r = rows[s.popActive];
			if (r && r.scrollIntoView) r.scrollIntoView({ block: "nearest" });
		};
		paint();
		const move = (d) => {
			s.popActive = Math.max(0, Math.min(s.popActive + d, rows.length - 1));
			paint();
		};
		const onKey = (e) => {
			if (e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); move(1); }
			else if (e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); move(-1); }
			else if (e.key === "Enter") {
				e.preventDefault(); e.stopPropagation();
				const r = rows[s.popActive];
				if (r) r.click();
			}
		};
		const input = pop.querySelector("input");
		if (input) input.addEventListener("keydown", onKey);
		else {
			// No search box in this popover, so the popover itself takes the keys.
			pop.setAttribute("tabindex", "-1");
			pop.addEventListener("keydown", onKey);
			setTimeout(() => { try { pop.focus(); } catch (e) {} }, 0);
		}
	}

	/* A popover is laid out in flow, then lifted to FIXED coordinates.
	 *
	 * In the design file the page simply grows, so a popover can never be cut
	 * off. Here it sits inside a panel capped at 760px with `overflow: hidden`
	 * for its rounded corners, and inside a scrolling band on top of that — two
	 * ancestors that clip. A short Default Values list opens its picker near the
	 * bottom of the panel, and the list was sliced off at the frame edge.
	 *
	 * Fixed coordinates escape both clips. It opens downward as designed, flips
	 * above the trigger when there is not enough room below, and clamps to the
	 * viewport only when neither side fits. Re-anchored on scroll, because the
	 * band underneath it can still move. */
	_placePop(anchor, pop, align) {
		// The trigger is the anchor's OWN control, never anything inside the
		// popover. Most anchors hold a trigger button followed by the popover, so
		// the first button in document order was the right one; the record-cost
		// cell does not — its trigger is a plain span, and the first button is the
		// popover's own footer link. place() resets the popover to 0,0 before it
		// measures, so that link measured at the viewport origin and the popover
		// was thrown to the far left of the screen, clear of the dialog.
		const trigger = Array.from(anchor.querySelectorAll("button")).find((b) => !pop.contains(b))
			|| Array.from(anchor.children).find((el) => el !== pop)
			|| anchor;
		const place = () => {
			if (!pop.isConnected) return;
			pop.style.position = "fixed";
			pop.style.left = "0px";
			pop.style.top = "0px";
			// The panel is zoomed, and a fixed child of a zoomed element reads its
			// left/top in the ZOOMED coordinate space while getBoundingClientRect
			// reports real viewport pixels. Without dividing back out, every
			// popover lands proportionally further down and right than its
			// trigger. offsetWidth/Height are unzoomed too, hence the multiply.
			const panel = this._panel();
			const z = parseFloat(panel ? getComputedStyle(panel).zoom : 1) || 1;
			const t = trigger.getBoundingClientRect();
			const h = pop.offsetHeight * z, w = pop.offsetWidth * z;
			const vw = window.innerWidth, vh = window.innerHeight;
			// BELOW the trigger, always: the design rules out flipping (§5), and
			// a picker that jumped above its row covered the dialog's own header.
			// When it does not fit, it keeps its place and scrolls instead.
			const top = t.bottom + 4;
			pop.style.maxHeight = "";
			pop.style.overflowY = "";
			if (top + h > vh - 12) {
				pop.style.maxHeight = (Math.max(160, vh - 12 - top) / z) + "px";
				pop.style.overflowY = "auto";
			}
			const wanted = align === "right" ? t.right - w : t.left;
			pop.style.left = (Math.max(12, Math.min(wanted, vw - 12 - w)) / z) + "px";
			pop.style.top = (top / z) + "px";
		};
		// Deferred by a frame, NOT called inline: at the point each screen
		// appends its popover the anchor's own parent is still detached, so the
		// trigger measures as a zero rect, `pop.isConnected` is false, and the
		// popover silently keeps its CSS position. It looks placed and is not.
		requestAnimationFrame(() => {
			place();
			this._popNav(pop);
			// The scroller lives inside the panel and is thrown away on the next
			// render, so this listener goes with it — nothing to clean up.
			const scroller = anchor.closest(".gp-scroll");
			if (scroller) scroller.addEventListener("scroll", place, { passive: true });
		});
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
	async _apply(tpl, col, exclude, order) {
		const live = col.api.getConfiguration();
		const plan = this._plan(tpl, live);
		const add = plan.add.filter((f) => !(exclude && exclude.has(f.id)));
		if (!add.length) return { ok: true, added: [], skipped: plan.skip };
		const next = JSON.parse(JSON.stringify(live));   // deep copy: never mutate the live object
		const copies = JSON.parse(JSON.stringify(add));
		// Reorder the COPY's fields, never the live ones: the result is what gets
		// written, and it must not hold references into the collection's own
		// live config object.
		next.fields = order
			? this._orderedFields(next.fields, copies, order, exclude)
			: next.fields.concat(copies);
		const ok = await col.api.saveConfiguration(next);
		return { ok: !!ok, added: add, skipped: plan.skip };
	}

	/* Reordering is the plugin's one structural exception, and it has a trap:
	 * system and archived entries are NOT all at the ends. Measured across this
	 * workspace, Groceries reads USSSSUSUSUS and Person UUUUUUUSSSSUUSUUU, so
	 * rebuilding `fields` as "everything unorderable, then the ordered list"
	 * would quietly move seven of them in one collection.
	 *
	 * So: an unorderable entry is anchored to the NUMBER of orderable entries
	 * that preceded it originally, and is put back after that many. Its
	 * neighbours change, its position in the sequence of user fields does not. */
	_orderedFields(liveFields, added, order, exclude) {
		const orderable = new Set(this._userFields({ fields: liveFields }).map((f) => f.id));
		// The spine: the user's chosen order, resolved back to real field
		// objects. Anything unticked on step 2 is simply absent from it.
		const byId = new Map();
		for (const f of liveFields) byId.set(f.id, f);
		for (const f of added) byId.set(f.id, f);
		const spine = [];
		for (const o of order) {
			if (exclude && exclude.has(o.id) && !liveFields.some((f) => f.id === o.id)) continue;
			const f = byId.get(o.id);
			if (f) { spine.push(f); byId.delete(o.id); }
		}
		// Anything the order list never mentioned (a field added to the
		// collection elsewhere while the dialog was open) keeps its place at the
		// end of the spine rather than being dropped. Same for a new field the
		// list somehow missed: never write a config that loses one.
		for (const f of liveFields) if (orderable.has(f.id) && byId.has(f.id)) spine.push(byId.get(f.id));
		for (const f of added) if (byId.has(f.id)) { spine.push(byId.get(f.id)); byId.delete(f.id); }

		const anchored = [];
		let seen = 0;
		for (const f of liveFields) {
			if (orderable.has(f.id)) seen++;
			else anchored.push({ field: f, after: seen });
		}
		const out = [];
		let placed = 0;
		const drain = () => {
			while (anchored.length && anchored[0].after <= placed) out.push(anchored.shift().field);
		};
		drain();
		for (const f of spine) { out.push(f); placed++; drain(); }
		for (const a of anchored) out.push(a.field);
		return out;
	}

	// ══════════════════════════════════════════════════════════════════════
	// Small helpers
	// ══════════════════════════════════════════════════════════════════════

	_norm(s) { return String(s == null ? "" : s).trim().toLowerCase(); }

	_esc(s) { return this.ui.htmlEscape(String(s == null ? "" : s)); }

	/** ui.$html() returns only the FIRST element of the markup it is given, so a
	 *  multi-root string silently loses everything after the first node — which
	 *  in a CSS grid shifts every cell into the wrong column. Append each. */
	_add(parent, html) {
		const t = document.createElement("template");
		t.innerHTML = html;
		while (t.content.firstChild) parent.appendChild(t.content.firstChild);
		return parent;
	}

	/** The shared destination picker's contract, so every list in these plugins
	 *  ranks the same way: `+` is an AND, every part must appear, and the parts'
	 *  scores are summed. See SHARED-DESTINATION-PICKER.md. */
	_matchScore(text, q) {
		const parts = String(q || "").split("+").map((x) => x.trim()).filter(Boolean);
		if (!parts.length) return 1;
		let total = 0;
		for (const part of parts) {
			const sc = this._score(text, part);
			if (!sc) return 0;                     // AND: one miss and the row is out
			total += sc;
		}
		return total;
	}

	/** Rank a list the shared picker's way: score descending, then the shorter
	 *  label, then alphabetically.
	 *
	 *  With NO query the list is returned in the order it came in, which is
	 *  alphabetical. Ranking an unfiltered list scores every row the same, so
	 *  the tie-break becomes the primary sort and a picker opens ordered by
	 *  label LENGTH — which is what made this list look shuffled. */
	_rankRows(rows, q, labelOf) {
		if (!String(q || "").trim()) return rows.slice();
		return rows
			.map((r) => ({ r, sc: this._matchScore(labelOf(r), q) }))
			.filter((x) => x.sc > 0)
			.sort((a, b) => b.sc - a.sc ||
				labelOf(a.r).length - labelOf(b.r).length ||
				labelOf(a.r).localeCompare(labelOf(b.r)))
			.map((x) => x.r);
	}

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
		// The page the user is looking at, read BEFORE the overlay exists: Fill
		// From Title acts on it, and the active panel is still the one under
		// the caret at this point.
		const fillTarget = this._fillTarget();
		const cols = await this._collections();
		const colNames = {};
		for (const c of cols) colNames[c.guid] = c.name;
		// `tplIds` and `targetGuids` are sets because both halves of step 1 are
		// multi-select: several templates can go into several collections in one
		// pass. `exclude` is the per-apply opt-out from step 2, keyed per TARGET
		// collection, because ordering is per collection and so is leaving a
		// field out of one.
		this._state = { screen, cols, colNames,
			store: this._loadStore(),
			propKeys: new Set(), tplIds: new Set(), targetGuids: new Set(),
			step: 1, query: "", colQuery: "",
			order: {}, orderCol: null, dragIdx: null, exclude: {},
			tplEditing: null, tplDraft: "", tplAdding: null, tplAddQuery: "",
			newTpl: null,
			vModel: null, vTab: "collections", vSel: null, rulesMode: "inherit",
			vDirty: false, vSaved: false, pop: null, popAdd: false, popQ: "", popActive: 0, recCache: {},
			clash: undefined, pendingField: null, busy: false,
			changeName: null, changeSrcKey: null, changeSkip: new Set(),
			changeConfirm: false, costOpen: null, costCache: {}, syncedNames: null,
			rearSel: null, rearOrder: {}, rearQ: "", rearDirty: false,
			fillTarget, fill: null, fillOff: new Set(), fillPick: {}, fillSel: {}, fillLast: {},
			filledOpen: false, kw: null, kwDraft: null };

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
		// Clicking anywhere outside an open popover closes it. Capture phase so
		// it runs before the thing that was clicked, and anything inside a
		// .gp-anchor is ignored (that is the popover and its trigger).
		this._onDown = (e) => {
			const s = this._state;
			if (!s || !s.pop) return;
			const tgt = e.target;
			if (!tgt || !tgt.closest) return;
			// Only the anchor that OWNS the open popover is safe ground; every
			// row on the fill screens is an anchor, and treating them all as
			// safe meant a click in another row closed nothing. A trigger is
			// also let through: its own click handler switches the popover.
			const a = tgt.closest(".gp-anchor");
			if (a && a.querySelector(".gp-pop")) return;
			if (tgt.closest(".gp-fchevbtn, .gp-ffieldpick, .gp-kaddbtn, .gp-trigger, .gp-dashed, .gp-costcell")) return;
			s.pop = null; s.popAdd = false;
			this._render();
		};
		ovl.addEventListener("mousedown", this._onDown, true);
		// A tooltip layer of our own, because the native `title` attribute is
		// unreliable in Thymer's Electron shell. That is not a guess: the plugin
		// this screen absorbed hit it and shipped its own tooltip for exactly
		// this reason, in a comment left in its source. Delegated from the
		// overlay so it survives every redraw of the table underneath.
		ovl.addEventListener("mouseover", (e) => {
			const t = e.target && e.target.closest ? e.target.closest("[data-gptip]") : null;
			if (t === this._tipFor) return;
			this._tipFor = t;
			if (t) this._showTip(t); else this._hideTip();
		});
		document.body.appendChild(ovl);
		this._ovl = ovl;

		// Capture phase, because Thymer swallows Escape inside the editor. That
		// also means this runs BEFORE any handler on an element inside the
		// dialog, so stopPropagation() in a child cannot protect that child:
		// anything with its own Escape meaning has to be handled right here.
		this._onKey = (e) => {
			const st = this._state;
			// Recording a new Fill shortcut swallows everything until a real
			// chord (or Escape) arrives. It has to live HERE: this listener was
			// registered first, so it is the one that sees Escape before the
			// close-the-dialog branch below does.
			if (st && st.shortcutCapture) {
				e.preventDefault();
				e.stopPropagation();
				if (e.key === "Escape") { st.shortcutCapture = false; this._render(); return; }
				if (["Shift", "Meta", "Alt", "Control"].indexOf(e.key) !== -1) return;
				if (!e.metaKey && !e.ctrlKey && !e.altKey) return;   // a bare letter is typing, not a chord
				st.scDraft = { key: e.key.toLowerCase(), meta: e.metaKey, shift: e.shiftKey,
					alt: e.altKey, ctrl: e.ctrlKey };
				st.shortcutCapture = false;
				this._render();
				return;
			}
			if (e.key !== "Escape") {
				// Enter applies the ticked values on the Fill screen, wherever
				// focus sits: the hand has just come off the shortcut chord, so
				// it is still in the editor behind the dialog. A popover open
				// -> Enter belongs to the picker. A button, link or input
				// focused inside the dialog -> Enter belongs to that control.
				if (e.key !== "Enter" || !st || st.screen !== "fill" || st.busy || st.pop) return;
				const tgt = e.target;
				if (!tgt || tgt.nodeType !== 1) return;
				if (this._ovl && this._ovl.contains(tgt) && tgt.closest &&
					tgt.closest("button, a, input, textarea, select")) return;
				const picked = this._fillPicked();
				if (!picked.length) return;
				e.preventDefault();
				e.stopPropagation();
				this._doFill(picked);
				return;
			}
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
		this._hideTip();
		this._tipFor = null;
		if (this._onKey) { window.removeEventListener("keydown", this._onKey, true); this._onKey = null; }
		if (this._ovl) { this._ovl.remove(); this._ovl = null; }
		this._state = null;
		// Hand keyboard focus back to the editor WITHOUT moving the caret. A
		// dialog that stole focus and merely removes itself leaves the editor
		// dead to typing.
		try { window.g_virtual_input.$textarea.focus(); } catch (e) {}
	}

	_panel() { return this._ovl ? this._ovl.querySelector(".gp-panel") : null; }

	/** The tooltip is appended to BODY, never into the panel. The panel carries
	 *  `zoom`, and a fixed child of a zoomed element reads left/top in the zoomed
	 *  coordinate space while getBoundingClientRect reports real viewport pixels
	 *  — the same trap _placePop divides its way out of from the inside. Outside
	 *  the panel the two agree and no correction is needed. */
	_showTip(el) {
		this._hideTip();
		const text = el.getAttribute("data-gptip");
		if (!text) return;
		const tip = document.createElement("div");
		tip.className = "gp-tip";
		tip.textContent = text;
		document.body.appendChild(tip);
		this._tip = tip;
		const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect();
		const left = Math.max(8, Math.min(r.left + r.width / 2 - t.width / 2,
			window.innerWidth - t.width - 8));
		// Above the header, flipping under it when there is no room, the way the
		// popovers flip.
		const above = r.top - t.height - 8;
		tip.style.left = Math.round(left) + "px";
		tip.style.top = Math.round(above < 8 ? r.bottom + 8 : above) + "px";
		// setTimeout, not requestAnimationFrame: rAF is suspended while the
		// window is occluded and the tip would never fade in.
		setTimeout(() => tip.classList.add("is-in"), 10);
	}

	_hideTip() {
		if (this._tip) { this._tip.remove(); this._tip = null; }
	}

	/* One modal, two jobs, named in the sidebar: PROPERTIES decides which fields a
	 * collection has; NEW RECORDS decides how they fill themselves in. Change is
	 * deliberately NOT a nav item — you only learn a definition has drifted while
	 * looking at that property, so it is entered from the Add row that already
	 * knows, which fixes the direction for free. */
	static TICK = "\u2713";
	static CARET = "\u2304";

	/* What the three toggle columns mean. Carried over from Auto-Init From
	 * Ancestor, which had them and which this screen absorbed: the columns are
	 * the one part of this dialog whose headers cannot say enough on their own.
	 * Its wording, widened from "this field" to the column, because here the tip
	 * hangs off the header rather than off one row's toggle. */
	static TIPS = {
		value: "Copy the ancestor's value from its matching field into the new record.",
		link: "Link the ancestor record itself into this field.",
		filter: "A record field can be set to only link records from one collection. " +
			"Turn this on to link the ancestor anyway, even when it comes from another one.",
	};

	/* Missing from Thymer's tabler subset, probed 2026-08-17, do not reach for
	 * them: ti-arrows-sort, ti-arrows-up-down, ti-git-branch, ti-template,
	 * ti-hierarchy, ti-arrows-move-vertical. */
	static COMMANDS = [
		{ screen: "apply", label: "Add Properties", icon: "ti-library-plus" },
		{ screen: "manage", label: "Templates", icon: "ti-stack" },
		{ screen: "rearrange", label: "Rearrange", icon: "ti-sort-ascending" },
		{ screen: "values", label: "Inherited Values", icon: "ti-arrow-down" },
		{ screen: "defaults", label: "Default Values", icon: "ti-flag" },
		{ screen: "fill", label: "Fill From Title", icon: "ti-wand" },
	];

	static NAV = [
		{ group: "PROPERTIES", items: [
			{ id: "apply", label: "Add Properties" },
			{ id: "manage", label: "Templates" },
			{ id: "rearrange", label: "Rearrange" },
		] },
		{ group: "NEW RECORDS", items: [
			{ id: "values", label: "Inherited Values" },
			{ id: "defaults", label: "Default Values" },
			{ id: "fill", label: "Fill From Title" },
		] },
	];

	_render() {
		const p = this._panel(), s = this._state;
		if (!p || !s) return;
		const screens = { apply: "_renderApply", manage: "_renderManage",
			values: "_renderValues", defaults: "_renderDefaults", change: "_renderChange",
			rearrange: "_renderRearrange", fill: "_renderFill", fillkw: "_renderFillKeywords",
			fillauto: "_renderFillAuto" };
		p.innerHTML = "";
		// Two breakpoints, measured off the window rather than media queries: the
		// modal is our own overlay, so usable width is the window minus its padding.
		const usable = window.innerWidth - 48;
		p.classList.toggle("is-narrow", usable < 780);
		p.classList.toggle("is-tight", usable < 900);

		p.appendChild(this._frameHead());
		const shell = document.createElement("div");
		shell.className = "gp-shell";
		shell.appendChild(this._nav());
		// The screen root IS the content column: every panel owns its own padding
		// and pins its own footer with margin-top:auto, exactly as the design file
		// draws it. A padded wrapper here would double every inset by 24px.
		const content = document.createElement("div");
		content.className = "gp-content";
		shell.appendChild(content);
		p.appendChild(shell);

		this[screens[s.screen] || "_renderApply"](content);
	}

	_frameHead() {
		const h = document.createElement("div");
		h.className = "gp-frame-head";
		const ver = (this.getConfiguration() || {}).version;
		h.innerHTML = '<div class="gp-frame-title">Global Properties</div>' +
			(ver ? '<div class="gp-frame-ver">' + this._esc(ver) + "</div>" : "");
		return h;
	}

	/* The chevron is an inline SVG, never a text glyph. U+2304 carries no
	 * reliable metrics: it sits off the optical centre of its line box by a
	 * different amount in every font, so it cannot be centred against a label
	 * next to it. The design draws a 10x6 stroke inside a 12x12 flex-centred
	 * box, which centres exactly and scales with nothing. */
	static CHEVRON = '<span class="gp-chev"><svg width="10" height="6" viewBox="0 0 10 6" ' +
		'fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 1L5 5L9 1" ' +
		'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ' +
		'stroke-linejoin="round"></path></svg></span>';

	/** A drawn tick box. Sizes come from the design per column (17 for the two
	 *  wide toggles, 13 for Ignore filter, 15 in lists, 14 in the order rows),
	 *  and the glyph steps down with it. */
	/** A column header that has an explanation behind it. The dashed underline
	 *  is the plugin's existing "hover this for more" mark — the record cost on
	 *  the Change screen already wears it — rather than a second idiom invented
	 *  for the same job. It sits on the WORDS, not on the grid cell, so it
	 *  tracks the label when the headers shorten under ~900px, and it leaves the
	 *  header row free of an extra glyph exactly where space is tightest.
	 *  Resting state marks it, hover brightens it. */
	_tipHead(tip, labelHtml) {
		return '<div class="gp-caps gp-caps-flat gp-mid" data-gptip="' + this._esc(tip) + '">' +
			'<span class="gp-tiplabel">' + labelHtml + "</span></div>";
	}

	_cb(on, size) {
		// Thymer's own tick, not the text glyph U+2713. The app draws every
		// checkmark from its tabler subset, and `ti-check` is in it (probed), so
		// borrowing it makes the box read as one of the host's rather than as
		// something this plugin drew. The warn box keeps its own colour.
		return '<span class="gp-cb gp-cb-' + size + (on ? " is-on" : "") + '">' +
			(on ? '<span class="ti ti-check"></span>' : "") + "</span>";
	}

	/** Badges are DERIVED, never literals: templates counted, and collections that
	 *  actually carry a rule of that kind. */
	_navBadge(id) {
		const s = this._state;
		if (id === "manage") return (s.store.templates || []).length || "";
		const rules = s.rules || (s.rules = this._loadRules());
		if (id === "values") {
			return new Set(rules.rules.filter((r) => r.fromAncestorValue || r.linkAncestor)
				.map((r) => r.colGuid)).size || "";
		}
		if (id === "defaults") {
			return new Set(rules.rules.filter((r) => r.fixed).map((r) => r.colGuid)).size || "";
		}
		return "";
	}

	_nav() {
		const s = this._state;
		const narrow = this._panel().classList.contains("is-narrow");
		const nav = document.createElement("div");
		nav.className = "gp-nav";
		let first = true;
		for (const g of Plugin.NAV) {
			// Narrow mode is not the sidebar with different padding: the design
			// makes each group a caps label with underline TABS beside it, so the
			// two groups sit on one line. Wrapping each group keeps them together.
			const host = narrow ? document.createElement("div") : nav;
			if (narrow) { host.className = "gp-navgroup"; nav.appendChild(host); }
			const label = document.createElement("div");
			label.className = "gp-navlabel" + (first || narrow ? "" : " is-later");
			label.textContent = g.group;
			host.appendChild(label);
			first = false;
			for (const it of g.items) {
				const b = document.createElement("button");
				const on = s.screen === it.id ||
					(it.id === "fill" && (s.screen === "fillkw" || s.screen === "fillauto"));
				b.className = (narrow ? "gp-navtab" : "gp-navitem") + (on ? " is-on" : "");
				const badge = this._navBadge(it.id);
				b.innerHTML = "<span>" + this._esc(it.label) + "</span>" +
					(badge ? '<span class="gp-navbadge">' + badge + "</span>" : "");
				b.addEventListener("click", () => {
					if (s.screen === it.id) return;
					s.screen = it.id;
					s.step = 0;
					s.pop = null; s.popAdd = false; s.popQ = "";
					// Entering Inherited Values from the nav always resets to
					// Collections, per the design.
					s.vTab = "collections"; s.pendingField = null;
					this._render();
				});
				host.appendChild(b);
			}
		}
		if (!narrow) {
			const spacer = document.createElement("div");
			spacer.className = "gp-navspacer";
			nav.appendChild(spacer);
			const foot = document.createElement("div");
			foot.className = "gp-navfoot";
			foot.textContent = "Properties decides which fields a collection has. " +
				"New Records decides how they fill themselves in.";
			nav.appendChild(foot);
		}
		return nav;
	}

	/** Screen scaffolding, shared by all four panels: a column that fills the
	 *  shell, a head block, a scrolling middle, and a footer pinned to the
	 *  bottom. The footer must be a SIBLING of the scroller, never inside it —
	 *  inside, Cancel and Save scroll off the end of a long table. */
	_screen(parent, cls) {
		const el = document.createElement("div");
		el.className = "gp-screen" + (cls ? " " + cls : "");
		parent.appendChild(el);
		return el;
	}

	_padTop(parent) {
		const d = document.createElement("div");
		d.className = "gp-padtop";
		parent.appendChild(d);
		return d;
	}

	/** The middle band. The design file has no cap on it because a web page
	 *  simply grows; inside a modal capped at 760px it has to scroll, so the
	 *  band owns the overflow and the head and footer stay put. */
	_padScroll(parent) {
		const d = document.createElement("div");
		d.className = "gp-pad gp-scroll";
		parent.appendChild(d);
		return d;
	}

	/** Footer bar: a note at the left end, actions at the right. */
	_bar(parent, noteHtml) {
		const bar = document.createElement("div");
		bar.className = "gp-footbar";
		bar.innerHTML = noteHtml || "<div></div>";
		const acts = document.createElement("div");
		acts.className = "gp-footacts";
		bar.appendChild(acts);
		parent.appendChild(bar);
		return acts;
	}

	/** A quiet text button (Back, Cancel, Done Adding). */
	_quiet(parent, label, fn) {
		const b = document.createElement("button");
		b.className = "gp-quiet";
		b.textContent = label;
		b.addEventListener("click", fn);
		parent.appendChild(b);
		return b;
	}

	/** The accent button. Disabled is a real state in the design — a dimmed
	 *  label on a faint plate, not the whole button at 40% opacity. */
	_primary(parent, label, fn, enabled) {
		const b = document.createElement("button");
		b.className = "gp-primary";
		b.textContent = label;
		b.disabled = enabled === false;
		b.addEventListener("click", (e) => { if (!b.disabled) fn(e); });
		parent.appendChild(b);
		return b;
	}

	/** A search input in the design's own style: Space Mono, chip surface. */
	_search(parent, placeholder, value, onInput) {
		const inp = document.createElement("input");
		inp.className = "gp-search";
		inp.type = "text";
		inp.placeholder = placeholder;
		inp.value = value || "";
		inp.addEventListener("keydown", (e) => e.stopPropagation());
		inp.addEventListener("input", () => onInput(inp.value));
		parent.appendChild(inp);
		return inp;
	}


	// ══════════════════════════════════════════════════════════════════════
	// Default Values
	// ══════════════════════════════════════════════════════════════════════
	// The creation engine
	//
	// Ported from Auto-Init From Ancestor rather than rewritten. Every guard
	// here was paid for by a bug: the isLocal check (never react to a sync-in
	// from another device), the staleness window (a record you opened an hour
	// ago is not "where you are"), the retry loop (the record does not exist
	// yet at the moment the event fires), and reading each record's collection
	// from its OWN `collection` property (panel.getActiveCollection() returns
	// null in the Journal). Change these only with a reproduction in hand.
	// ══════════════════════════════════════════════════════════════════════

	_STALE_MS = 30 * 1000;
	_ancestorGuid = null;
	_ancestorTouchedAt = 0;
	_ancestorCollectionGuid = null;
	_collectionsByGuid = new Map();

	_hookCreation() {
		try {
			this.events.on("panel.navigated", (ev) => this._rememberFromPanel(ev.panel));
			this.events.on("panel.focused", (ev) => this._rememberFromPanel(ev.panel));
		} catch (e) {}
		try { this._rememberFromPanel(this.ui.getActivePanel()); } catch (e) {}
		this.events.on("record.created", (ev) => this._onRecordCreated(ev));
	}

	_rememberFromPanel(panel) {
		if (!panel) return;
		if (panel.getType && panel.getType() !== "edit_panel") return;
		if (panel.isSidebar && panel.isSidebar()) return;
		const rec = panel.getActiveRecord && panel.getActiveRecord();
		if (!rec) return;
		this._ancestorGuid = rec.guid;
		this._ancestorTouchedAt = Date.now();
		try {
			const coll = panel.getActiveCollection && panel.getActiveCollection();
			this._ancestorCollectionGuid = coll ? (coll.guid || (coll.getGuid && coll.getGuid())) : null;
			if (coll && this._ancestorCollectionGuid) {
				this._collectionsByGuid.set(this._ancestorCollectionGuid, coll);
			}
		} catch (e) { this._ancestorCollectionGuid = null; }
	}

	_resolveAncestor(newGuid) {
		if (this._ancestorGuid && this._ancestorGuid !== newGuid) {
			if (Date.now() - this._ancestorTouchedAt <= this._STALE_MS) return this._ancestorGuid;
		}
		const panels = this.ui.getPanels ? this.ui.getPanels() : [];
		for (const p of panels) {
			if (p.getType && p.getType() !== "edit_panel") continue;
			const ar = p.getActiveRecord && p.getActiveRecord();
			if (ar && ar.guid !== newGuid) return ar.guid;
		}
		return null;
	}

	/** A record's own collection guid, from its `collection` system property. */
	_recordCollectionGuid(record) {
		try {
			const p = record && record.prop && record.prop("collection");
			const c = p && p.choice ? p.choice() : null;
			return c || null;
		} catch (e) { return null; }
	}

	_ancestorCollection() {
		const g = this._ancestorCollectionGuid;
		return (g && this._collectionsByGuid.has(g)) ? this._collectionsByGuid.get(g) : null;
	}

	/** The rules that apply to one collection: its own, plus every all-collections
	 *  rule that it does not already override. Keyed by field id, in the shape
	 *  the apply loop wants. */
	_rulesFor(colGuid, store) {
		const out = {};
		for (const r of (store.rules || [])) {
			if (r.colGuid && r.colGuid !== colGuid) continue;
			if (r.colGuid === null && out[r.fieldId]) continue;   // specific wins over All
			if (r.colGuid) out[r.fieldId] = r; else if (!out[r.fieldId]) out[r.fieldId] = r;
		}
		return out;
	}

	_onRecordCreated(ev) {
		if (!ev || !ev.source || !ev.source.isLocal) return;      // never react to a sync-in
		const newGuid = ev.recordGuid;
		if (!newGuid) return;
		// Autofill rides the same event but is otherwise independent of the
		// rules: it has its own opt-in, its own delay, and it must run even in
		// a workspace with no rules at all.
		this._scheduleAutofill(newGuid);
		// No switch: rules exist, they apply. Nothing to configure, nothing to
		// forget to turn back on.
		const store = this._rulesCache || (this._rulesCache = this._loadRules());
		if (!store.rules.length) return;

		let newCollection = null;
		try { if (ev.getCollection) newCollection = ev.getCollection(); } catch (e) {}
		const newCollectionGuid = ev.collectionGuid || (newCollection && newCollection.guid) || null;

		const rules = newCollectionGuid ? this._rulesFor(newCollectionGuid, store) : null;
		if (!rules || !Object.keys(rules).length) return;

		/* EXCLUSION GOVERNS INHERITANCE ONLY. Parham's call, 2026-08-17, and it
		 * is why Excluded lives inside Inherited Values rather than beside it.
		 *
		 * It used to abandon the record outright, which meant creating an Action
		 * while standing in the Journal — an excluded collection — threw away the
		 * Action Status default too, even though a fixed default has nothing to
		 * do with the ancestor. Excluding now suppresses the two inheriting
		 * sources and nothing else; a default is unconditional, exactly as the
		 * Default Values panel promises. */
		const excluded = !!(newCollectionGuid && store.blocklist.indexOf(newCollectionGuid) !== -1);
		const hasFixed = Object.values(rules).some((r) => r.fixed);
		const needsAncestor = !excluded &&
			Object.values(rules).some((r) => r.fromAncestorValue || r.linkAncestor);
		let ancestorGuid = needsAncestor ? this._resolveAncestor(newGuid) : null;
		if (ancestorGuid === newGuid) ancestorGuid = null;
		if (!ancestorGuid && !hasFixed) return;      // nothing left that could apply
		this._applyWithRetry(newGuid, ancestorGuid, newCollection, newCollectionGuid, rules, store, 0);
	}

	_applyWithRetry(newGuid, ancestorGuid, newCollection, newCollectionGuid, rules, store, attempt) {
		const MAX_ATTEMPTS = 20, DELAY_MS = 50;      // ~1s: the record may not exist yet
		const newRecord = this.data.getRecord(newGuid);
		const ancestor = ancestorGuid ? this.data.getRecord(ancestorGuid) : null;
		if (!newRecord || (ancestorGuid && !ancestor)) {
			if (attempt >= MAX_ATTEMPTS) return;
			setTimeout(() => this._applyWithRetry(newGuid, ancestorGuid, newCollection,
				newCollectionGuid, rules, store, attempt + 1), DELAY_MS);
			return;
		}
		// Blocklist against each record's OWN collection property, both sides.
		// Dropping the ANCESTOR is what exclusion does now — not abandoning the
		// record. Both inheriting branches in _applyRules are gated on having an
		// ancestor, so a null one disables exactly them and leaves fixed
		// defaults to apply.
		const newColl2 = this._recordCollectionGuid(newRecord) || newCollectionGuid;
		const ancColl2 = ancestor ? (this._recordCollectionGuid(ancestor)
			|| ((ancestorGuid === this._ancestorGuid) ? this._ancestorCollectionGuid : null)) : null;
		const blocked = (newColl2 && store.blocklist.indexOf(newColl2) !== -1) ||
			(ancColl2 && store.blocklist.indexOf(ancColl2) !== -1);
		const effAncestor = blocked ? null : ancestor;

		this._withCollection(newCollection, newCollectionGuid, (newColl) => {
			if (!newColl) return;
			this._applyRules(newRecord, effAncestor, newColl, rules);
		});
	}

	_withCollection(maybeColl, guid, cb) {
		if (maybeColl) return cb(maybeColl);
		if (!guid) return cb(null);
		if (this._collectionsByGuid.has(guid)) return cb(this._collectionsByGuid.get(guid));
		try {
			Promise.resolve(this.data.getAllCollections()).then((list) => {
				for (const c of (list || [])) {
					const g = c && (c.guid || (c.getGuid && c.getGuid()));
					if (g) this._collectionsByGuid.set(g, c);
				}
				cb(this._collectionsByGuid.get(guid) || null);
			}).catch(() => cb(null));
		} catch (e) { cb(null); }
	}

	_applyRules(newRecord, ancestor, newColl, rules) {
		const newConfig = newColl.getConfiguration ? newColl.getConfiguration() : null;
		if (!newConfig) return;
		const ancestorColl = this._ancestorCollection();
		const ancestorConfig = ancestorColl && ancestorColl.getConfiguration
			? ancestorColl.getConfiguration() : null;
		const sameCollection = ancestorColl && newColl && ancestorColl.guid === newColl.guid;

		const ancestorFieldsByLabel = new Map();
		if (ancestorConfig && Array.isArray(ancestorConfig.fields)) {
			for (const af of ancestorConfig.fields) {
				if (!af.active || !af.label) continue;
				const key = af.label.trim().toLowerCase();
				if (!ancestorFieldsByLabel.has(key)) ancestorFieldsByLabel.set(key, af);
			}
		}
		const fieldById = new Map();
		for (const f of (newConfig.fields || [])) if (f.active) fieldById.set(f.id, f);

		for (const fieldId of Object.keys(rules)) {
			const rule = rules[fieldId] || {};
			const field = fieldById.get(fieldId);
			if (!field || field.read_only || field.type === "dynamic") continue;
			const childProp = newRecord.prop(fieldId);
			if (!childProp) continue;
			// Never overwrite: a value already there wins over any rule.
			if (!this._isEmpty(childProp, field.type)) continue;

			let didApply = null;

			if (rule.fromAncestorValue && ancestor) {
				let ancestorField = null;
				if (sameCollection) {
					ancestorField = (ancestorConfig && Array.isArray(ancestorConfig.fields))
						? ancestorConfig.fields.find((f) => f.id === fieldId && f.active) : null;
				} else if (field.label) {
					ancestorField = ancestorFieldsByLabel.get(field.label.trim().toLowerCase()) || null;
				}
				if (ancestorField && ancestorField.type === field.type) {
					const srcProp = ancestor.prop(ancestorField.id);
					if (srcProp && !this._isEmpty(srcProp, ancestorField.type)) {
						this._copyValue(childProp, srcProp, field.type, field, field.filter_colguid || null);
						didApply = "ancestor-value";
					}
				}
			}

			if (!didApply && rule.linkAncestor && ancestor && field.type === "record") {
				const ancestorCollGuid = this._recordCollectionGuid(ancestor);
				const allowed = this._linkAllowedByCollection(field, ancestorCollGuid);
				if (rule.ignoreFilter || allowed) {
					childProp.set(ancestor.guid);
					didApply = "ancestor-self";
				}
			}

			// The fixed value is the FALLBACK: inherit if you can, otherwise use
			// this. A rule carrying only a fixed value therefore always applies.
			if (!didApply && rule.fixed) {
				if (this._applyFixed(childProp, field, rule.fixed)) didApply = "fixed";
			}
		}
	}

	/** Fixed values are stored as a kind plus a value, and TOKENS are resolved
	 *  here, at creation. Storing a resolved date when the rule was written
	 *  would freeze "@today" to the day you configured it. */
	_applyFixed(prop, field, fixed) {
		try {
			if (fixed.kind === "token") {
				const dt = DateTime.parseDateTimeString(String(fixed.value || "").replace(/^@/, ""));
				if (!dt) return false;
				prop.set(dt.value());
				return true;
			}
			if (fixed.kind === "record") {
				if (field.type !== "record") return false;
				// ALWAYS an array, single-value fields included. types.d.ts says a
				// bare value is accepted; it is stale on this API, and the
				// measured form for writing a record property is set([...]).
				// An array also replaces every existing value either way.
				prop.set([fixed.value]);
				return true;
			}
			if (fixed.kind === "choice") {
				if (field.type !== "choice") return false;
				prop.setChoice([fixed.value]);
				return true;
			}
			if (fixed.kind === "number") { prop.set(Number(fixed.value)); return true; }
			if (fixed.kind === "text") { prop.set(String(fixed.value)); return true; }
		} catch (e) {}
		return false;
	}

	_linkAllowedByCollection(field, ancestorCollectionGuid) {
		if (!field.filter_colguid) return true;
		if (!ancestorCollectionGuid) return true;
		return field.filter_colguid === ancestorCollectionGuid;
	}

	_isEmpty(prop, type) {
		if (type === "file" || type === "image" || type === "banner") return prop.file() === null;
		if (type === "datetime") return prop.date() === null;
		if (type === "choice") return prop.choice() === null;
		if (type === "number") return prop.number() === null;
		if (type === "user") return prop.user() === null;
		if (type === "record") return prop.linkedRecord() === null;
		return prop.text() === null;
	}

	_copyValue(target, source, type, targetField, linkFilterGuid) {
		const many = !!(targetField && targetField.many);
		switch (type) {
			case "number": {
				if (many && source.numbers) { const a = source.numbers(); if (a && a.length) target.set(a); }
				else target.set(source.number());
				break;
			}
			case "choice": {
				const choices = source.selectedChoices();
				if (choices && choices.length) target.setChoice(choices);
				break;
			}
			case "datetime": {
				if (many && source.datetimes) {
					const arr = source.datetimes(); const values = [];
					for (let i = 0; i < (arr || []).length; i++) {
						const v = arr[i] && arr[i].value ? arr[i].value() : null;
						if (v) values.push(v);
					}
					if (values.length) target.set(values);
				} else { const dt = source.datetime(); if (dt) target.set(dt.value()); }
				break;
			}
			case "user": {
				if (many && source.users) {
					const arr = source.users(); const guids = [];
					for (let i = 0; i < (arr || []).length; i++) if (arr[i] && arr[i].guid) guids.push(arr[i].guid);
					if (guids.length) target.set(guids);
				} else { const u = source.user(); if (u) target.set(u.guid); }
				break;
			}
			case "record": {
				const records = (many && source.linkedRecords) ? source.linkedRecords()
					: (source.linkedRecord() ? [source.linkedRecord()] : []);
				if (!records || !records.length) break;
				const guids = [];
				for (let i = 0; i < records.length; i++) {
					const r = records[i];
					if (!r || !r.guid) continue;
					if (linkFilterGuid) {
						const rc = this._collectionForRecord(r);
						const rcGuid = rc && (rc.guid || (rc.getGuid && rc.getGuid()));
						if (rcGuid && rcGuid !== linkFilterGuid) continue;
					}
					guids.push(r.guid);
				}
				if (!guids.length) break;
				if (many) target.set(guids); else target.set(guids[0]);
				break;
			}
			case "file": case "image": case "banner": {
				const f = source.file(); if (f) target.setFile(f);
				break;
			}
			default: {
				if (many && source.texts) { const a = source.texts(); if (a && a.length) target.set(a); }
				else target.set(source.text());
				break;
			}
		}
	}

	_collectionForRecord(record) {
		if (!record) return null;
		try { if (record.getCollection) return record.getCollection(); } catch (e) {}
		const g = record.collectionGuid || (record.getCollectionGuid && record.getCollectionGuid());
		if (g && this._collectionsByGuid.has(g)) return this._collectionsByGuid.get(g);
		return null;
	}

	// ══════════════════════════════════════════════════════════════════════
	// Values on Create  (rules store + import from Auto-Init From Ancestor)
	// ══════════════════════════════════════════════════════════════════════

	/* A rule says where ONE property's opening value comes from, for one
	 * collection (or all of them). The flags mirror Auto-Init's exactly rather
	 * than collapsing into a single "source" enum, because 10 of Parham's 58
	 * real rules use COMBINATIONS (value+self, value+self+ignoreFilter): an enum
	 * cannot hold them and the migration would silently drop behaviour.
	 *
	 *   { colGuid|null, colName, fieldId, label,
	 *     fromAncestorValue, linkAncestor, ignoreFilter, fixed|null }
	 *
	 * colGuid null means every collection. `fixed` is the new static default
	 * ({kind:"token"|"literal", value}); tokens like @today are resolved AT
	 * CREATION, never captured when the rule is written.
	 *
	 * NOTHING APPLIES THESE YET. The engine that listens to record.created is
	 * deliberately not wired until the imported rules have been seen and the old
	 * plugin has been turned off, because two listeners writing the same
	 * properties on the same event is how data got corrupted before. */
	static RULES_KEY = "property_rules";

	_loadRules() {
		let r = null;
		try {
			const cfg = this.getConfiguration();
			r = (cfg && cfg.custom && cfg.custom[Plugin.RULES_KEY]) || null;
		} catch (e) {}
		return r && Array.isArray(r.rules)
			? r : { rev: 0, enabled: false, blocklist: [], rules: [] };
	}

	/** The installed Auto-Init plugin, found by the shape of its config rather
	 *  than by name, so a renamed install is still recognised. */
	async _findAutoInit() {
		const all = await this.data.getAllGlobalPlugins() || [];
		for (const p of all) {
			let cfg = null;
			try { cfg = p.getConfiguration(); } catch (e) { continue; }
			const ai = cfg && cfg.custom && cfg.custom.autoInit;
			if (ai && ai.collections) return { api: p, cfg, ai };
		}
		return null;
	}

	/** Structural, field-by-field. Verified lossless against the live config:
	 *  58 rules in, 58 out, round-trip identical. */
	_migrateAutoInit(ai) {
		const rules = [];
		for (const [colGuid, col] of Object.entries(ai.collections || {})) {
			for (const [fieldId, f] of Object.entries(col.fields || {})) {
				rules.push({
					colGuid, colName: col.name || null, fieldId, label: f.label || null,
					fromAncestorValue: !!f.useAncestorValue,
					linkAncestor: !!f.useAncestorSelf,
					ignoreFilter: !!f.forceSelfIgnoreFilter,
					fixed: null,
				});
			}
		}
		return { rev: 0, enabled: false, blocklist: (ai.blocklist || []).slice(), rules };
	}

	_ruleSource(r) {
		if (r.fixed) return "Fixed value";
		const bits = [];
		if (r.fromAncestorValue) bits.push("From ancestor");
		if (r.linkAncestor) bits.push(bits.length ? "else link ancestor" : "Link ancestor");
		if (!bits.length) return "Not set";
		return bits.join(", ") + (r.ignoreFilter ? " (ignoring filter)" : "");
	}

	async _renderValues(p) { return this._renderRulesScreen(p, "inherit"); }
	async _renderDefaults(p) { return this._renderRulesScreen(p, "defaults"); }

	async _renderRulesScreen(p, mode) {
		const s = this._state;
		if (!s.rules) s.rules = this._loadRules();
		// An EMPTY read is never trusted from cache. _loadRules() falls back to an
		// empty set whenever getConfiguration() cannot be read, and _navBadge
		// caches whatever the FIRST render saw for the rest of the session. If
		// that first read ever came back short, the screen would offer to import
		// over live rules — and Import overwrites. Re-reading costs nothing, and
		// the genuinely-empty case still lands on the import screen.
		if (!s.rules.rules.length) s.rules = this._loadRules();

		// The import REPLACES this screen only when there is something to import.
		// It used to replace it unconditionally: a workspace that never had
		// Auto-Init From Ancestor got a heading, one sentence, and nothing else.
		// No picker, no way to add a collection, so BOTH value screens were a
		// dead end for every new user — which is exactly what the first person
		// to install 1.2.0 hit. With no import on offer, fall through to the
		// normal screen, which carries its own empty state and the picker.
		if (!s.rules.rules.length) {
			const found = await this._findAutoInit();
			if (found) {
				const screen = this._screen(p);
				const head = this._padTop(screen);
				this._add(head, '<div class="gp-h2">' +
					(mode === "inherit" ? "Inherited Values" : "Default Values") + "</div>" +
					'<div class="gp-blurb gp-blurb-640">Nothing here decides what a new record ' +
					"starts with yet.</div>");
				const n = Object.values(found.ai.collections || {})
					.reduce((acc, c) => acc + Object.keys(c.fields || {}).length, 0);
				const box = this._padScroll(screen);
				this._add(box, '<div class="gp-importcard"><div class="gp-fname2">' +
					this._esc((found.cfg || {}).name || "Auto-Init") + '</div><div class="gp-ftype">' +
					n + " rules across " + Object.keys(found.ai.collections || {}).length +
					" collections, and " + (found.ai.blocklist || []).length + " blocklisted</div></div>" +
					'<div class="gp-blurb gp-blurb-tight">Importing copies those rules here ' +
					"and leaves that plugin untouched, so it stays a way back.</div>");
				const acts = this._bar(screen, "<div></div>");
				this._primary(acts, "Import " + n + " Rules", () => this._doImport(found), true);
				return;
			}
		}
		if (s.clash === undefined) {
			const found = await this._findAutoInit();
			s.clash = (found && !(found.cfg || {}).off) ? found : null;
			if (s.clash) return this._render();
		}
		this._renderRules(p, mode);
	}

	async _doImport(found) {
		const s = this._state;
		if (!s || s.busy) return;
		s.busy = true;
		const next = this._migrateAutoInit(found.ai);
		s.rules = next;
		s.vModel = null;
		this._stageStore(this._loadStore(), next);
		s.busy = false;
		this._render();
		this._toast("Imported " + next.rules.length + " rules. " +
			(found.cfg || {}).name + " is untouched and still running: turn it off so only " +
			"one of them fills in new records.");
	}


	/* Two plugins writing the same properties on record.created is how records
	 * got corrupted before, so the one state that earns a loud row is: the old
	 * plugin is still running while rules exist here. Otherwise this whole
	 * region is absent. */
	_clashRow(other) {
		const wrap = document.createElement("div");
		wrap.className = "gp-clash";
		this._add(wrap, '<div class="gp-clashtitle">' +
			this._esc((other.cfg || {}).name || "The old plugin") + " is still running</div>" +
			'<div class="gp-clashtext">Both would fill in the same properties as a record is ' +
			"created. Turn that one off so only these rules apply.</div>");
		const b = document.createElement("button");
		b.className = "gp-clashbtn";
		b.textContent = "Turn It Off \u2192";
		b.addEventListener("click", () => this._disableOther(other));
		wrap.appendChild(b);
		return wrap;
	}

	/** Sets `off` on the other plugin's config, which Thymer honours for global
	 *  plugins: its code stops loading. Its SETTINGS are left completely intact,
	 *  so turning it back on restores today's behaviour exactly. */
	async _disableOther(other) {
		const s = this._state;
		if (!s || s.busy) return;
		s.busy = true;
		try {
			const cfg = JSON.parse(JSON.stringify(other.cfg));
			cfg.off = true;
			await other.api.saveConfiguration(cfg);
		} catch (e) {
			s.busy = false;
			this._toast("Could not turn it off: " + (e && e.message ? e.message : e));
			return;
		}
		s.busy = false;
		this._render();
		this._toast("Turned off " + ((other.cfg || {}).name || "the other plugin") +
			". Its rules are untouched, so switching it back on restores what it did before.");
	}

	/* The configuration window, brought over from Auto-Init rather than
	 * redesigned: collections on the left with a count each, the selected
	 * collection's fields on the right with their toggles. A flat list of 58
	 * rules was the wrong shape and this one is already proven on 20
	 * collections.
	 *
	 * Stored rules stay a flat array (so an all-collections scope can exist
	 * later), and a nested model is built for the window and flattened back on
	 * every change. */
	_rulesToModel(store) {
		const m = { collections: {}, blocklist: (store.blocklist || []).slice() };
		for (const r of (store.rules || [])) {
			const key = r.colGuid || "*";
			const c = m.collections[key] || (m.collections[key] = { name: r.colName, fields: {} });
			c.fields[r.fieldId] = r;
		}
		return m;
	}

	_modelToRules(model) {
		const rules = [];
		for (const [key, c] of Object.entries(model.collections)) {
			for (const [fieldId, r] of Object.entries(c.fields || {})) {
				rules.push(Object.assign({}, r, {
					colGuid: key === "*" ? null : key, colName: c.name || null, fieldId,
				}));
			}
		}
		return rules;
	}

	_ruleIsSet(r) {
		return !!(r && (r.fromAncestorValue || r.linkAncestor || r.fixed));
	}

	_countFor(model, guid) {
		const c = model.collections[guid];
		return c ? Object.values(c.fields || {}).filter((r) => this._ruleIsSet(r)).length : 0;
	}

	_fixedLabel(field, fixed) {
		if (!fixed) return "Set…";
		if (fixed.kind === "token") return fixed.value;
		if (fixed.kind === "choice") {
			const c = (field.choices || []).find((x) => x.id === fixed.value);
			return c ? c.label : "an option";
		}
		if (fixed.kind === "record") {
			const rec = this.data.getRecord(fixed.value);
			return rec ? (rec.getName() || "a record") : "a record";
		}
		return String(fixed.value);
	}

	/* ══════════════════════════════════════════════════════════════════════
	 * The rules screen — ONE screen, two modes.
	 *
	 * Inherited Values and Default Values are the same panel: same collection
	 * trigger, same popover picker, only the table differs. That is the design's
	 * structure, and it is why the picker counts have to be mode-aware.
	 *
	 * The three toggle columns read ANCESTOR'S VALUE → LINK ANCESTOR → IGNORE
	 * FILTER because that is the order the engine tries them: both can be on,
	 * the value first, the link as the fallback.
	 * ══════════════════════════════════════════════════════════════════════ */

	_renderRules(parent, mode) {
		const s = this._state;
		if (!s.rules) s.rules = this._loadRules();
		if (!s.vModel) s.vModel = this._rulesToModel(s.rules);
		s.rulesMode = mode;

		const screen = this._screen(parent);
		const head = this._padTop(screen);
		if (mode === "inherit") {
			const sw = document.createElement("div");
			sw.className = "gp-seg";
			for (const t of [{ id: "collections", label: "Collections" },
				{ id: "blocklist", label: "Excluded" }]) {
				const b = document.createElement("button");
				b.className = s.vTab === t.id ? "is-on" : "";
				b.textContent = t.label;
				b.addEventListener("click", () => { s.vTab = t.id; s.pop = null; this._render(); });
				sw.appendChild(b);
			}
			head.appendChild(sw);
		} else {
			this._add(head, '<div class="gp-h2">Default Values</div>');
		}
		this._add(head, '<div class="gp-blurb gp-blurb-640">' + (mode === "defaults"
			? "A value every new record in this collection starts with. Inherited values win: " +
			  "a default only lands when nothing was inherited, including on records created " +
			  "from nowhere."
			: s.vTab === "collections"
				? "Create a record while you are inside another one and its fields fill themselves " +
				  "in from that ancestor — either its value, or a link to the ancestor itself. " +
				  "Turn on both and the value is tried first."
				: "Inheriting is switched off for these collections, in both directions: nothing " +
				  "is inherited into them, and nothing is inherited from them while you stand in " +
				  "one. Default values still apply — they do not come from an ancestor. For places " +
				  "you capture into rather than structure — a journal, an inbox, a scratch area.") +
			"</div>");

		const other = s.clash;
		if (other) head.appendChild(this._clashRow(other));

		if (mode === "inherit" && s.vTab === "blocklist") this._renderExcluded(screen);
		else this._renderRulesBody(screen, mode);

		this._rulesFooter(screen);
	}

	_renderRulesBody(screen, mode) {
		const s = this._state, model = s.vModel;
		const body = this._padScroll(screen);

		// Which collection — a trigger with an anchored popover, never a
		// drill-in: the table has to stay on screen while you switch.
		const guids = Object.keys(model.collections).filter((g) => g !== "*");
		guids.sort((a, b) => this._collLabel(a, model).localeCompare(this._collLabel(b, model)));
		// Open on a collection that actually carries a rule of THIS mode. A
		// collection can hold an entry for the other one and nothing here, so
		// plain guids[0] could land Default Values on a collection with no
		// default and an empty table.
		if (!s.vSel || !model.collections[s.vSel]) {
			s.vSel = guids.find((g) => this._modeCount(model.collections[g], mode) > 0)
				|| guids[0] || null;
		}

		const line = document.createElement("div");
		line.className = "gp-pickline";
		const anchor = document.createElement("div");
		anchor.className = "gp-anchor";
		this._add(anchor, '<div class="gp-caps">RULES FOR COLLECTION</div>');
		const trigger = document.createElement("button");
		trigger.className = "gp-trigger";
		trigger.innerHTML = '<span class="gp-triglabel">' +
			(s.vSel ? this._colIconFor(s.vSel) : "") +
			"<span>" + this._esc(s.vSel ? this._collLabel(s.vSel, model) : "Pick a collection") +
			"</span></span>" + Plugin.CHEVRON;
		trigger.addEventListener("click", (e) => {
			e.stopPropagation();
			s.pop = s.pop === "coll" ? null : "coll";
			// With no rule sets yet there is nothing to switch BETWEEN, so the
			// picker opens straight into adding one rather than on an empty list
			// under a "Nothing matches" line.
			s.popAdd = !guids.length;
			s.popQ = ""; s.popActive = 0;
			this._render();
		});
		anchor.appendChild(trigger);
		if (s.pop === "coll") {
			const pop = this._collPopover(model, guids, mode);
			anchor.appendChild(pop);
			this._placePop(anchor, pop);
		}
		line.appendChild(anchor);

		if (s.vSel) {
			const all = this._fieldsOf(s.vSel);
			const n = this._modeCount(model.collections[s.vSel], mode);
			this._add(line, '<div class="gp-sidenote">' + n + " of " + all.length + " fields " +
				(mode === "inherit" ? "inherit" : "have a default") + "</div>");
		}
		body.appendChild(line);

		if (!s.vSel) {
			this._add(body, '<div class="gp-blurb">No collection has rules yet. ' +
				"Use the picker above to add one.</div>");
			return;
		}
		if (mode === "inherit") this._inheritTable(body, model, s.vSel);
		else this._defaultsTable(body, model, s.vSel);
	}

	/** The user fields of a collection, by guid. */
	_fieldsOf(guid) {
		const col = (this._state.cols || []).find((c) => c.guid === guid);
		return col ? this._userFields(col.api.getConfiguration()) : [];
	}

	/** Counts are MODE-AWARE: the same picker shows inheriting fields in
	 *  Inherited Values and defaults in Default Values. */
	_modeCount(stored, mode) {
		if (!stored) return 0;
		return Object.values(stored.fields).filter((r) =>
			mode === "inherit" ? (r.fromAncestorValue || r.linkAncestor) : r.fixed).length;
	}

	/** The picker popover, which doubles as the add-a-collection list in place. */
	_collPopover(model, guids, mode) {
		const s = this._state;
		const pop = document.createElement("div");
		pop.className = "gp-pop gp-pop-coll";
		pop.addEventListener("click", (e) => e.stopPropagation());

		if (s.popAdd) {
			this._add(pop, '<div class="gp-popnote">Pick a collection with no rules ' +
				"yet. It starts with every field set to nothing.</div>");
		}
		const wrap = document.createElement("div");
		wrap.className = "gp-popsearchwrap";
		this._popSearch(wrap, s.popAdd ? "Search collections to add…" : "Search collections…",
			s.popQ, (v) => { s.popQ = v; s.popActive = 0; this._render(); });
		pop.appendChild(wrap);

		const list = document.createElement("div");
		list.className = "gp-poplist";
		const q = s.popQ || "";
		// BOTH lists are mode-aware, because a collection can hold a rule set for
		// the other mode and nothing at all for this one. Keyed on "has an entry"
		// instead, Default Values listed all 20 collections that only inherit,
		// each with a 0 beside it, and Add offered none of them because they
		// already had an entry — so a collection that inherits could never be
		// given a default. The main list is what HAS a rule here, plus whatever
		// is selected (a collection added a moment ago has none yet and must not
		// vanish while you are filling it in). Add offers everything that has
		// none here, whether or not it has one over on the other screen.
		const has = (g) => this._modeCount(model.collections[g], mode) > 0;
		const rows = s.popAdd
			? (s.cols || []).filter((c) => this._isTarget(c) && !has(c.guid))
			: guids.filter((g) => has(g) || g === s.vSel)
				.map((g) => (s.cols || []).find((c) => c.guid === g) || { guid: g, name: this._collLabel(g, model) });

		const visible = rows.filter((c) => this._matchScore(c.name || "", q) > 0);
		const rowFor = (c) => {
			const b = document.createElement("button");
			b.className = "gp-poprow" + (!s.popAdd && c.guid === s.vSel ? " is-on" : "");
			const excluded = model.blocklist.indexOf(c.guid) > -1;
			// In the list, the count is how many rules of THIS mode the
			// collection carries. In add mode there are none yet, so it says how
			// big the collection is instead.
			let count;
			if (s.popAdd) {
				const n = this._fieldsOf(c.guid).length;
				count = n + (n === 1 ? " field" : " fields");
			} else {
				count = String(this._modeCount(model.collections[c.guid], mode));
			}
			b.innerHTML = '<span class="gp-poplabel">' + this._colIcon(c) +
				"<span>" + this._esc(c.name) + "</span></span>" +
				'<span class="gp-popcount">' +
				(excluded && s.popAdd ? "excluded — remove it from Excluded first" : count) + "</span>";
			if (excluded && s.popAdd) b.classList.add("is-off");
			else {
				b.addEventListener("click", () => {
					// Only mint an entry that is not there. A collection offered
					// here may already hold the OTHER mode's rules, and assigning
					// a fresh {fields:{}} over it would wipe them.
					if (s.popAdd && !model.collections[c.guid]) {
						model.collections[c.guid] = { name: c.name, fields: {} };
						this._dirty();
					}
					s.vSel = c.guid; s.pop = null; s.popAdd = false; s.popQ = "";
					s.pendingField = null;
					this._render();
				});
			}
			return b;
		};

		// The list IS the answer now, so it gets a title rather than two bands.
		if (!s.popAdd && visible.length) {
			this._add(list, '<div class="gp-caps-s gp-popgroup">' +
				(mode === "inherit" ? "INHERITING" : "WITH A DEFAULT") +
				" \u00b7 " + visible.filter((c) => has(c.guid)).length + "</div>");
		}
		for (const c of visible) list.appendChild(rowFor(c));
		if (!visible.length) {
			this._add(list, '<div class="gp-popempty">' + (q ? "Nothing matches."
				: s.popAdd
					? "Every collection already has one."
					: "No collection has " + (mode === "inherit" ? "an inherit rule" : "a default") +
					  " yet. Use + Add a Collection below.") + "</div>");
		}
		pop.appendChild(list);
		this._add(pop, '<div class="gp-poprule"></div>');
		const foot = document.createElement("button");
		foot.className = s.popAdd ? "gp-popfoot is-quiet" : "gp-popfoot";
		foot.textContent = s.popAdd ? "‹ Back to Collections With Rules" : "+ Add a Collection";
		foot.addEventListener("click", () => { s.popAdd = !s.popAdd; s.popQ = ""; s.popActive = 0; this._render(); });
		pop.appendChild(foot);
		return pop;
	}

	/** FIELD · ANCESTOR'S VALUE · LINK ANCESTOR · IGNORE FILTER, in the order the
	 *  engine tries them. Under ~900px usable the headers shorten and a legend
	 *  below carries the meaning they lost. */
	_inheritTable(body, model, guid) {
		const s = this._state;
		const tight = this._panel().classList.contains("is-tight");
		const col = (s.cols || []).find((c) => c.guid === guid);
		const cfg = col ? col.api.getConfiguration() : null;
		const stored = model.collections[guid];

		const fields = cfg ? this._userFields(cfg).slice() : [];
		const pp = cfg && (cfg.fields || []).find((f) => f.id === "parent_page");
		if (pp) fields.unshift(pp);

		const grid = document.createElement("div");
		grid.className = "gp-grid gp-grid-inherit" + (tight ? " is-tight" : "");
		this._add(grid,
			'<div class="gp-caps gp-caps-flat">FIELD</div>' +
			this._tipHead(Plugin.TIPS.value, tight ? "VALUE" : "ANCESTOR&#39;S VALUE") +
			this._tipHead(Plugin.TIPS.link, tight ? "LINK" : "LINK ANCESTOR") +
			this._tipHead(Plugin.TIPS.filter, tight ? "FILTER" : "IGNORE FILTER") +
			'<div class="gp-gridrule"></div>');

		for (const f of fields) {
			const isRecord = f.type === "record";
			const hasFilter = isRecord && !!f.filter_colguid;
			this._add(grid, '<div class="gp-cellname"><span class="gp-fname2">' +
				this._esc(f.label || f.id) + '</span><span class="gp-ftype">' +
				this._esc(f.type) + "</span></div>");
			// One size across the row, at Parham's call. The design sized the two
			// deciding columns at 17 and Ignore filter at 13, reading it as a
			// qualifier on Link rather than a peer of it; in the built table that
			// just looks like a table whose boxes do not line up. 13 for all
			// three, the smaller of the two.
			grid.appendChild(this._box(stored, f, "fromAncestorValue", true, 13));
			grid.appendChild(this._box(stored, f, "linkAncestor", isRecord, 13));
			grid.appendChild(this._box(stored, f, "ignoreFilter", hasFilter, 13));
		}
		body.appendChild(grid);
		if (tight) {
			this._add(body, '<div class="gp-legend">VALUE takes the ancestor&#39;s ' +
				"own value · LINK points at the ancestor record · FILTER inherits even from a " +
				"collection the field&#39;s filter excludes.</div>");
		}
	}

	/** A tick, drawn rather than native: the design's box is a 2px-radius square
	 *  with an accent fill, and a native checkbox cannot carry that in every
	 *  theme. An em dash where the toggle would do nothing. */
	_box(stored, f, flag, live, size) {
		const cell = document.createElement("div");
		cell.className = "gp-mid";
		if (!live) { cell.innerHTML = '<span class="gp-dash">—</span>'; return cell; }
		const rule = stored.fields[f.id] || {};
		const b = document.createElement("button");
		b.className = "gp-tick";
		b.innerHTML = this._cb(!!rule[flag], size);
		b.addEventListener("click", () => {
			const r = stored.fields[f.id] || (stored.fields[f.id] = { label: f.label || "" });
			r[flag] = !r[flag];
			r.label = f.label || r.label;
			// Ignore filter qualifies Link ancestor; turning Link off takes its
			// qualifier with it rather than leaving a setting with no effect.
			if (flag === "linkAncestor" && !r.linkAncestor) r.ignoreFilter = false;
			if (!this._ruleIsSet(r)) delete stored.fields[f.id];
			this._dirty();
			this._render();
		});
		cell.appendChild(b);
		return cell;
	}

	/** FIELD · STARTS AT. Only the fields that HAVE a default, plus the one
	 *  being set right now: the panel is sparse by nature and a column of "None"
	 *  was the emptiness problem. */
	_defaultsTable(body, model, guid) {
		const s = this._state;
		const stored = model.collections[guid];
		const fields = this._fieldsOf(guid);
		// `pendingField` is what makes "+ Set a Default" work: picking a field
		// puts its row in the table with "Pick a value" and opens the value
		// popover on it. Without it the popover had no row to anchor to and the
		// flow dead-ended, which is what it did before.
		const rows = fields.filter((f) =>
			(stored.fields[f.id] || {}).fixed || f.id === s.pendingField);

		if (rows.length) {
			const grid = document.createElement("div");
			grid.className = "gp-grid gp-grid-def";
			this._add(grid, '<div class="gp-caps gp-caps-flat">FIELD</div>' +
				'<div class="gp-caps gp-caps-flat">STARTS AT</div><div class="gp-gridrule"></div>');
			for (const f of rows) {
				const rule = stored.fields[f.id] || {};
				this._add(grid, '<div class="gp-cellname"><span class="gp-fname2">' +
					this._esc(f.label) + '</span><span class="gp-ftype">' + this._esc(f.type) + "</span></div>");
				const cell = document.createElement("div");
				cell.className = "gp-anchor";
				const b = document.createElement("button");
				// Two states, as the design draws them: teal once it carries a
				// value, quiet and outlined while it is still asking for one.
				b.className = "gp-valuebtn" + (rule.fixed ? " is-set" : "");
				b.innerHTML = "<span class='gp-valuelabel'>" +
					this._esc(rule.fixed ? this._fixedLabel(f, rule.fixed) : "Pick a value") +
					"</span>" + Plugin.CHEVRON;
				b.addEventListener("click", (e) => {
					e.stopPropagation();
					s.pop = s.pop === "fixed:" + f.id ? null : "fixed:" + f.id;
					s.popQ = ""; s.popActive = 0;
					this._render();
				});
				cell.appendChild(b);
				if (s.pop === "fixed:" + f.id) {
					const pop = this._fixedPopover(f, guid, stored);
					cell.appendChild(pop);
					this._placePop(cell, pop);
				}
				grid.appendChild(cell);
			}
			body.appendChild(grid);
		} else {
			this._add(body, '<div class="gp-blurb gp-blurb-tight">Nothing in ' +
				this._esc(this._collLabel(guid, model)) + " starts with a value yet.</div>");
		}

		const add = document.createElement("div");
		add.className = "gp-anchor gp-addwrap";
		const btn = document.createElement("button");
		btn.className = "gp-dashed gp-dashed-lg" + (s.pop === "deffield" ? " is-open" : "");
		btn.textContent = "+ Set a Default";
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			s.pop = s.pop === "deffield" ? null : "deffield";
			s.popActive = 0;
			this._render();
		});
		add.appendChild(btn);
		if (s.pop === "deffield") {
			const pop = document.createElement("div");
			pop.className = "gp-pop gp-pop-field";
			pop.addEventListener("click", (e) => e.stopPropagation());
			this._add(pop, '<div class="gp-popnote">Which field should new records ' +
				"start with a value in?</div>");
			const list = document.createElement("div");
			list.className = "gp-poplist";
			const left = fields.filter((f) =>
				!(stored.fields[f.id] || {}).fixed && f.id !== s.pendingField);
			for (const f of left) {
				const b = document.createElement("button");
				b.className = "gp-poprow";
				b.innerHTML = "<span>" + this._esc(f.label) + '</span><span class="gp-popcount">' +
					this._esc(f.type) + "</span>";
				b.addEventListener("click", () => {
					// Ask which field, then open the value picker immediately —
					// one gesture, not two.
					s.pendingField = f.id;
					s.pop = "fixed:" + f.id;
					s.popQ = ""; s.popActive = 0;
					this._render();
				});
				list.appendChild(b);
			}
			if (!left.length) {
				this._add(list, '<div class="gp-popempty">Every field already has a default.</div>');
			}
			pop.appendChild(list);
			add.appendChild(pop);
			this._placePop(add, pop);
		}
		body.appendChild(add);
	}

	/** The value popover: the collection's OWN values for that field. */
	/** A collection's records for a picker, loaded once per dialog and cached
	 *  on the state. getAllRecords() is a PROMISE on a collection (synchronous
	 *  on the data API). Returns "loading" until it is there. */
	_loadRecCache(target) {
		const s = this._state;
		if (!s.recCache[target.guid]) {
			s.recCache[target.guid] = "loading";
			Promise.resolve(target.api.getAllRecords()).then((recs) => {
				// The order THYMER lists this collection in, never alphabetical
				// and never the raw store order either. See _hostSorted: the
				// app sorts a collection's records by its own
				// sidebar_record_sort_field_id/_dir, and its record-property
				// picker then shows that array unsorted. Alphabetising turned a
				// status list into Done, Dropped, In Backlog, In Progress, an
				// order nobody arranged; the raw store order was no better.
				s.recCache[target.guid] = this._hostSorted(recs || [], target)
					// A record's own icon, which is what Thymer draws beside it.
					// getIcon() returns null for records that never had one set;
					// those fall back to the collection's icon.
					.map((r) => ({ guid: r.guid, name: r.getName() || "(untitled)",
						icon: (() => { try { return r.getIcon && r.getIcon(); } catch (e) { return null; } })() }));
				if (this._state === s) this._render();
			}).catch(() => { s.recCache[target.guid] = []; });
		}
		return s.recCache[target.guid];
	}

	_fixedPopover(field, guid, stored) {
		const s = this._state;
		const rule = stored.fields[field.id] || {};
		const pop = document.createElement("div");
		pop.className = "gp-pop gp-pop-value";
		pop.addEventListener("click", (e) => e.stopPropagation());
		this._add(pop, '<div class="gp-popnote">Set on every new record in this ' +
			"collection, unless the field inherits a value first.</div>");
		this._add(pop, '<div class="gp-poprule"></div>');

		const set = (fixed) => {
			const r = stored.fields[field.id] || (stored.fields[field.id] = { label: field.label || "" });
			r.fixed = fixed;
			r.label = field.label || r.label;
			if (!this._ruleIsSet(r)) delete stored.fields[field.id];
			s.pop = null;
			// Setting a value promotes the pending row into a real one; clearing
			// it back to None takes the row away again.
			s.pendingField = fixed ? null : s.pendingField;
			this._dirty();
			this._render();
		};

		const opts = [];
		if (field.type === "datetime") {
			opts.push({ label: "@today" }, { label: "@tomorrow" }, { label: "@now" });
			for (const o of opts) {
				o.icon = '<span class="gp-colicon ti ti-calendar"></span>';
				o.pick = () => set({ kind: "token", value: o.label });
			}
		} else if (field.type === "choice") {
			// A choice keeps the collection's OWN option order — that order is
			// meaningful and it is how Thymer lists them. Only records and other
			// long lists get sorted.
			for (const c of (field.choices || []).filter((c) => c.active !== false)) {
				opts.push({ label: c.label, keepOrder: true,
					pick: () => set({ kind: "choice", value: c.id }) });
			}
		} else if (field.type === "record") {
			const target = field.filter_colguid
				? (s.cols || []).find((c) => c.guid === field.filter_colguid) : null;
			const cached = target ? this._loadRecCache(target) : null;
			if (cached === "loading") opts.push({ label: "Loading…", pick: null });
			else for (const r of (cached || [])) {
				// Each record's OWN icon, mirroring what Thymer draws beside it.
				// Only a record that never had one set falls back to its
				// collection's.
				opts.push({ label: r.name,
					icon: /^ti-/.test(r.icon || "")
						? '<span class="gp-colicon ti ' + this._esc(r.icon) + '"></span>'
						: this._colIcon(target),
					pick: () => set({ kind: "record", value: r.guid }) });
			}
			if (!target) opts.push({ label: "This field links to no collection", pick: null });
		}

		if (field.type === "record" || opts.length > 8) {
			const w = document.createElement("div");
			w.className = "gp-popsearchwrap";
			this._popSearch(w, "Search records…", s.popQ,
				(v) => { s.popQ = v; s.popActive = 0; this._render(); });
			pop.appendChild(w);
		}

		const list = document.createElement("div");
		list.className = "gp-poplist";
		const q = s.popQ || "";
		// Ranked the shared picker's way — prefix-first, `+` as an AND — unless
		// the options carry an order of their own worth keeping.
		// The cache holds EVERY record so a search finds it; only what is
		// drawn is capped (Habitats has 5,195).
		const ranked = (opts.length && opts[0].keepOrder
			? opts.filter((o) => this._matchScore(o.label, q) > 0)
			: this._rankRows(opts, q, (o) => o.label)).slice(0, 400);
		// "None" is how a default is removed, so it belongs in the same list
		// rather than in a separate footer action, and it stays pinned at the top
		// instead of being ranked in among real values.
		const all = (this._matchScore("None", q) > 0
			? [{ label: "None", pick: () => set(null) }] : []).concat(ranked);
		for (const o of all) {
			const b = document.createElement("button");
			const on = o.label === "None"
				? !rule.fixed
				: !!rule.fixed && this._fixedLabel(field, rule.fixed) === o.label;
			b.className = "gp-poprow" + (on ? " is-on" : "");
			b.innerHTML = '<span class="gp-poplabel">' + (o.icon || "") +
				"<span>" + this._esc(o.label) + "</span></span>";
			if (o.pick) b.addEventListener("click", o.pick);
			list.appendChild(b);
		}
		if (!all.length) this._add(list, '<div class="gp-popempty">Nothing matches.</div>');
		pop.appendChild(list);
		return pop;
	}

	_renderExcluded(screen) {
		const s = this._state, model = s.vModel;
		const body = this._padScroll(screen);
		const chips = document.createElement("div");
		chips.className = "gp-chips";
		for (const g of model.blocklist) {
			const chip = document.createElement("span");
			chip.className = "gp-chip";
			chip.innerHTML = this._colIconFor(g) +
				'<span class="gp-chipname">' + this._esc(this._collLabel(g, model)) + "</span>";
			const x = document.createElement("button");
			x.className = "gp-chipx";
			x.textContent = "×";
			x.addEventListener("click", () => {
				model.blocklist = model.blocklist.filter((v) => v !== g);
				this._dirty(); this._render();
			});
			chip.appendChild(x);
			chips.appendChild(chip);
		}
		body.appendChild(chips);

		const anchor = document.createElement("div");
		anchor.className = "gp-anchor";
		const btn = document.createElement("button");
		btn.className = "gp-dashed gp-dashed-lg" + (s.pop === "excl" ? " is-open" : "");
		btn.textContent = "+ Exclude a Collection";
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			s.pop = s.pop === "excl" ? null : "excl"; s.popQ = ""; s.popActive = 0;
			this._render();
		});
		anchor.appendChild(btn);
		if (s.pop === "excl") {
			const pop = document.createElement("div");
			pop.className = "gp-pop gp-pop-excl";
			pop.addEventListener("click", (e) => e.stopPropagation());
			this._add(pop, '<div class="gp-popnote">Excluding a collection leaves its rules ' +
				"in place and stops it inheriting, in both directions. Default values still " +
				"apply.</div>");
			const w = document.createElement("div");
			w.className = "gp-popsearchwrap";
			this._popSearch(w, "Search collections…", s.popQ,
				(v) => { s.popQ = v; s.popActive = 0; this._render(); });
			pop.appendChild(w);
			const list = document.createElement("div");
			list.className = "gp-poplist";
			const q = s.popQ || "";
			let shown = 0;
			for (const c of (s.cols || [])) {
				if (model.blocklist.indexOf(c.guid) > -1) continue;
				if (this._matchScore(c.name, q) <= 0) continue;
				shown++;
				const stored = model.collections[c.guid];
				// Only the inheriting rules stop firing; a fixed default is
				// unaffected by exclusion, so counting it here would overstate it.
				const n = stored ? Object.values(stored.fields)
					.filter((r) => r.fromAncestorValue || r.linkAncestor).length : 0;
				const b = document.createElement("button");
				b.className = "gp-poprow";
				// Excluding never deletes configuration, so the warning is about
				// what stops firing, not about what is lost.
				b.innerHTML = '<span class="gp-poplabel">' + this._colIcon(c) +
					"<span>" + this._esc(c.name) + "</span></span>" +
					(n ? '<span class="gp-popwarn">' + n +
						(n === 1 ? " inherit rule stops" : " inherit rules stop") + "</span>" : "");
				b.addEventListener("click", () => {
					model.blocklist.push(c.guid);
					s.pop = null; this._dirty(); this._render();
				});
				list.appendChild(b);
			}
			if (!shown) this._add(list, '<div class="gp-popempty">No collections left to exclude.</div>');
			pop.appendChild(list);
			anchor.appendChild(pop);
			this._placePop(anchor, pop);
		}
		body.appendChild(anchor);
	}

	/* Nothing is written until Save. Edits live in the scratch model; switching
	 * panels keeps them. Cancel throws them away AND closes: a Cancel that only
	 * reset the table left you sitting in a dialog you had just said no to. */
	_rulesFooter(screen) {
		const s = this._state;
		// This is the ONE Save that leaves the dialog open, so the toast every
		// other screen reports through cannot do the job here: it lands
		// bottom-centre, in the panel's own surface colour, hard against the
		// panel's bottom edge, and reads as a piece of the dialog rather than as
		// a message. The note carries it instead, and it stays said until the
		// next edit rather than fading.
		const saved = !s.vDirty && s.vSaved;
		const acts = this._bar(screen, '<div class="gp-footnote' + (saved ? " is-saved" : "") + '">' +
			(s.vDirty ? "Unsaved changes"
				: saved ? Plugin.TICK + " Saved"
				: "Applies to records created from now on.") + "</div>");

		// Only the actions that mean something. With a clean table there is
		// nothing to cancel and nothing to save, so one button closes and the
		// other is not drawn at all. It must NOT take Cancel's discard path:
		// that path drops the staged rules, which after a Save is the saved
		// state itself.
		if (!s.vDirty) {
			this._primary(acts, "Close", () => this._closeModal(), true);
			return;
		}
		this._quiet(acts, "Cancel", () => {
			// Drop the staged rules before closing, or _closeModal would flush
			// the very edits Cancel just discarded. Not after a Save, though:
			// _pendingRules then holds that SAVED state, because an edit only
			// touches the scratch model and never re-stages. Clearing it there
			// would throw away a save the note had already confirmed, and only
			// the localStorage mirror's newer rev would have got it back.
			if (!s.vSaved) this._pendingRules = null;
			s.vDirty = false;
			this._closeModal();
		});
		this._primary(acts, "Save", () => this._saveRules(), true);
	}


	_saveRules() {
		const s = this._state;
		s.rules.rules = this._modelToRules(s.vModel);
		s.rules.blocklist = s.vModel.blocklist.slice();
		this._stageStore(this._loadStore(), s.rules);
		s.vDirty = false;
		s.vSaved = true;
		this._render();
	}

	_dirty() { this._state.vDirty = true; }

	_collLabel(guid, model) {
		const c = (this._state.cols || []).find((x) => x.guid === guid);
		if (c) return c.name;
		const stored = model.collections[guid];
		return (stored && stored.name) || guid;
	}
	// ══════════════════════════════════════════════════════════════════════
	// Screen: apply
	// ══════════════════════════════════════════════════════════════════════

	/* Add Properties — ONE screen, two steps, with a clickable stepper.
	 *
	 *   1  What and Where  — properties/templates left, target collections
	 *                        right, each with its own search
	 *   2  Order           — where the new fields land, per target collection
	 *
	 * Step 2 is the first of the plugin's two deliberate exceptions to
	 * additive-only: dragging an EXISTING field changes that collection's order.
	 * The note under the list says so in as many words. */
	_renderApply(parent) {
		const s = this._state;
		const screen = this._screen(parent);
		const step2 = s.step === 2;
		const canGo = !!(this._selectionCount() && s.targetGuids.size);

		const head = this._padTop(screen);
		const stepper = document.createElement("div");
		stepper.className = "gp-stepper";
		const chip1 = document.createElement("button");
		chip1.className = "gp-step" + (step2 ? "" : " is-on");
		chip1.innerHTML = "1 &nbsp;What and Where";
		chip1.addEventListener("click", () => { s.step = 1; this._render(); });
		const chip2 = document.createElement("button");
		// Both chips navigate: the stepper doubles as navigation, but step 2 is
		// only reachable once both sides of step 1 have a selection.
		chip2.className = "gp-step" + (step2 ? " is-on" : "") + (canGo ? "" : " is-locked");
		chip2.innerHTML = "2 &nbsp;Order";
		chip2.addEventListener("click", () => { if (canGo) { s.step = 2; this._render(); } });
		stepper.appendChild(chip1);
		this._add(stepper, '<span class="gp-steparrow">&#8594;</span>');
		stepper.appendChild(chip2);
		head.appendChild(stepper);
		this._add(head, '<div class="gp-blurb">' + (step2
			? "New fields land where you put them. Drag any field to reorder the collection " +
			  "while you are here."
			: "Pick what to add on the left and the collections to add it to on the right. " +
			  "Anything a collection already has is skipped.") + "</div>");

		if (step2) this._addOrder(screen);
		else this._addPick(screen);

		const acts = this._bar(screen,
			'<div class="gp-footnote">' + this._esc(this._addSummary()) + "</div>");
		if (step2) this._quiet(acts, "Back", () => { s.step = 1; this._render(); });
		this._primary(acts, step2 ? "Add Properties" : "Continue",
			() => { if (step2) this._doApply(); else { s.step = 2; this._render(); } },
			step2 ? this._orderAddCount() > 0 : canGo);
	}

	_selectionCount() {
		const s = this._state;
		return s.tplIds.size + s.propKeys.size;
	}

	/** Step 1: what on the left, where on the right. */
	_addPick(screen) {
		const s = this._state;
		const grid = document.createElement("div");
		grid.className = "gp-pad gp-scroll gp-two-col";

		// ── left: what to add ────────────────────────────────────────────────
		const left = document.createElement("div");
		left.className = "gp-col-l";
		this._add(left, '<div class="gp-caps">WHAT TO ADD</div>');
		this._search(left, "Search templates and properties…", s.query, (v) => {
			s.query = v;
			this._redrawWhat();
		});
		const whatList = document.createElement("div");
		whatList.className = "gp-picklist gp-whatlist";
		left.appendChild(whatList);
		grid.appendChild(left);

		// ── right: where to add it ───────────────────────────────────────────
		const right = document.createElement("div");
		right.className = "gp-col-r";
		this._add(right, '<div class="gp-caps">WHERE TO ADD IT</div>');
		this._search(right, "Search collections…", s.colQuery, (v) => {
			s.colQuery = v;
			this._redrawWhere();
		});
		const whereList = document.createElement("div");
		whereList.className = "gp-picklist gp-wherelist";
		right.appendChild(whereList);
		grid.appendChild(right);

		screen.appendChild(grid);
		this._drawWhat();
		this._drawWhere();
	}

	/** Every tickable thing on the left, grouped. Ticked rows lift into a
	 *  SELECTED group so a handful of picks scattered through 180 rows stay
	 *  visible instead of scrolling away. */
	_whatRows() {
		const s = this._state, out = [];
		for (const t of s.store.templates) {
			out.push({
				kind: "tpl", id: t.id,
				name: t.name,
				meta: t.fields.length + (t.fields.length === 1 ? " property" : " properties") +
					" · from " + t.srcName,
				on: () => s.tplIds.has(t.id),
				toggle: () => { s.tplIds.has(t.id) ? s.tplIds.delete(t.id) : s.tplIds.add(t.id); },
			});
		}
		const groups = this._propertyGroups();
		// Drift: the same property NAME carried by more than one definition.
		// _propertyGroups keys on the signature, and the label is part of it, so
		// two versions of "Timeblock" are two groups sharing a name. What the
		// strip reports is how many COLLECTIONS hold one of the other versions.
		const byName = new Map();
		for (const g of groups) {
			const k = this._norm(g.field.label);
			if (!byName.has(k)) byName.set(k, []);
			byName.get(k).push(g);
		}
		for (const g of groups) {
			const peers = byName.get(this._norm(g.field.label)) || [];
			const drift = peers.filter((x) => x !== g).reduce((a, x) => a + x.cols.length, 0);
			out.push({
				kind: "prop", id: g.key,
				name: g.field.label,
				meta: this._fieldDetail(g.field, s.colNames) + " · in " + g.cols[0] +
					(g.cols.length > 1 ? " and " + (g.cols.length - 1) + " more" : ""),
				drift,
				on: () => s.propKeys.has(g.key),
				toggle: () => { s.propKeys.has(g.key) ? s.propKeys.delete(g.key) : s.propKeys.add(g.key); },
			});
		}
		return out;
	}

	_drawWhat() {
		const s = this._state, p = this._panel();
		const host = p && p.querySelector(".gp-whatlist");
		if (!host) return;
		host.innerHTML = "";
		const all = this._whatRows();
		const q = s.query || "";
		const hit = (r) => this._score(r.name + " " + r.meta, q) > 0;

		// SELECTED counts and lists the SAME rows. The design's fixtures let the
		// label and the rows disagree when a template is ticked; every count in
		// this UI is derived from what is on screen, so both come from one list.
		const sel = all.filter((r) => r.on() && hit(r));
		const groups = [];
		if (sel.length) groups.push({ label: "SELECTED · " + sel.length, rows: sel });
		const tpl = all.filter((r) => r.kind === "tpl" && !r.on() && hit(r));
		if (tpl.length) groups.push({ label: "TEMPLATES", rows: tpl });
		const rest = all.filter((r) => r.kind === "prop" && !r.on() && hit(r));
		if (rest.length) groups.push({ label: "PROPERTIES", rows: rest });
		if (!groups.length) groups.push({ label: "NO MATCHES", rows: [] });

		for (const g of groups) {
			const box = document.createElement("div");
			box.className = "gp-pickgroup";
			this._add(box, '<div class="gp-caps-s">' + this._esc(g.label) + "</div>");
			for (const r of g.rows) box.appendChild(this._whatRow(r));
			host.appendChild(box);
		}
	}

	_whatRow(r) {
		const wrap = document.createElement("div");
		wrap.className = "gp-pickwrap";
		const b = document.createElement("button");
		b.className = "gp-pickrow";
		b.innerHTML = this._cb(r.on(), 13) +
			'<span class="gp-pickmain"><span class="gp-pickname">' + this._esc(r.name) +
			'</span><span class="gp-pickmeta">' + this._esc(r.meta) + "</span></span>";
		b.addEventListener("click", () => {
			r.toggle();
			// Both lists change: the left one regroups, and every "adds N,
			// skips N" on the right is computed from this selection.
			this._drawWhat();
			this._drawWhere();
			this._syncAddFooter();
		});
		wrap.appendChild(b);

		// A property whose definition has drifted across collections says so
		// here, where you are already looking at it. The action that resolves it
		// (Change) is a separate pass; the strip is honest and useful without it.
		if (r.drift) {
			const strip = document.createElement("div");
			strip.className = "gp-drift";
			this._add(strip, '<span class="gp-drifttext">' +
				r.drift + (r.drift === 1 ? " collection has" : " collections have") +
				" a different version of this property</span>");
			// The ONLY way into Change. Entering from this row is what fixes the
			// direction: the version you are standing on is the one to match.
			const go = document.createElement("button");
			go.className = "gp-driftbtn";
			go.textContent = "Make Them Match This One →";
			go.addEventListener("click", (e) => {
				e.stopPropagation();
				const st = this._state;
				st.screen = "change";
				st.changeName = r.name;
				st.changeSrcKey = r.id;
				st.changeSkip = new Set();
				st.changeConfirm = false;
				st.costOpen = null;
				this._render();
			});
			strip.appendChild(go);
			wrap.appendChild(strip);
		}
		return wrap;
	}

	_redrawWhat() { this._drawWhat(); this._drawWhere(); this._syncAddFooter(); }
	_redrawWhere() { this._drawWhere(); }

	/** The collections, grouped the same way the left column is: ticked ones
	 *  lift into SELECTED. A target picked out of sixty rows should not scroll
	 *  away while you are still choosing what to put in it, and the two columns
	 *  are the same kind of list, so they behave the same. */
	_drawWhere() {
		const s = this._state, p = this._panel();
		const host = p && p.querySelector(".gp-wherelist");
		if (!host) return;
		host.innerHTML = "";
		const tpl = { fields: this._unionFields() };
		const q = s.colQuery || "";
		const rows = [];
		for (const c of s.cols) {
			if (!this._isTarget(c)) continue;
			if (q && this._score(c.name, q) <= 0) continue;
			// Derived, never a literal: what this collection would actually take,
			// from the same _plan() the apply runs.
			let meta;
			if (tpl.fields.length) {
				const plan = this._plan(tpl, c.api.getConfiguration());
				meta = "adds " + plan.add.length +
					(plan.skip.length ? ", skips " + plan.skip.length : "");
			} else {
				const n = this._userFields(c.api.getConfiguration()).length;
				meta = n + (n === 1 ? " field" : " fields");
			}
			rows.push({ c, meta });
		}
		if (!rows.length) {
			this._add(host, '<div class="gp-pickempty">Nothing matches that.</div>');
			return;
		}
		// SELECTED counts and lists the SAME rows, as on the left: both come
		// from one list so the label and the rows cannot disagree. Within a
		// group the collections keep their alphabetical order.
		const sel = rows.filter((r) => s.targetGuids.has(r.c.guid));
		const groups = [];
		if (sel.length) groups.push({ label: "SELECTED · " + sel.length, rows: sel });
		const rest = rows.filter((r) => !s.targetGuids.has(r.c.guid));
		if (rest.length) groups.push({ label: "COLLECTIONS", rows: rest });

		for (const g of groups) {
			const box = document.createElement("div");
			box.className = "gp-pickgroup";
			this._add(box, '<div class="gp-caps-s">' + this._esc(g.label) + "</div>");
			for (const r of g.rows) box.appendChild(this._whereRow(r));
			host.appendChild(box);
		}
	}

	_whereRow(r) {
		const s = this._state, guid = r.c.guid;
		const b = document.createElement("button");
		b.className = "gp-pickrow";
		b.innerHTML = this._cb(s.targetGuids.has(guid), 13) +
			'<span class="gp-pickmain"><span class="gp-pickname">' + this._colIcon(r.c) +
			this._esc(r.c.name) + '</span><span class="gp-pickmeta">' + this._esc(r.meta) +
			"</span></span>";
		b.addEventListener("click", () => {
			// Read the tick at click time, not from a value captured when the row
			// was built: the list is regrouped on every draw and a stale flag
			// would toggle the wrong way.
			if (s.targetGuids.has(guid)) {
				s.targetGuids.delete(guid); delete s.order[guid]; delete s.exclude[guid];
			} else s.targetGuids.add(guid);
			this._drawWhere();
			this._syncAddFooter();
		});
		return b;
	}

	/** The footer note and the primary button, refreshed without a full render
	 *  so ticking a row never moves the caret out of the search box. */
	_syncAddFooter() {
		const s = this._state, p = this._panel();
		if (!p || s.screen !== "apply") return;
		const note = p.querySelector(".gp-footnote");
		if (note) note.textContent = this._addSummary();
		const canGo = !!(this._selectionCount() && s.targetGuids.size);
		const b = p.querySelector(".gp-primary");
		if (b) b.disabled = !canGo;
		const chips = p.querySelectorAll(".gp-step");
		if (chips.length === 2) chips[1].classList.toggle("is-locked", !canGo);
	}

	_addSummary() {
		const s = this._state;
		if (s.step === 2) {
			const col = this._orderCol();
			if (!col) return "Nothing to place";
			const n = this._newFieldsFor(col).length;
			const left = (s.exclude[col.guid] || new Set()).size;
			return "Adding " + (n - left) + " of " + n + " new " +
				(n === 1 ? "field" : "fields") + " to " + col.name;
		}
		const fields = this._unionFields().length;
		const targets = s.targetGuids.size;
		if (fields && targets) {
			return fields + (fields === 1 ? " property → " : " properties → ") +
				targets + (targets === 1 ? " collection" : " collections");
		}
		if (this._selectionCount()) return "Now pick where to add them";
		return "Nothing selected yet";
	}

	// ── Step 2: order ───────────────────────────────────────────────────────

	_orderCol() {
		const s = this._state;
		const chosen = this._chosenTargets();
		const cur = chosen.find((c) => c.guid === s.orderCol);
		return cur || chosen[0] || null;
	}

	/** What this collection would actually gain, as field objects. */
	_newFieldsFor(col) {
		const tpl = { fields: this._unionFields() };
		return this._plan(tpl, col.api.getConfiguration()).add;
	}

	/** The order list for a collection: its existing user fields followed by
	 *  the new ones, unless the user has already dragged it into some other
	 *  shape. Rebuilt from scratch whenever the selection changes underneath. */
	_orderList(col) {
		const s = this._state;
		const fresh = this._userFields(col.api.getConfiguration())
			.map((f) => ({ id: f.id, label: f.label, type: f.type, isNew: false }))
			.concat(this._newFieldsFor(col)
				.map((f) => ({ id: f.id, label: f.label, type: f.type, isNew: true })));
		const held = s.order[col.guid];
		// A held order is only valid while it covers exactly the same fields.
		// Ticking another property upstream changes the set, and a stale list
		// would silently drop the new one.
		if (held && held.length === fresh.length &&
			held.every((h) => fresh.some((f) => f.id === h.id))) return held;
		s.order[col.guid] = fresh;
		return fresh;
	}

	_orderAddCount() {
		const col = this._orderCol();
		if (!col) return 0;
		const left = this._state.exclude[col.guid] || new Set();
		return this._newFieldsFor(col).filter((f) => !left.has(f.id)).length;
	}

	_addOrder(screen) {
		const s = this._state;
		const grid = document.createElement("div");
		grid.className = "gp-pad gp-scroll gp-order";

		const left = document.createElement("div");
		left.className = "gp-order-l";
		this._add(left, '<div class="gp-caps">COLLECTION</div>');
		const active = this._orderCol();
		for (const c of this._chosenTargets()) {
			const on = active && c.guid === active.guid;
			const b = document.createElement("button");
			b.className = "gp-ordertab" + (on ? " is-on" : "");
			const n = this._orderList(c).length;
			b.innerHTML = '<span class="gp-ordertabname">' + this._colIcon(c) +
				this._esc(c.name) + '</span><span class="gp-ordertabmeta">' +
				n + (n === 1 ? " field" : " fields") + "</span>";
			b.addEventListener("click", () => { s.orderCol = c.guid; this._render(); });
			left.appendChild(b);
		}
		grid.appendChild(left);

		const right = document.createElement("div");
		right.className = "gp-order-r";
		this._add(right, '<div class="gp-orderhead"><div class="gp-caps">FIELD ORDER</div>' +
			'<div class="gp-orderhint">Drag to reorder · untick to leave out</div></div>');
		const list = document.createElement("div");
		list.className = "gp-orderlist";
		right.appendChild(list);
		this._add(right, '<div class="gp-ordernote"></div>');
		grid.appendChild(right);
		screen.appendChild(grid);

		if (active) this._drawOrder(active);
	}

	_drawOrder(col) {
		const s = this._state, p = this._panel();
		const host = p && p.querySelector(".gp-orderlist");
		if (!host) return;
		host.innerHTML = "";
		const list = this._orderList(col);
		const left = s.exclude[col.guid] || (s.exclude[col.guid] = new Set());

		list.forEach((f, i) => {
			const out = left.has(f.id);
			const row = document.createElement("div");
			row.className = "gp-orderrow" +
				(s.dragIdx === i ? " is-dragging" : (f.isNew && !out ? " is-new" : ""));
			row.setAttribute("data-sort", String(i));
			row.innerHTML = '<span class="gp-grip">&#10303;</span>' +
				'<span class="gp-ordername' + (out ? " is-out" : "") + '">' + this._esc(f.label) +
				'</span><span class="gp-ordertype">' + this._esc(f.type) + "</span>";
			if (f.isNew) {
				const t = document.createElement("button");
				t.className = "gp-ordertoggle";
				t.innerHTML = this._cb(!out, 13) +
					'<span class="gp-tag' + (out ? " is-out" : "") + '">' +
					(out ? "LEFT OUT" : "NEW") + "</span>";
				t.addEventListener("click", (e) => {
					e.stopPropagation();
					if (out) left.delete(f.id); else left.add(f.id);
					this._drawOrder(col);
					this._syncOrderFooter(col);
				});
				row.appendChild(t);
			} else {
				this._add(row, '<span class="gp-orderold">already there</span>');
			}
			host.appendChild(row);
		});
		this._sortable(host, (from, to) => {
			const arr = s.order[col.guid];
			const [it] = arr.splice(from, 1);
			arr.splice(to, 0, it);
			s.dragIdx = to;
			this._drawOrder(col);
		}, () => { s.dragIdx = null; this._drawOrder(col); });
		this._syncOrderFooter(col);
	}

	_syncOrderFooter(col) {
		const s = this._state, p = this._panel();
		if (!p) return;
		const note = p.querySelector(".gp-ordernote");
		if (note) {
			const tpl = { fields: this._unionFields() };
			const plan = this._plan(tpl, col.api.getConfiguration());
			const left = s.exclude[col.guid] || new Set();
			const parts = [];
			if (plan.skip.length) {
				parts.push("Skipped, already in " + col.name + ": " +
					plan.skip.map((k) => k.field.label).join(", ") + ".");
			}
			if (left.size) {
				const names = this._orderList(col).filter((f) => left.has(f.id)).map((f) => f.label);
				parts.push("Left out of this apply: " + names.join(", ") + ".");
			}
			parts.push("Adding never touches an existing property. Dragging one to a new " +
				"position does change the collection's order.");
			note.textContent = parts.join(" ");
		}
		const b = p.querySelector(".gp-primary");
		if (b) b.disabled = this._orderAddCount() === 0;
		const fn = p.querySelector(".gp-footnote");
		if (fn) fn.textContent = this._addSummary();
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
	/* Which keys actually define a property, PER TYPE. Anything outside this is
	 * either per collection (`id`), decoration (`icon`), or leftover from a type
	 * the property used to be.
	 *
	 * That last case is not hypothetical: nine "Due Date" datetime properties
	 * matched each other, while the ones in Groceries and Recipes each listed
	 * separately because they still carried a `choices` array from back when
	 * they were choice fields. Every one of those options was `active: false`.
	 * Dead data, invisible in the UI, meaningless to a datetime property, and it
	 * split one row into three with nothing on screen to explain why. An
	 * allowlist keyed on the type cannot be fooled that way; a denylist of
	 * "ignore id and icon" was. */
	static SIG_KEYS_BY_TYPE = {
		choice: ["choices"],
		record: ["filter_colguid"],
		number: ["number_format"],
		text: ["min_length"],
	};

	_propSignature(f) {
		// The LABEL is part of the identity. Leaving it out collapsed every
		// datetime field in the workspace into one row (178 rows became 92) and
		// made "Due Date" disappear behind whichever label won the group.
		const o = { label: (f.label || "").trim(), type: f.type,
			many: !!f.many, read_only: !!f.read_only };
		for (const k of (Plugin.SIG_KEYS_BY_TYPE[f.type] || [])) {
			if (f[k] === undefined) continue;
			// Archived options are not part of what a choice property does.
			o[k] = (k === "choices" && Array.isArray(f[k]))
				? f[k].filter((c) => c && c.active !== false)
					.map((c) => ({ label: c.label, color: String(c.color) }))
				: f[k];
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
			// Members of a group can still differ in ways the signature ignores
			// (icon, dead keys from a former type). Copying has to pick one, so
			// key the variants on the FULL definition and prefer the one the
			// most collections use, breaking ties toward the leanest object so
			// a copy does not carry another collection's leftovers.
			const vk = JSON.stringify(r.field, Object.keys(r.field).sort());
			if (!g.variants.has(vk)) {
				g.variants.set(vk, { field: r.field, n: 0, keys: Object.keys(r.field).length });
			}
			g.variants.get(vk).n++;
		}
		const out = [];
		for (const g of bySig.values()) {
			let best = null;
			for (const v of g.variants.values()) {
				if (!best || v.n > best.n || (v.n === best.n && v.keys < best.keys)) best = v;
			}
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

	async _doApply() {
		const s = this._state;
		if (!s || s.busy) return;
		s.busy = true;
		const btn = this._panel() && this._panel().querySelector(".gp-primary");
		if (btn) { btn.disabled = true; btn.textContent = "Adding…"; }

		const tpl = { fields: this._unionFields() };
		const targets = this._chosenTargets();
		// Sequential, not Promise.all: each apply is a config write to a
		// different plugin, and letting them overlap buys nothing while making
		// a partial failure much harder to report accurately.
		const done = [], failed = [];
		for (const col of targets) {
			try {
				// Both the opt-outs and the order are per collection now, decided
				// on step 2 against that collection's own field list.
				const res = await this._apply(tpl, col,
					s.exclude[col.guid] || new Set(), s.order[col.guid] || null);
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

	/* Templates — a card each, with two buttons: Add To (filled accent) and
	 * Edit. Everything that MUTATES a template lives inside Edit, so it takes
	 * one deliberate step: the name becomes an input, chips gain a drop ×, the
	 * property list can be grown, and Delete Template sits at the bottom. Add To
	 * is hidden while editing, so there is one exit and it is labelled Done. */
	_renderManage(parent) {
		const s = this._state;
		const screen = this._screen(parent);

		const head = this._padTop(screen);
		this._add(head, '<div class="gp-h2">Templates</div>' +
			'<div class="gp-blurb">A saved set of properties you can add to any collection ' +
			"in one step.</div>");

		const body = document.createElement("div");
		body.className = "gp-tplbody gp-scroll";
		for (const t of s.store.templates) body.appendChild(this._templateCard(t));
		if (!s.store.templates.length && !s.newTpl) {
			this._add(body, '<div class="gp-emptycard">No templates yet. Save a set of ' +
				"properties from any collection and it becomes one step here.</div>");
		}
		if (s.newTpl) body.appendChild(this._newTemplateCard());
		screen.appendChild(body);

		const foot = document.createElement("div");
		foot.className = "gp-footbar gp-footbar-solo";
		const add = document.createElement("button");
		add.className = "gp-dashed gp-dashed-lg";
		add.textContent = "+ New Template";
		add.addEventListener("click", () => {
			s.newTpl = this._blankTemplate(s.cols);
			s.tplEditing = null; s.tplAdding = null;
			this._render();
		});
		foot.appendChild(add);
		screen.appendChild(foot);
	}

	_templateCard(t) {
		const s = this._state;
		const editing = s.tplEditing === t.id;
		const card = document.createElement("div");
		card.className = "gp-tplcard";

		const head = document.createElement("div");
		head.className = "gp-tplhead";
		const main = document.createElement("div");
		main.className = "gp-tplmain";
		if (editing) {
			const inp = document.createElement("input");
			inp.className = "gp-tplname";
			inp.type = "text";
			inp.value = s.tplDraft;
			inp.addEventListener("keydown", (e) => e.stopPropagation());
			inp.addEventListener("input", () => { s.tplDraft = inp.value; });
			inp.addEventListener("blur", () => this._commitRename(t));
			main.appendChild(inp);
		} else {
			this._add(main, '<div class="gp-tpltitle">' + this._esc(t.name) + "</div>");
		}
		this._add(main, '<div class="gp-tplmeta">' + t.fields.length +
			(t.fields.length === 1 ? " property" : " properties") +
			" · from " + this._esc(t.srcName) + "</div>");
		head.appendChild(main);

		const acts = document.createElement("div");
		acts.className = "gp-tplacts";
		if (!editing) {
			const apply = document.createElement("button");
			apply.className = "gp-addto";
			apply.textContent = "Add To";
			apply.addEventListener("click", () => {
				// Jumps to Add Properties with this template preselected, which is
				// where the template expands into its properties.
				s.screen = "apply"; s.step = 1;
				s.tplIds = new Set([t.id]); s.propKeys = new Set();
				s.targetGuids = new Set(); s.order = {}; s.exclude = {};
				s.query = ""; s.colQuery = "";
				this._render();
			});
			acts.appendChild(apply);
		}
		const edit = document.createElement("button");
		edit.className = "gp-tpledit" + (editing ? " is-on" : "");
		edit.textContent = editing ? "Done" : "Edit";
		edit.addEventListener("click", () => {
			if (editing) { this._commitRename(t); s.tplEditing = null; s.tplAdding = null; }
			else { s.tplEditing = t.id; s.tplDraft = t.name; s.tplAdding = null; }
			this._render();
		});
		acts.appendChild(edit);
		head.appendChild(acts);
		card.appendChild(head);

		const chips = document.createElement("div");
		chips.className = "gp-tplchips";
		for (const f of t.fields) {
			const chip = document.createElement("span");
			chip.className = "gp-tplchip";
			chip.innerHTML = '<span class="gp-tplchipname">' + this._esc(f.label) +
				'</span><span class="gp-tplchiptype">' + this._esc(f.type) + "</span>";
			if (editing) {
				const x = document.createElement("button");
				x.className = "gp-tplchipx";
				x.textContent = "×";
				x.addEventListener("click", () => this._dropFromTemplate(t, f.id));
				chip.appendChild(x);
			}
			chips.appendChild(chip);
		}
		card.appendChild(chips);

		if (editing) card.appendChild(this._templateEditor(t));
		return card;
	}

	/** The editing half of a card: grow the template, or delete it. */
	_templateEditor(t) {
		const s = this._state;
		const wrap = document.createElement("div");
		wrap.className = "gp-tpledit-body";

		if (s.tplAdding === t.id) {
			const box = document.createElement("div");
			box.className = "gp-tpladd";
			const bar = document.createElement("div");
			bar.className = "gp-tpladdbar";
			const list = document.createElement("div");
			list.className = "gp-candlist";
			// The list is drawn against its own element, not looked up in the
			// panel: this card is still being built and is not in the DOM yet.
			this._search(bar, "Search properties in the workspace…", s.tplAddQuery, (v) => {
				s.tplAddQuery = v;
				this._drawCandidates(t, list);
			});
			this._quiet(bar, "Done Adding", () => { s.tplAdding = null; this._render(); });
			box.appendChild(bar);
			box.appendChild(list);
			wrap.appendChild(box);
			this._drawCandidates(t, list);
		} else {
			const b = document.createElement("button");
			b.className = "gp-dashed";
			b.textContent = "+ Add Properties to This Template";
			b.addEventListener("click", () => {
				s.tplAdding = t.id; s.tplAddQuery = "";
				this._render();
			});
			wrap.appendChild(b);
		}

		const foot = document.createElement("div");
		foot.className = "gp-tplfoot";
		this._add(foot, '<div class="gp-tplfoottext">Rename it above, or drop a property to ' +
			"stop the template carrying it. Properties already added to collections are " +
			"untouched.</div>");
		const del = document.createElement("button");
		del.className = "gp-danger";
		del.textContent = "Delete Template";
		del.addEventListener("click", () => this._deleteTemplate(t));
		foot.appendChild(del);
		wrap.appendChild(foot);
		return wrap;
	}

	/** Every property in the workspace this template does not already carry. */
	_drawCandidates(t, host) {
		const s = this._state;
		if (!host) return;
		host.innerHTML = "";
		const have = new Set(t.fields.map((f) => this._norm(f.label)));
		const q = s.tplAddQuery || "";
		let shown = 0;
		for (const g of this._propertyGroups()) {
			if (have.has(this._norm(g.field.label))) continue;
			if (q && this._score(g.field.label, q) <= 0) continue;
			shown++;
			const b = document.createElement("button");
			b.className = "gp-candrow";
			b.innerHTML = '<span class="gp-candplus">+</span>' +
				'<span class="gp-candname">' + this._esc(g.field.label) + "</span>" +
				'<span class="gp-candmeta">' + this._esc(g.field.type + " · in " + g.cols[0]) + "</span>";
			b.addEventListener("click", () => this._addToTemplate(t, g.field));
			host.appendChild(b);
		}
		if (!shown) {
			this._add(host, '<div class="gp-candempty">No properties left to add.</div>');
		}
	}

	// ── template mutations, all staged, never flushed mid-dialog ────────────

	_commitRename(t) {
		const s = this._state;
		const name = (s.tplDraft || "").trim();
		if (!name || name === t.name) return;
		const store = this._loadStore();
		const row = store.templates.find((x) => x.id === t.id);
		if (!row) return;
		row.name = name;
		s.store = this._stageStore(store);
	}

	_addToTemplate(t, field) {
		const s = this._state;
		const store = this._loadStore();
		const row = store.templates.find((x) => x.id === t.id);
		if (!row) return;
		if (row.fields.some((f) => this._norm(f.label) === this._norm(field.label))) return;
		row.fields.push(JSON.parse(JSON.stringify(field)));
		s.store = this._stageStore(store);
		this._render();
	}

	_dropFromTemplate(t, fieldId) {
		const s = this._state;
		const store = this._loadStore();
		const row = store.templates.find((x) => x.id === t.id);
		if (!row) return;
		row.fields = row.fields.filter((f) => f.id !== fieldId);
		s.store = this._stageStore(store);
		this._render();
	}

	_deleteTemplate(t) {
		const s = this._state;
		const store = this._loadStore();
		store.templates = store.templates.filter((x) => x.id !== t.id);
		s.store = this._stageStore(store);
		// Deleting a template also clears it from any pending Add selection,
		// or the next Continue would carry a template that no longer exists.
		s.tplIds.delete(t.id);
		s.tplEditing = null;
		s.tplAdding = null;
		this._render();
		this._toast("Deleted “" + t.name + "”. Properties already added to collections are untouched.");
	}

	// ── new template ────────────────────────────────────────────────────────

	_blankTemplate(cols) {
		const first = (cols || []).find((c) => this._userFields(c.api.getConfiguration()).length);
		return {
			from: first ? first.guid : null,
			picked: new Set(first
				? this._userFields(first.api.getConfiguration()).map((f) => f.id) : []),
			name: "",
		};
	}

	_newTemplateCard() {
		const s = this._state, n = s.newTpl;
		const card = document.createElement("div");
		card.className = "gp-newtpl";
		this._add(card, '<div class="gp-newtpltitle">New Template</div>');

		const grid = document.createElement("div");
		grid.className = "gp-newtplgrid";

		const left = document.createElement("div");
		left.className = "gp-newtplcol";
		this._add(left, '<div class="gp-caps">FROM COLLECTION</div>');
		const colList = document.createElement("div");
		colList.className = "gp-newtpllist";
		for (const c of s.cols) {
			if (!this._userFields(c.api.getConfiguration()).length) continue;
			const b = document.createElement("button");
			b.className = "gp-newtplcoll" + (c.guid === n.from ? " is-on" : "");
			b.innerHTML = this._colIcon(c) + "<span>" + this._esc(c.name) + "</span>";
			b.addEventListener("click", () => {
				n.from = c.guid;
				n.picked = new Set(this._userFields(c.api.getConfiguration()).map((f) => f.id));
				this._render();
			});
			colList.appendChild(b);
		}
		left.appendChild(colList);
		grid.appendChild(left);

		const right = document.createElement("div");
		right.className = "gp-newtplcol";
		this._add(right, '<div class="gp-caps">PROPERTIES TO KEEP</div>');
		const fieldList = document.createElement("div");
		fieldList.className = "gp-newtpllist";
		const src = s.cols.find((c) => c.guid === n.from);
		for (const f of (src ? this._userFields(src.api.getConfiguration()) : [])) {
			const on = n.picked.has(f.id);
			const b = document.createElement("button");
			b.className = "gp-newtplfield";
			b.innerHTML = this._cb(on, 13) +
				'<span class="gp-newtplfname">' + this._esc(f.label) + "</span>" +
				'<span class="gp-newtplftype">' + this._esc(f.type) + "</span>";
			b.addEventListener("click", () => {
				if (on) n.picked.delete(f.id); else n.picked.add(f.id);
				this._render();
			});
			fieldList.appendChild(b);
		}
		right.appendChild(fieldList);
		grid.appendChild(right);
		card.appendChild(grid);

		const bar = document.createElement("div");
		bar.className = "gp-newtplbar";
		const name = document.createElement("input");
		name.className = "gp-newtplinput";
		name.type = "text";
		name.placeholder = "Template name";
		name.value = n.name;
		name.addEventListener("keydown", (e) => e.stopPropagation());
		name.addEventListener("input", () => {
			n.name = name.value;
			const b = this._panel().querySelector(".gp-newtplsave");
			if (b) b.disabled = !(n.name.trim() && n.picked.size);
		});
		bar.appendChild(name);
		this._quiet(bar, "Cancel", () => { s.newTpl = null; this._render(); });
		const save = this._primary(bar, "Save Template", () => this._saveNewTemplate(),
			!!(n.name.trim() && n.picked.size));
		save.classList.add("gp-newtplsave");
		card.appendChild(bar);
		return card;
	}

	_saveNewTemplate() {
		const s = this._state, n = s.newTpl;
		if (!n || s.busy) return;
		const src = s.cols.find((c) => c.guid === n.from);
		if (!src) return;
		const name = (n.name || "").trim();
		const fields = this._userFields(src.api.getConfiguration()).filter((f) => n.picked.has(f.id));
		if (!name || !fields.length) return;
		const store = this._loadStore();
		store.templates.push({
			id: "T" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase(),
			name,
			srcGuid: src.guid,
			srcName: src.name,
			at: new Date().toISOString(),
			fields: JSON.parse(JSON.stringify(fields)),
		});
		// Stage, do not flush: the config write reloads the plugin, so it waits
		// until the dialog closes and lands on an empty screen.
		s.store = this._stageStore(store);
		s.newTpl = null;
		this._render();
		this._toast("Saved “" + name + "” with " + fields.length + " " +
			(fields.length === 1 ? "property" : "properties") + ".");
	}


	// ══════════════════════════════════════════════════════════════════════
	// Screen: Change — the one non-additive act
	// ══════════════════════════════════════════════════════════════════════

	/* Reached ONLY from the drifted-property row in Add Properties, never from
	 * the sidebar. You only learn a definition has drifted while looking at that
	 * property, and entering from the row fixes the direction for free: the
	 * version you are standing on is the one the others will match. A menu item
	 * would also advertise the one destructive operation as a peer of Add.
	 *
	 * It looks different on purpose: amber badge, amber button, never the teal
	 * the additive screens use. Red is reserved for the single case with no fix
	 * on this screen — a field another plugin keeps paired. */

	/** Which behavioural keys conform. `id` and `label` deliberately do NOT:
	 *  record values key on the id, so replacing rather than conforming would
	 *  mint a new one and orphan every stored value. */
	static CONFORM_KEYS = ["type", "many", "filter_colguid", "choices",
		"number_format", "read_only", "icon"];

	/** Every collection carrying a DIFFERENT definition of this property name,
	 *  with the change each one would take, in the design's wording:
	 *  verb, what, from A -> B. Never "was". */
	_changeRows() {
		const s = this._state;
		const src = this._propertyGroups().find((g) => g.key === s.changeSrcKey);
		if (!src) return { src: null, rows: [] };
		const want = src.field;
		const rows = [];
		for (const r of this._allProperties()) {
			if (this._norm(r.field.label) !== this._norm(want.label)) continue;
			if (this._propSignature(r.field) === this._propSignature(want)) continue;
			const changes = this._changeLines(r.field, want);
			if (!changes.length) continue;
			rows.push({ col: r.col, field: r.field, changes,
				// A change that drops values is the one that costs records. A type
				// change costs EVERY value in the field: stored values do not
				// survive being reinterpreted as another type.
				costKind: r.field.type !== want.type ? "all"
					: (r.field.many && !want.many ? "extra" : "none") });
		}
		return { src, rows: rows.sort((a, b) => a.col.name.localeCompare(b.col.name)) };
	}

	_changeLines(have, want) {
		const out = [];
		if (have.type !== want.type) {
			out.push("changes type from " + have.type + " → " +
				(want.type === "record"
					? "link to " + (this._state.colNames[want.filter_colguid] || "another collection")
					: want.type));
		}
		if (!!have.many !== !!want.many) {
			out.push("changes values from " + (have.many ? "multiple → single" : "single → multiple"));
		}
		if (have.type === want.type && have.type === "record" &&
			have.filter_colguid !== want.filter_colguid) {
			out.push("changes links from " +
				(this._state.colNames[have.filter_colguid] || "nothing") + " → " +
				(this._state.colNames[want.filter_colguid] || "nothing"));
		}
		if (have.type === want.type && have.type === "choice" &&
			JSON.stringify((have.choices || []).filter((c) => c.active !== false).map((c) => c.label)) !==
			JSON.stringify((want.choices || []).filter((c) => c.active !== false).map((c) => c.label))) {
			out.push("changes the options to match");
		}
		if (have.type === want.type && have.type === "number" &&
			have.number_format !== want.number_format) {
			out.push("changes number format from " + (have.number_format || "plain") +
				" → " + (want.number_format || "plain"));
		}
		if (!!have.read_only !== !!want.read_only) {
			out.push(want.read_only ? "makes it read-only" : "makes it editable");
		}
		return out;
	}

	/** How many records this change costs, counted from the real records. Loaded
	 *  once per collection and cached, because it is the expensive part of the
	 *  screen and the popover asks for it again on every hover. */
	_cost(row) {
		const s = this._state;
		const key = row.col.guid + ":" + row.field.id;
		if (s.costCache[key]) return s.costCache[key];
		s.costCache[key] = "loading";
		// Loaded even when the change costs nothing, because the DENOMINATOR is
		// the informative half: "0 of 972" says the change is safe across a big
		// collection, where a bare "0" says nothing. Reading the records is the
		// same fetch either way; only the per-record value read is skipped.
		//
		// getAllRecords() is a PROMISE on a collection and synchronous on the
		// data API. Called without await it returns a Promise whose .slice()
		// throws mid-render and the screen comes up empty.
		Promise.resolve(row.col.api.getAllRecords()).then((recs) => {
			const all = recs || [];
			const hits = [];
			if (row.costKind !== "none") {
				for (const rec of all) {
					const vals = this._valuesOf(rec, row.field);
					if (row.costKind === "all" ? vals.length > 0 : vals.length > 1) {
						if (hits.length < 3) hits.push({ title: rec.getName() || "(untitled)", values: vals });
						else hits.push(null);
					}
				}
			}
			s.costCache[key] = { holds: hits.length, total: all.length,
				samples: hits.filter(Boolean) };
			if (this._state === s) this._render();
		}).catch(() => { s.costCache[key] = { holds: 0, total: null, samples: [] }; });
		return "loading";
	}

	/** A collection's records in the order THYMER lists them.
	 *
	 *  Read out of the app's own bundle rather than guessed: getRecordsInWorkspace()
	 *  ends in `sortByField(records, getDefaultRecordSortField(), getDefaultRecordSortDir())`,
	 *  and those two read `sidebar_record_sort_field_id` and `sidebar_record_sort_dir`
	 *  off the collection's config, falling back to the title ascending. Its own
	 *  record-property picker then lists that array UNSORTED, so this is the whole
	 *  of the order a value picker should show.
	 *
	 *  Neither the plain store order nor alphabetical is it. In this workspace 65
	 *  of 67 collections say `updated_at desc`, GTD says `created_at asc`,
	 *  Life Mngmt. sorts on the Collection field and Applications on a user field,
	 *  so the field cannot be special-cased down to the timestamps. */
	_hostSorted(recs, col) {
		let cfg = {};
		try { cfg = col.api.getConfiguration() || {}; } catch (e) {}
		const fieldId = cfg.sidebar_record_sort_field_id || "title";
		const dir = cfg.sidebar_record_sort_dir === "desc" ? -1 : 1;
		const field = (cfg.fields || []).find((f) => f.id === fieldId) || null;
		return recs
			.map((r, i) => ({ r, i, k: this._hostSortKey(r, fieldId, field) }))
			.sort((a, b) => {
				// A missing value sorts LAST in BOTH directions: the host tests for
				// null before it applies the direction, so an empty record never
				// floats to the top of a descending list. The original index is the
				// final tie-break, which keeps the sort stable across re-renders.
				if (a.k == null && b.k == null) return a.i - b.i;
				if (a.k == null) return 1;
				if (b.k == null) return -1;
				const c = typeof a.k === "string"
					? a.k.localeCompare(b.k, undefined, { sensitivity: "base" })
					: (a.k < b.k ? -1 : a.k > b.k ? 1 : 0);
				return (dir * c) || a.i - b.i;
			})
			.map((x) => x.r);
	}

	/** The one value a record is sorted on. The three built-ins come off the
	 *  record itself; any other field is read as its own type so a date sorts as
	 *  a date and a number as a number, and anything else by the label it shows
	 *  as — which is also what keeps a record-type sort field (Life Mngmt.) from
	 *  being ordered by raw guid. */
	_hostSortKey(rec, fieldId, field) {
		try {
			if (fieldId === "created_at") { const d = rec.getCreatedAt(); return d ? +d : null; }
			if (fieldId === "updated_at") { const d = rec.getUpdatedAt(); return d ? +d : null; }
			if (fieldId === "title" || !field) return rec.getName() || "";
			if (field.type === "datetime") {
				const p = rec.prop(field.id), d = p && p.datetime ? p.datetime() : null;
				return d ? +d : null;
			}
			if (field.type === "number") {
				const p = rec.prop(field.id), n = p ? p.number() : null;
				return n === null || n === undefined ? null : n;
			}
			const vals = this._valuesOf(rec, field);
			return vals.length ? String(vals[0]) : null;
		} catch (e) { return null; }
	}

	/** Every value a record holds in this field, as labels. */
	_valuesOf(rec, field) {
		try {
			// `.prop(id)` — records do NOT have getProperty(). Calling it threw
			// into the catch below, so every record cost on the Change screen
			// silently counted zero.
			const prop = rec.prop(field.id);
			if (!prop) return [];
			switch (field.type) {
				case "record": {
					const rs = prop.records ? prop.records() : null;
					if (rs) return rs.map((r) => (r && r.getName ? r.getName() : "a record") || "a record");
					const one = prop.linkedRecord();
					return one ? [one.getName() || "a record"] : [];
				}
				case "choice": {
					const cs = prop.selectedChoices ? prop.selectedChoices() : null;
					return (cs || []).map((c) => (c && c.label) || String(c));
				}
				case "number": {
					const ns = prop.numbers ? prop.numbers() : null;
					if (ns) return ns.map(String);
					const n = prop.number();
					return n === null || n === undefined ? [] : [String(n)];
				}
				case "datetime": {
					const ds = prop.datetimes ? prop.datetimes() : null;
					if (ds) return ds.map((d) => (d && d.value ? String(d.value()) : "a date"));
					const d = prop.date();
					return d ? [String(d)] : [];
				}
				default: {
					const ts = prop.texts ? prop.texts() : null;
					if (ts) return ts.filter((t) => t !== null && t !== "");
					const t = prop.text();
					return t ? [t] : [];
				}
			}
		} catch (e) { return []; }
	}

	/** Fields another plugin keeps paired. Bidirectional Fields mirrors by NAME,
	 *  so changing this one's link target breaks the pairing — and that is the
	 *  one thing this screen cannot fix, which is why it is the only red. */
	async _loadSynced() {
		const s = this._state;
		if (s.syncedNames) return;
		s.syncedNames = new Set();
		try {
			const all = await this.data.getAllGlobalPlugins() || [];
			for (const pl of all) {
				let cfg = null;
				try { cfg = pl.getConfiguration(); } catch (e) { continue; }
				if (!cfg || cfg.off) continue;
				const c = cfg.custom || {};
				// Its pairs live under whichever key it uses; take any object that
				// carries a pair of field NAMES.
				for (const v of Object.values(c)) {
					for (const pair of (v && Array.isArray(v.pairs) ? v.pairs : [])) {
						if (pair && pair.a) s.syncedNames.add(this._norm(pair.a));
						if (pair && pair.b) s.syncedNames.add(this._norm(pair.b));
					}
				}
			}
		} catch (e) {}
		if (this._state === s) this._render();
	}

	async _renderChange(parent) {
		const s = this._state;
		this._loadSynced();
		const { src, rows } = this._changeRows();
		const screen = this._screen(parent);

		const head = this._padTop(screen);
		this._add(head, '<div class="gp-changehead">' +
			'<span class="gp-changebadge">CHANGES EXISTING FIELDS</span>' +
			'<div class="gp-changetitle">Change ' + this._esc(s.changeName) +
			" to Match One Definition</div></div>" +
			'<div class="gp-blurb gp-blurb-660">Every other add in this plugin only adds. ' +
			"This one edits fields that already exist. The field keeps its name, its id and " +
			"its values — only its behaviour changes.</div>");

		const body = this._padScroll(screen);
		if (!src || !rows.length) {
			this._add(body, '<div class="gp-blurb">Nothing to change: every collection ' +
				"already carries the same definition of this property.</div>");
			this._changeFooter(screen, []);
			return;
		}

		// The direction, as a sentence rather than a jargon label.
		this._add(body, '<div class="gp-changeband">' +
			'<span class="gp-bandtext">Every ticked collection will match</span>' +
			'<span class="gp-bandprop">' + this._esc(src.field.label) + "</span>" +
			'<span class="gp-bandtext">as it is in</span>' +
			'<span class="gp-bandprop">' + this._esc(src.cols[0]) + "</span>" +
			'<span class="gp-bandspec">— ' + this._esc(this._fieldDetail(src.field, s.colNames)) +
			"</span></div>");

		const grid = document.createElement("div");
		grid.className = "gp-changegrid";
		this._add(grid, "<div></div>" +
			'<div class="gp-caps-s">COLLECTION</div>' +
			'<div class="gp-caps-s">CHANGE</div>' +
			'<div class="gp-caps-s gp-right">RECORDS</div>' +
			'<div class="gp-gridrule"></div>');

		for (const row of rows) {
			const off = s.changeSkip.has(row.col.guid);
			const synced = s.syncedNames && s.syncedNames.has(this._norm(row.field.label));

			const tick = document.createElement("button");
			tick.className = "gp-changetick";
			tick.innerHTML = this._cb(!off, 13);
			tick.addEventListener("click", () => {
				if (off) s.changeSkip.delete(row.col.guid); else s.changeSkip.add(row.col.guid);
				s.changeConfirm = false;
				this._render();
			});
			grid.appendChild(tick);

			this._add(grid, '<div class="gp-changecol' + (off ? " is-off" : "") + '">' +
				this._colIcon(row.col) + "<span>" + this._esc(row.col.name) + "</span>" +
				(synced ? '<span class="gp-syncedtag">SYNCED</span>' : "") + "</div>");
			this._add(grid, '<div class="gp-changetext' + (off ? " is-off" : "") + '">' +
				this._esc(row.changes.join(" · ")) + "</div>");
			grid.appendChild(this._costCell(row, off));
		}
		body.appendChild(grid);
		this._add(body, '<div class="gp-changenote">Untick a collection to leave it exactly ' +
			"as it is.</div>");

		const syncedPicked = rows.filter((r) => !s.changeSkip.has(r.col.guid) &&
			s.syncedNames && s.syncedNames.has(this._norm(r.field.label)));
		if (syncedPicked.length) {
			this._add(body, '<div class="gp-syncedband">Bidirectional Fields keeps ' +
				this._esc(syncedPicked.map((r) => r.col.name).join(" and ")) +
				" paired on this field. Changing it breaks the pairing until you point that " +
				"rule at the same definition too.</div>");
		}

		this._changeFooter(screen, rows.filter((r) => !s.changeSkip.has(r.col.guid)));
	}

	/** The record cost, and the popover that names the records behind it. */
	_costCell(row, off) {
		const s = this._state;
		const cell = document.createElement("div");
		cell.className = "gp-costcell gp-anchor";
		const cost = this._cost(row);

		if (cost === "loading") {
			this._add(cell, '<span class="gp-cost">counting…</span>');
			return cell;
		}
		const label = cost.total === null ? String(cost.holds) : cost.holds + " of " + cost.total;
		const hot = !!cost.holds && !off;
		const span = document.createElement("span");
		span.className = "gp-cost" + (off ? " is-off" : hot ? " is-hot" : "");
		span.textContent = label;
		cell.appendChild(span);
		if (!hot) return cell;

		// Hover, not click, and the 5px offset is PADDING inside the hover area
		// rather than a gap — a real gap makes the popover close as the pointer
		// travels into it.
		cell.addEventListener("mouseenter", () => {
			if (s.costOpen === row.col.guid) return;
			s.costOpen = row.col.guid; this._render();
		});
		cell.addEventListener("mouseleave", () => {
			if (s.costOpen !== row.col.guid) return;
			s.costOpen = null; this._render();
		});
		if (s.costOpen === row.col.guid) {
			const pop = document.createElement("div");
			pop.className = "gp-pop gp-pop-cost";
			this._add(pop, '<div class="gp-popnote">' + cost.holds + " of " + cost.total +
				" records in " + this._esc(row.col.name) +
				(row.costKind === "all"
					? " hold a value in this field. Changing its type means none of them can be read back."
					: " hold more than one value. Only the first survives the change — the rest are " +
					  "dropped from the field.") + "</div>");
			const list = document.createElement("div");
			list.className = "gp-poplist gp-costlist";
			for (const sample of cost.samples) {
				this._add(list, '<div class="gp-costrow"><span class="gp-costtitle">' +
					this._esc(sample.title) + '</span><span class="gp-costvals">' +
					'<span class="gp-costkeep">' + this._esc(sample.values[0]) + "</span>" +
					(sample.values.length > 1
						? '<span class="gp-costlose"> · loses ' +
						  this._esc(sample.values.slice(1).join(", ")) + "</span>"
						: "") + "</span></div>");
			}
			pop.appendChild(list);
			if (cost.holds > cost.samples.length) {
				this._add(pop, '<div class="gp-costmore">and ' +
					(cost.holds - cost.samples.length) + " more</div>");
			}
			this._add(pop, '<div class="gp-poprule"></div>');
			const foot = document.createElement("div");
			foot.className = "gp-costfoot";
			const open = document.createElement("button");
			open.className = "gp-costlink";
			open.textContent = "Open This Collection";
			open.addEventListener("click", () => {
				this._closeModal();
				try { this.ui.navigateTo(row.col.api); } catch (e) {}
			});
			const leave = document.createElement("button");
			leave.className = "gp-costlink is-quiet";
			leave.textContent = "Leave This One Out";
			leave.addEventListener("click", () => {
				s.changeSkip.add(row.col.guid);
				s.costOpen = null; s.changeConfirm = false;
				this._render();
			});
			foot.appendChild(open);
			foot.appendChild(leave);
			pop.appendChild(foot);
			cell.appendChild(pop);
			this._placePop(cell, pop, "right");
		}
		return cell;
	}

	/* A confirm tick has to be set before the button is pressable. This is the
	 * only screen in the plugin that asks for one, because it is the only one
	 * that edits something that already exists. */
	_changeFooter(screen, picked) {
		const s = this._state;
		const bar = document.createElement("div");
		bar.className = "gp-footbar";
		const confirm = document.createElement("button");
		confirm.className = "gp-confirmbtn";
		confirm.innerHTML = '<span class="gp-cb gp-cb-16 gp-cb-warn' +
			(s.changeConfirm ? " is-on" : "") + '">' + (s.changeConfirm ? Plugin.TICK : "") +
			'</span><span class="gp-confirmlabel">' + (picked.length
				? "I understand this edits " + picked.length +
				  (picked.length === 1 ? " existing field" : " existing fields") + " in place."
				: "Nothing is ticked, so nothing will change.") + "</span>";
		confirm.addEventListener("click", () => {
			s.changeConfirm = !s.changeConfirm; this._render();
		});
		bar.appendChild(confirm);
		const acts = document.createElement("div");
		acts.className = "gp-footacts";
		bar.appendChild(acts);
		screen.appendChild(bar);

		this._quiet(acts, "Cancel", () => {
			s.screen = "apply"; s.changeName = null; s.changeSrcKey = null;
			s.changeSkip = new Set(); s.changeConfirm = false; s.costOpen = null;
			this._render();
		});
		const go = document.createElement("button");
		go.className = "gp-warnbtn";
		go.textContent = picked.length
			? "Change " + picked.length + (picked.length === 1 ? " Collection" : " Collections")
			: "Change";
		go.disabled = !(s.changeConfirm && picked.length);
		go.addEventListener("click", () => { if (!go.disabled) this._doChange(picked); });
		acts.appendChild(go);
	}

	/* Conform IN PLACE. The field keeps its id and its label; only the
	 * behavioural keys are overwritten. Remove-and-re-add would mint a new id
	 * and orphan every value the field holds, which is the whole reason this is
	 * a conform and not a replace. */
	async _doChange(picked) {
		const s = this._state;
		if (!s || s.busy) return;
		s.busy = true;
		const { src } = this._changeRows();
		if (!src) { s.busy = false; return; }

		const done = [], failed = [];
		for (const row of picked) {
			try {
				const live = row.col.api.getConfiguration();
				const next = JSON.parse(JSON.stringify(live));
				const target = (next.fields || []).find((f) => f.id === row.field.id);
				if (!target) { failed.push(row.col.name); continue; }
				for (const k of Plugin.CONFORM_KEYS) {
					if (src.field[k] === undefined) delete target[k];
					else target[k] = JSON.parse(JSON.stringify(src.field[k]));
				}
				const ok = await row.col.api.saveConfiguration(next);
				if (ok) done.push(row.col.name); else failed.push(row.col.name);
			} catch (e) { failed.push(row.col.name); }
		}
		this._closeModal();
		if (!failed.length) {
			this._toast("Changed " + s.changeName + " in " + done.length +
				(done.length === 1 ? " collection." : " collections."));
		} else {
			this._toast("Changed " + done.length + ". Failed on: " + failed.join(", ") + ".");
		}
	}

	// ══════════════════════════════════════════════════════════════════════
	// Screen: Fill From Title — a page's properties, read out of its own title
	// ══════════════════════════════════════════════════════════════════════

	/* "1:1 with John Doe" should give a Meetings page attendees John Doe, the
	 * company John works at, and type 1:1. This screen proposes exactly that,
	 * from the title of the page you are on, and writes what you tick.
	 *
	 * COMMAND-INVOKED, NOT EVENT-DRIVEN. A page has no title when it is
	 * created, so record.created is useless here, and record.updated would mean
	 * debouncing a title as it is typed and fighting the edit. Running it as a
	 * command on the page in front of you deletes the timing problem and earns
	 * a preview.
	 *
	 * Three sources, in the order they are tried:
	 *   choice  — an option label found in the title
	 *   record  — a record NAME found in the title, scoped to the collection the
	 *             field points at (only fields WITH a target collection: an
	 *             unscoped one would mean loading the whole workspace, 1.1s on
	 *             Parham's, and it is skipped, visibly)
	 *   follow  — a record field with no direct hit takes the value another
	 *             matched record holds in ITS field pointing at the same
	 *             collection ("John Doe" -> John's company). Ticked only when
	 *             there is exactly one candidate.
	 *
	 * The preview IS the safety story. A blank field with a match is a ticked
	 * line. A multi-value field ADDS, so its lines are ticked even when the field
	 * already holds something. A single-value field that already holds a
	 * DIFFERENT value goes under ALSO FOUND, unticked, showing current -> found,
	 * in amber because it replaces something that exists. A field that already
	 * holds the match is not shown at all. No confirm tick: the ticks are the
	 * consent, and every replace is one value on one record, ticked by hand.
	 *
	 * Matching is one regex per pool (every name as an alternative, longest
	 * first), so a 5,000-name collection is one pass over the title, not 5,000.
	 * Word boundaries are Unicode-aware because JS \b is ASCII-only and "Åsa"
	 * would never match. Three characters minimum: 595 of 16,896 names here are
	 * four or fewer, and "JD" / "mo" / "SL" fire on everything.
	 *
	 * Verified by replay against Parham's Logs (362 titles, six pools of 166 to
	 * 5,195 names): every unit case, 0.9ms per title on the largest pool, 52ms to
	 * compile all six once per open. */

	static FILL_SHORTCUT_DEFAULT = { key: "g", meta: true, shift: true, alt: false, ctrl: false };

	static _fillComboLabel(c) {
		if (!c) return "none";
		const parts = [];
		if (c.ctrl) parts.push("\u2303");
		if (c.alt) parts.push("\u2325");
		if (c.meta) parts.push("\u2318");
		if (c.shift) parts.push("\u21e7");
		parts.push(c.key.length === 1 ? c.key.toUpperCase() : c.key);
		return parts.join(" ");
	}

	static FILL_MIN_CHARS = 3;
	static FILL_PARTIAL_MAX = 3;

	static _fillEsc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

	/** Canonical form: lowercase, every run of non-letters/digits is ONE space.
	 *  Title and names are compared in this space, so "Konst&Kulturakademin"
	 *  and "Konst & Kulturakademin" are the same string and "1:1" is "1 1". The
	 *  first user title that missed was exactly that ampersand. */
	static _fillCanon(s) {
		return String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
	}

	static _fillIsUpper(w) { return !!w && w[0] !== w[0].toLowerCase() && w[0] === w[0].toUpperCase(); }

	/** ONE regex per pool: canonical names as alternatives, longest first, so at
	 *  any position the engine takes the longest name that fits ("John Doe"
	 *  before "John") and the global scan moves past it so nothing overlaps.
	 *  Also indexes the CAPITALISED words of every name for partial matching.
	 *  names: [{ name, id, rec? }] */
	static _fillCompilePool(names, loose) {
		const byKey = new Map(), byWord = new Map();
		for (const n of names || []) {
			const name = String(n.name || "").trim();
			if (name.length < Plugin.FILL_MIN_CHARS) continue;
			const k = Plugin._fillCanon(name);
			if (k.length < Plugin.FILL_MIN_CHARS) continue;
			if (!byKey.has(k)) byKey.set(k, { name, items: [] });
			byKey.get(k).items.push(n);
			const seen = new Set();
			for (const raw of name.split(/[^\p{L}\p{N}]+/u)) {
				if (raw.length < Plugin.FILL_MIN_CHARS || (!loose && !Plugin._fillIsUpper(raw))) continue;
				const w = raw.toLowerCase();
				if (seen.has(w)) continue;
				seen.add(w);
				if (!byWord.has(w)) byWord.set(w, []);
				byWord.get(w).push(n);
			}
		}
		// Bigrams of every name's canonical words, for PHRASE matching: a run
		// of title words that is most of a name ("Dokumentär i Världen" inside
		// "Ansökan till Dokumentär i världen").
		const byBigram = new Map();
		for (const [k, v] of byKey) {
			const w = k.split(" ");
			v.words = w;
			for (let i = 0; i + 1 < w.length; i++) {
				const bg = w[i] + " " + w[i + 1];
				if (!byBigram.has(bg)) byBigram.set(bg, []);
				byBigram.get(bg).push({ key: k, at: i });
			}
		}
		const keys = Array.from(byKey.keys()).sort((a, b) => b.length - a.length || a.localeCompare(b));
		if (!keys.length) return null;
		let re = null;
		try {
			re = new RegExp("(?<![\\p{L}\\p{N}])(?:" + keys.map(Plugin._fillEsc).join("|") +
				")(?![\\p{L}\\p{N}])", "yu");
		} catch (e) { return null; }
		return { re, byKey, byWord, byBigram };
	}

	/** Every pool item whose whole name occurs in the title, in title order.
	 *  Positions are in the canonical string.
	 *
	 *  At every word start the sticky regex yields the LONGEST name there, and
	 *  the shorter names ending at inner word boundaries are looked up directly,
	 *  so every name starting at that position is a candidate. Overlaps are then
	 *  resolved longest first, and a nested match is dropped ONLY when it comes
	 *  from the same collection as the one that claimed the span: "John" beside
	 *  "John Doe" among people is the false positive this exists for, while
	 *  "Dokumentär i Världen" (Applications) inside an Action titled "Möte om
	 *  Dokumentär i Världen" is two real links, and the first user title that
	 *  hit the workspace pool was exactly that. A scoped pool is one collection,
	 *  so there nothing nested ever survives, as before. */
	static _fillMatch(title, pool) {
		const c = Plugin._fillCanon(title);
		if (!c || !pool || !pool.re) return [];
		const cands = [];
		const add = (key, start) => {
			const hit = pool.byKey.get(key);
			if (!hit) return;
			for (const it of hit.items) cands.push({ item: it, name: hit.name, start, end: start + key.length });
		};
		for (let i = 0; i < c.length; i++) {
			if (i > 0 && c[i - 1] !== " ") continue;
			pool.re.lastIndex = i;
			const m = pool.re.exec(c);
			if (!m) continue;
			add(m[0], i);
			for (let j = i + 1; j < i + m[0].length; j++) if (c[j] === " ") add(c.slice(i, j), i);
		}
		cands.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
		const taken = [], out = [];
		for (const h of cands) {
			const col = h.item.colName || "";
			if (taken.some((t) => h.start < t.end && t.start < h.end &&
				!(t.start === h.start && t.end === h.end) && (t.item.colName || "") === col)) continue;
			taken.push(h);
			out.push(h);
		}
		return out.sort((a, b) => a.start - b.start || (b.end - a.end));
	}

	/** Partial matches, two tiers, both weaker than a whole name so the caller
	 *  never ticks them by default, and both capped: a word or phrase shared by
	 *  more than FILL_PARTIAL_MAX records proposes nothing rather than a list.
	 *
	 *  PHRASE: 2+ consecutive title words equal to a consecutive run of a name's
	 *  words covering at least half the name, one of them capitalised mid-title
	 *  ("Dokumentär i Världen" -> "Ansökan till Dokumentär i världen"; not
	 *  "Möte med", not "of the"). WORD: a capitalised title word (not the first, capitalised anyway)
	 *  equal to a capitalised word of a name ("Elin" -> the three Elins).
	 *  Measured on 362 real titles: 206 word suggestions, mostly right, against
	 *  1,153 before the capitalisation rule, most of them "and", "med", "för".
	 *  Positions are in the canonical string, same as _fillMatch's. */
	static _fillPartial(title, pool, taken, loose) {
		if (!title || !pool) return [];
		const out = [], seen = new Set();
		// Title words with their canonical positions: the canonical string is
		// the letter runs joined by single spaces.
		const words = [];
		const wordsRe = /[\p{L}\p{N}]+/gu;
		let m, cpos = 0;
		while ((m = wordsRe.exec(title))) {
			words.push({ raw: m[0], low: m[0].toLowerCase(), start: cpos, end: cpos + m[0].length });
			cpos += m[0].length + 1;
		}
		// A span claimed by a whole-name match blocks a partial from the SAME
		// collection only, like _fillMatch: the Habitat "Dokumentär" must not
		// hide the Application "Ansökan till Dokumentär i världen".
		const free = (a, b, it) => !(taken || []).some((t) => a < t.end && t.start < b &&
			(t.item.colName || "") === (it.colName || ""));
		// Phrase tier.
		const phrases = new Map();          // phrase -> Map(itemId -> {item, name, word})
		for (let i = 0; i + 1 < words.length && pool.byBigram; i++) {
			const cands = pool.byBigram.get(words[i].low + " " + words[i + 1].low);
			if (!cands) continue;
			for (const c of cands) {
				const v = pool.byKey.get(c.key), nw = v.words;
				let L = 0;
				while (i + L < words.length && c.at + L < nw.length && words[i + L].low === nw[c.at + L]) L++;
				if (L < 2 || L * 2 < nw.length) continue;
				// The same proper-noun signal as the word tier: some word of the
				// run is capitalised in the title and is not its first word.
				// Without it "Möte med" (2 of 3 words of "Möte med Polhemsgården")
				// fires on every meeting.
				if (!loose && !words.slice(i, i + L).some((w, x) => i + x > 0 && Plugin._fillIsUpper(w.raw))) continue;
				const phrase = words.slice(i, i + L).map((w) => w.raw).join(" ");
				for (const it of v.items) {
					if (!free(words[i].start, words[i + L - 1].end, it)) continue;
					if (!phrases.has(phrase)) phrases.set(phrase, new Map());
					if (!phrases.get(phrase).has(it.id)) phrases.get(phrase).set(it.id, { item: it, name: v.name, word: phrase });
				}
			}
		}
		for (const group of phrases.values()) {
			if (group.size > Plugin.FILL_PARTIAL_MAX) continue;
			for (const h of group.values()) { if (seen.has(h.item.id)) continue; seen.add(h.item.id); out.push(h); }
		}
		// Word tier.
		// LOOSE (choice options, a handful of labels): any position, any case;
		// "Contact med Mamdooh" should offer Contact Log.
		for (let k = loose ? 0 : 1; k < words.length; k++) {
			const w = words[k];
			if (w.raw.length < Plugin.FILL_MIN_CHARS || (!loose && !Plugin._fillIsUpper(w.raw))) continue;
			// "Aug" in a title must not drag in records that happen to be NAMED
			// like dates ("Wed, 16 Aug 2023"): a month or weekday is calendar
			// vocabulary, not identity.
			if (!loose && Plugin.FILL_DATE_WORDS.has(Plugin.FILL_SV[w.low] || w.low)) continue;
			const items = pool.byWord.get(w.low);
			if (!items || !items.length || items.length > Plugin.FILL_PARTIAL_MAX) continue;
			for (const it of items) {
				if (seen.has(it.id) || !free(w.start, w.end, it)) continue;
				seen.add(it.id);
				out.push({ item: it, name: it.name, word: w.raw });
			}
		}
		return out;
	}

	/** Thymer's own date parser, so a date read out of a title agrees with what
	 *  typing the same text into the field would give. Returns the value the
	 *  property setter wants, or null. */
	static _fillParseDate(text) {
		try {
			const dt = DateTime.parseDateTimeString(String(text || ""));
			return dt ? { value: dt.value(), dt } : null;
		} catch (e) { return null; }
	}

	/** A date's identity for "already holds it" and its label as Thymer shows
	 *  it (its own dayjs, so the format agrees with the field). */
	static _fillDateId(dt) {
		try { const q = dt.getParts(); return [q.year, q.month, q.day, q.hours, q.minutes].map((x) => x == null ? "" : x).join("-"); }
		catch (e) { return String(dt); }
	}

	static _fillDateLabel(dt) {
		try {
			const q = dt.getParts();
			if (q.year == null || q.month == null || q.day == null) return String(dt);
			const d = new Date(q.year, q.month, q.day, q.hours || 0, q.minutes || 0);
			const timed = q.hours != null;
			const thisYear = new Date().getFullYear() === q.year;
			const fmt = "ddd MMM D" + (thisYear ? "" : " YYYY") + (timed ? " h:mm A" : "");
			if (window.dayjs) return window.dayjs(d).format(fmt);
			return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric",
				year: thisYear ? undefined : "numeric" }).replace(/,/g, "");
		} catch (e) { return String(dt); }
	}

	/* Swedish -> English before Thymer's parser, which is English-only. Only
	 * the words that name a date; "kl" and the like are left alone. */
	static FILL_SV = {
		"idag": "today", "imorgon": "tomorrow", "igår": "yesterday", "nästa": "next", "kl": "at",
		"måndag": "monday", "tisdag": "tuesday", "onsdag": "wednesday", "torsdag": "thursday",
		"fredag": "friday", "lördag": "saturday", "söndag": "sunday",
		"mån": "mon", "tis": "tue", "ons": "wed", "tors": "thu", "fre": "fri", "lör": "sat", "sön": "sun",
		"januari": "january", "februari": "february", "mars": "march", "april": "april", "maj": "may",
		"juni": "june", "juli": "july", "augusti": "august", "september": "september",
		"oktober": "october", "november": "november", "december": "december",
		"jan": "jan", "feb": "feb", "mar": "mar", "apr": "apr", "jun": "jun", "jul": "jul",
		"aug": "aug", "sep": "sep", "sept": "sep", "okt": "oct", "nov": "nov", "dec": "dec",
	};
	static FILL_DATE_WORDS = new Set(["today", "tomorrow", "yesterday", "next", "monday", "tuesday",
		"wednesday", "thursday", "friday", "saturday", "sunday", "mon", "tue", "wed", "thu", "fri",
		"sat", "sun", "january", "february", "march", "april", "may", "june", "july", "august",
		"september", "october", "november", "december", "jan", "feb", "mar", "apr", "jun", "jul",
		"aug", "sep", "oct", "nov", "dec"]);
	static FILL_MONTHS = new Set(["january", "february", "march", "april", "may", "june", "july",
		"august", "september", "october", "november", "december", "jan", "feb", "mar", "apr",
		"jun", "jul", "aug", "sep", "oct", "nov", "dec"]);

	/** Dates written in a title. Windows of one to five words are offered to
	 *  Thymer's parser, longest first, non-overlapping. A window qualifies only
	 *  if it holds a date WORD (month, weekday, today/tomorrow) or a number
	 *  with a date separator (2026-05-12, 18/8, 12.5.2026): a bare "13" or
	 *  "2026" is never a date here ("Kian 13 år"), and a bare time never is.
	 *  Command-invoked, so "imorgon" resolves against the day you run it, which
	 *  is what you meant when you ran it. */
	static _fillDates(title) {
		const words = [];
		const re = /[\p{L}\p{N}][\p{L}\p{N}:./-]*/gu;
		let m;
		while ((m = re.exec(title))) {
			const raw = m[0].replace(/[:./-]+$/, "");        // "fredag:" is fredag
			if (raw) words.push({ raw, start: m.index, end: m.index + raw.length });
		}
		const norm = (w) => { const l = w.toLowerCase(); return Plugin.FILL_SV[l] || l; };
		const isSep = (w) => /^\d{1,4}[-./]\d{1,2}([-./]\d{1,4})?$/.test(w);
		const isTime = (w) => /^\d{1,2}:\d{2}$/.test(w);
		// Every word of a window must be date-ish, or "år kalas 2026-05-12" is
		// offered as one date with the junk in its label. And the window must
		// name a DAY, not just a month: "Aug 2026" in "Samtal med Cecilia Aug
		// 2026 del 2" is part of a NAME, and the parser would happily resolve
		// it to the 1st and propose replacing a correct date with it. Day
		// evidence is a separator date (18/8), a relative or weekday word, or
		// a month word WITH a standalone 1-31 beside it.
		const dateish = (w) => Plugin.FILL_DATE_WORDS.has(norm(w.raw)) || isSep(w.raw) || isTime(w.raw) ||
			/^\d{1,4}$/.test(w.raw) || norm(w.raw) === "at";
		const qualifies = (ws) => ws.every(dateish) && (
			ws.some((w) => isSep(w.raw)) ||
			ws.some((w) => { const n = norm(w.raw);
				return Plugin.FILL_DATE_WORDS.has(n) && !Plugin.FILL_MONTHS.has(n) && n !== "next"; }) ||
			(ws.some((w) => Plugin.FILL_MONTHS.has(norm(w.raw))) &&
				ws.some((w) => /^\d{1,2}$/.test(w.raw) && +w.raw >= 1 && +w.raw <= 31)));
		const out = [], taken = [];
		for (let L = 5; L >= 1; L--) {
			for (let i = 0; i + L <= words.length; i++) {
				const win = words.slice(i, i + L);
				if (taken.some((t) => win[0].start < t.end && t.start < win[L - 1].end)) continue;
				if (!qualifies(win)) continue;
				const r = Plugin._fillParseDate(win.map((w) => norm(w.raw)).join(" "));
				if (!r) continue;
				let q = null; try { q = r.dt.getParts(); } catch (e) {}
				if (!q || q.day == null || q.month == null) continue;   // year-only, time-only: no
				taken.push({ start: win[0].start, end: win[L - 1].end });
				out.push({ id: Plugin._fillDateId(r.dt), label: Plugin._fillDateLabel(r.dt), value: r.value,
					text: win.map((w) => w.raw).join(" ") });
			}
		}
		return out;
	}

	/** The page in front of the user, or null. Read from the active panel; the
	 *  collection comes off the record's OWN `collection` property because
	 *  panel.getActiveCollection() is null in the Journal. */
	_fillTarget() {
		try {
			const panel = this.ui.getActivePanel();
			const rec = panel && panel.getActiveRecord && panel.getActiveRecord();
			if (!rec || !rec.guid) return null;
			return { rec, guid: rec.guid, title: rec.getName() || "",
				colGuid: this._recordCollectionGuid(rec) };
		} catch (e) { return null; }
	}

	/** Build the proposal for the target. Async because the pools are the
	 *  records of other collections, loaded on demand and only the ones this
	 *  collection's fields point at. Cached on the STATE, so it is per open:
	 *  a Person created a minute ago is in the next open's pool. */
	async _fillCompute(ctx) {
		// With a ctx this runs DETACHED (the autofill engine): no dialog, no
		// render, and it must never touch or race this._state.
		const s = ctx || this._state, t = s.fillTarget;
		const live = () => (s.detached ? true : this._state === s);
		const done = (fill) => { if (!live()) return; s.fill = fill; if (!s.detached) this._render(); };
		if (!t) return done({ status: "notarget" });
		const col = s.cols.find((c) => c.guid === t.colGuid) || null;
		if (!col) return done({ status: "notarget" });
		let cfg = null;
		try { cfg = col.api.getConfiguration() || {}; } catch (e) { cfg = {}; }
		const fields = (cfg.fields || []).filter((f) => f.active !== false && !f.read_only &&
			!Plugin.SYSTEM_FIELD_IDS.has(f.id));
		const recordFields = fields.filter((f) => f.type === "record" && f.filter_colguid);
		const skipped = fields.filter((f) => f.type === "record" && !f.filter_colguid).map((f) => f.label);
		const choiceFields = fields.filter((f) => f.type === "choice");
		if (!recordFields.length && !choiceFields.length) return done({ status: "nofields", col, skipped });

		// Load each target collection once. getAllRecords() is a PROMISE on a
		// collection API (synchronous on the data API), hence the await.
		const targets = {};
		for (const f of recordFields) {
			const g = f.filter_colguid;
			if (targets[g]) continue;
			const tc = s.cols.find((c) => c.guid === g);
			if (!tc) { targets[g] = null; continue; }
			let recs = [];
			try { recs = (await tc.api.getAllRecords()) || []; } catch (e) { recs = []; }
			const items = [];
			for (const r of recs) {
				if (!r || r.guid === t.guid) continue;
				let name = ""; try { name = r.getName() || ""; } catch (e) {}
				if (name) items.push({ name, id: r.guid, rec: r });
			}
			targets[g] = { col: tc, items, pool: Plugin._fillCompilePool(items) };
		}
		if (!live()) return;

		const title = t.title;
		if (!s.kw) s.kw = this._loadKeywords();
		const kwFor = (fieldId) => ((s.kw.map[col.guid] || {})[fieldId]) || {};
		// The user's keywords for a record field: "Kian" -> the Habitat "Kians
		// Identity". Whole, any case, and a hit is a whole-name hit: ticked, and
		// a source for following.
		const kwHits = (f, seen) => {
			const kws = kwFor(f.id), items = [];
			for (const [guid, list] of Object.entries(kws)) for (const k of (list || [])) items.push({ name: k, id: guid });
			if (!items.length) return [];
			const out = [];
			for (const h of Plugin._fillMatch(title, Plugin._fillCompilePool(items))) {
				if (seen.has(h.item.id)) continue;
				const rec = this.data.getRecord(h.item.id);
				if (!rec) continue;                       // the record is gone
				seen.add(h.item.id);
				let name = ""; try { name = rec.getName() || ""; } catch (e) {}
				out.push({ id: h.item.id, name: name || "a record", rec, via: null, word: h.name, strong: true, alias: true });
			}
			return out;
		};
		const direct = {};            // fieldId -> [{ id, name, rec, via:null }]
		const partial = {};           // fieldId -> [{ id, name, rec, word }]
		for (const f of recordFields) {
			const tg = targets[f.filter_colguid];
			const seen = new Set(), hits = kwHits(f, seen), parts = [];
			const full = tg ? Plugin._fillMatch(title, tg.pool) : [];
			for (const h of full) {
				if (seen.has(h.item.id)) continue;
				seen.add(h.item.id);
				hits.push({ id: h.item.id, name: h.name, rec: h.item.rec, via: null });
			}
			for (const h of (tg ? Plugin._fillPartial(title, tg.pool, full) : [])) {
				if (seen.has(h.item.id)) continue;
				seen.add(h.item.id);
				parts.push({ id: h.item.id, name: h.name, rec: h.item.rec, word: h.word });
			}
			direct[f.id] = hits;
			partial[f.id] = parts;
		}

		const currentOf = (f) => this._fillCurrent(t.rec, f);

		// Follow: a field with nothing of its own borrows from what WAS matched.
		// The matched record's collection is the other field's target, so its
		// config is one lookup away, and every record field on it pointing at
		// this field's collection is a path. A follow is weaker evidence than a
		// name in the title, so into a field that already holds something it is
		// only ever OFFERED (unticked); into an empty field it is ticked when it
		// is unique and comes from a whole-name hit. A blank Company on "1:1
		// with John Doe" is the case it exists for; "Mamdooh" on a page whose
		// Company is already set still gets his school offered.
		const follow = {};            // fieldId -> [{ id, name, via, weak }]
		for (const f of recordFields) {
			if (direct[f.id].length) continue;
			const filled = currentOf(f).length > 0;
			const cands = new Map();
			for (const other of recordFields) {
				if (other.id === f.id) continue;
				const tg = targets[other.filter_colguid];
				if (!tg) continue;
				let ocfg = null;
				try { ocfg = tg.col.api.getConfiguration() || {}; } catch (e) { continue; }
				const paths = (ocfg.fields || []).filter((of) => of.active !== false &&
					of.type === "record" && of.filter_colguid === f.filter_colguid);
				if (!paths.length) continue;
				// From whole-name hits AND from partial ones: "Mamdooh" alone is
				// enough to look up Mamdooh Afdile's company, but a follow from a
				// partial inherits its weakness and starts unticked.
				const sources = direct[other.id].map((h) => ({ h, weak: false }))
					.concat((partial[other.id] || []).map((h) => ({ h, weak: true })));
				// ...and from records ALREADY LINKED on the page, into EMPTY
				// fields only: Elin sitting in Related People is surer evidence
				// than her name in a title, and her company belongs on the page
				// whether or not the title says her name again. This was the
				// recurring "why is the company not offered" report. Into a
				// filled field an anchor proposes nothing, or every linked
				// person would drag their whole Habitat list onto every page.
				if (!filled) {
					for (const c of currentOf(other)) {
						const arec = this.data.getRecord(c.id);
						if (arec) sources.push({ h: { name: c.name, rec: arec }, weak: false });
					}
				}
				for (const src of sources) {
					const hit = src.h;
					for (const path of paths) {
						let linked = [];
						try {
							const p = hit.rec.prop(path.id);
							linked = p ? (p.linkedRecords ? p.linkedRecords()
								: (p.linkedRecord() ? [p.linkedRecord()] : [])) : [];
						} catch (e) { linked = []; }
						for (const lr of (linked || [])) {
							if (!lr || !lr.guid) continue;
							if (cands.has(lr.guid)) { if (!src.weak && !filled) cands.get(lr.guid).weak = false; continue; }
							let name = ""; try { name = lr.getName() || ""; } catch (e) {}
							if (name) cands.set(lr.guid, { id: lr.guid, name, via: hit.name, weak: src.weak || filled });
						}
					}
				}
			}
			follow[f.id] = Array.from(cands.values());
		}

		// Choice options: same matcher over the active labels.
		// Choice options: the user's KEYWORDS first (whole, ticked), then the
		// label itself, then a word of the label (ticked only when it is the
		// one thing that word could mean here).
		const choiceHits = {};
		for (const f of choiceFields) {
			const active = (f.choices || []).filter((c) => c.active !== false && c.label);
			const labelOf = (id) => { const c = active.find((x) => x.id === id); return c ? c.label : ""; };
			const seen = new Set(), hits = [];
			const kws = kwFor(f.id);
			const kwItems = [];
			for (const c of active) for (const k of (kws[c.id] || [])) kwItems.push({ name: k, id: c.id });
			const kwPool = kwItems.length ? Plugin._fillCompilePool(kwItems) : null;
			for (const h of (kwPool ? Plugin._fillMatch(title, kwPool) : [])) {
				if (seen.has(h.item.id)) continue;
				seen.add(h.item.id);
				hits.push({ id: h.item.id, name: labelOf(h.item.id), word: h.name, strong: true, alias: true });
			}
			const opts = active.map((c) => ({ name: c.label, id: c.id }));
			const pool = Plugin._fillCompilePool(opts, true);
			const full = Plugin._fillMatch(title, pool);
			for (const h of full) {
				if (seen.has(h.item.id)) continue;
				seen.add(h.item.id);
				hits.push({ id: h.item.id, name: h.name });
			}
			const parts = Plugin._fillPartial(title, pool, full, true).filter((h) => !seen.has(h.item.id));
			for (const h of parts) {
				if (seen.has(h.item.id)) continue;
				seen.add(h.item.id);
				hits.push({ id: h.item.id, name: h.name, word: h.word, strong: parts.length === 1 && !hits.length });
			}
			choiceHits[f.id] = hits;
		}

		// Dates written in the title, for the datetime fields.
		const dateFields = fields.filter((f) => f.type === "datetime");
		const dates = dateFields.length ? Plugin._fillDates(title) : [];

		// Now against what the page already holds. Agrees -> hidden. Multi ->
		// add. Single and empty -> fill. Single and different -> replace.
		const lines = [];
		const push = (f, kind, hits, viaAmbiguous) => this._fillPush(lines, t.rec, f, kind, hits, viaAmbiguous);
		for (const f of recordFields) {
			const parts = partial[f.id] || [];
			if (direct[f.id].length) {
				push(f, "record", direct[f.id], false);
				push(f, "record", parts, false);
				continue;
			}
			// A follow candidate that is ALSO a partial match is the one line on
			// the page with two independent signals ("Elin", and the Elin who
			// works at the matched company): one line, ticked. The other Elins
			// stay as unticked partials.
			const fl = follow[f.id] || [];
			const partById = new Map(parts.map((h) => [h.id, h]));
			const merged = fl.map((h) => partById.has(h.id)
				? Object.assign({}, h, { word: partById.get(h.id).word, strong: !h.weak }) : h);
			const followIds = new Set(fl.map((h) => h.id));
			if (merged.length) push(f, "record", merged, fl.filter((h) => !h.weak).length > 1);
			push(f, "record", parts.filter((h) => !followIds.has(h.id)), false);
		}
		for (const f of choiceFields) push(f, "choice", choiceHits[f.id], false);
		// One date field gets a found date ticked; several get it offered.
		for (const f of dateFields) {
			push(f, "date", dates.map((d) => ({ id: d.id, name: d.label, word: d.text,
				value: d.value, weak: dateFields.length > 1 || dates.length > 1, dateHit: true })), false);
		}

		// The order the page shows its properties in: page_field_ids first,
		// then the rest of the schema. Log Date sits at the top of a Log, so it
		// sits at the top here.
		const order = (cfg.page_field_ids || []).slice();
		for (const f of (cfg.fields || [])) if (order.indexOf(f.id) === -1) order.push(f.id);
		const rank = (id) => { const i = order.indexOf(id); return i === -1 ? 9999 : i; };
		lines.forEach((l, i) => { l._i = i; });
		lines.sort((a, b) => rank(a.fieldId) - rank(b.fieldId) || a._i - b._i);
		// A collection can carry property SETS, and the default set decides what
		// a page actually SHOWS. Calendar's "Event" set lists only the nine
		// Google fields, so a value written to Serves is stored, correct, and
		// invisible on the page. That is indistinguishable from a lost write,
		// and it cost a day of hunting; every line for such a field says so.
		const pset = (cfg.property_sets || []).find((x) => x.id === cfg.property_set_default) || null;
		const hiddenIds = pset ? new Set((cfg.fields || []).map((f) => f.id)
			.filter((id) => (pset.member_ids || []).indexOf(id) === -1)) : null;
		const unscoped = fields.filter((f) => f.type === "record" && !f.filter_colguid);
		for (const f of unscoped) {
			const hits = kwHits(f, new Set());
			if (hits.length) push(f, "record", hits, false);
		}
		lines.forEach((l, i) => { l._i = i; });
		lines.sort((a, b) => rank(a.fieldId) - rank(b.fieldId) || a._i - b._i);

		// What the page ALREADY holds, one line per value, so a fill that
		// guessed wrong can be corrected from the same panel: swap a value or
		// strike it. Dates stay out (fixing a date is one click in Thymer's
		// own field); nothing here changes unless its line is ticked.
		const editable = recordFields.concat(unscoped, choiceFields)
			.sort((a, b) => rank(a.id) - rank(b.id));
		for (const f of editable) {
			for (const c of currentOf(f)) {
				lines.push({ key: "edit:" + f.id + ":" + c.id, edit: true, fieldId: f.id, field: f,
					kind: f.type === "choice" ? "choice" : "record",
					editOf: c.id, editName: c.name, id: null, name: null, removed: false,
					mode: "edit", current: [] });
			}
		}
		const hasChoice = choiceFields.length > 0 || recordFields.length > 0 || unscoped.length > 0;
		done({ status: "ready", col, lines, skipped, unscoped, hasChoice, choiceFields, recordFields,
			dateFields, hiddenIds, hiddenSet: pset ? pset.name : null,
			wsStatus: (unscoped.length && !s.detached) ? "loading" : "none",
			loaded: Object.values(targets).filter(Boolean).map((x) => x.col.name) });
		if (unscoped.length && !s.detached) setTimeout(() => this._fillComputeWorkspace(s), 0);
	}

	/** What the page already holds in one field, as [{ id, name }]. */
	_fillCurrent(rec, f) {
		try {
			const p = rec.prop(f.id);
			if (!p) return [];
			if (f.type === "datetime") {
				const arr = (f.many && p.datetimes) ? (p.datetimes() || []) : (p.datetime() ? [p.datetime()] : []);
				return arr.filter(Boolean).map((d) => ({ id: Plugin._fillDateId(d), name: Plugin._fillDateLabel(d) }));
			}
			if (f.type === "choice") {
				const ids = p.selectedChoices ? (p.selectedChoices() || []) : [];
				const label = (id) => { const c = (f.choices || []).find((x) => x.id === id); return c ? c.label : String(id); };
				return ids.map((id) => ({ id: typeof id === "object" ? id.id : id, name: label(typeof id === "object" ? id.id : id) }));
			}
			const rs = p.linkedRecords ? (p.linkedRecords() || []) : (p.linkedRecord() ? [p.linkedRecord()] : []);
			return rs.filter((r) => r && r.guid).map((r) => { let n = ""; try { n = r.getName() || ""; } catch (e) {} return { id: r.guid, name: n || "a record" }; });
		} catch (e) { return []; }
	}

	/** Turn hits on one field into preview lines. Agrees -> skipped. Multi ->
	 *  add. Single and empty -> fill. Single and different -> replace. Ticked by
	 *  default only when the evidence is a whole name (or two signals agree)
	 *  and nothing is being replaced. */
	_fillPush(lines, rec, f, kind, hits, viaAmbiguous) {
		const cur = this._fillCurrent(rec, f);
		const curIds = new Set(cur.map((c) => c.id));
		for (const h of hits) {
			if (curIds.has(h.id)) continue;
			const mode = f.many ? "add" : (cur.length ? "replace" : "fill");
			lines.push({ key: f.id + ":" + h.id, fieldId: f.id, field: f, kind, id: h.id, rec: h.rec || null,
				name: h.name, via: h.via || null, word: h.word || null, colName: h.colName || null,
				value: h.value, mode, current: cur, strong: !!h.strong, alias: !!h.alias, dateHit: !!h.dateHit,
				defOn: mode !== "replace" && !h.weak &&
					(h.strong || h.dateHit || (!(h.via && viaAmbiguous) && !h.word)) });
		}
	}

	/** The unscoped record fields (no target collection) can link ANY record,
	 *  so they are matched against the whole workspace: every collection
	 *  loaded, one pool. 1.1s measured on 16,896 records, which is why it runs
	 *  AFTER the scoped results are already on screen rather than before.
	 *  A hit could belong to any of the unscoped fields, so it is offered under
	 *  each of them and ticked only when there is exactly one such field. */
	async _fillComputeWorkspace(s) {
		const t = s.fillTarget, fill = s.fill;
		if (!t || !fill || fill.status !== "ready") return;
		const items = [];
		for (const c of s.cols) {
			if (this._state !== s) return;
			let recs = [];
			try { recs = (await c.api.getAllRecords()) || []; } catch (e) { recs = []; }
			for (const r of recs) {
				if (!r || r.guid === t.guid) continue;
				let name = ""; try { name = r.getName() || ""; } catch (e) {}
				if (name) items.push({ name, id: r.guid, colName: c.name, colGuid: c.guid });
			}
		}
		if (this._state !== s || s.fill !== fill) return;
		const pool = Plugin._fillCompilePool(items);
		const full = Plugin._fillMatch(t.title, pool);
		const seen = new Set(), hits = [];
		for (const h of full) {
			if (seen.has(h.item.id)) continue;
			seen.add(h.item.id);
			hits.push({ id: h.item.id, name: h.name, colName: h.item.colName, colGuid: h.item.colGuid,
				weak: fill.unscoped.length > 1 });
		}
		for (const h of Plugin._fillPartial(t.title, pool, full)) {
			if (seen.has(h.item.id)) continue;
			seen.add(h.item.id);
			hits.push({ id: h.item.id, name: h.name, colName: h.item.colName, colGuid: h.item.colGuid, word: h.word });
		}
		// One line per hit, carrying the unscoped fields as OPTIONS: the user
		// picks which field it belongs in. Options that already hold the record
		// are dropped; a hit every option already holds is not a line at all.
		for (const h of hits) {
			const options = fill.unscoped.filter((f) =>
				!this._fillCurrent(t.rec, f).some((c) => c.id === h.id));
			if (!options.length) continue;
			// NEVER pre-picked. The field is the question on these rows, so the
			// row stays untouched until the user answers it. Pre-picking the
			// only unscoped field also put TWO ticked lines on one single-value
			// field (an alias hit and this row), and the write kept just one of
			// them: that is what "the ticked values don't get added" was.
			fill.lines.push({ key: "ws:" + h.id, ws: true, kind: "record", id: h.id, name: h.name,
				colName: h.colName, colGuid: h.colGuid || null, word: h.word || null, options,
				defPick: null });
		}
		fill.wsStatus = "ready";
		fill.wsCount = items.length;
		fill.wsItems = items;
		this._render();
	}

	/** Which field a line writes to: fixed for scoped lines, the user's pick
	 *  (or the default) for workspace-wide ones. */
	_fillPickOf(line) {
		if (!line.ws) return line.fieldId;
		const s = this._state;
		return Object.prototype.hasOwnProperty.call(s.fillPick, line.key) ? s.fillPick[line.key] : line.defPick;
	}

	_fillFieldOf(line) {
		if (!line.ws) return line.field;
		const id = this._fillPickOf(line);
		return id ? (line.options.find((f) => f.id === id) || null) : null;
	}

	/** Is this line going to be written? Three line kinds, three answers:
	 *  a workspace-wide (loose) line once it has a field; an edit line once it
	 *  carries a change and is not unticked; a proposal line when it is in its
	 *  field's selection. */
	_fillIsOn(line) {
		const s = this._state;
		if (line.ws) return !!this._fillPickOf(line);
		if (line.edit) return !!(line.removed || line.id) && !s.fillOff.has(line.key);
		const sel = s.fillSel[line.fieldId];
		return !!sel && sel.has(line.key);
	}

	/** Proposals grouped per field, in page order (fill.lines is already
	 *  sorted that way). One ROW per field on screen; the candidates live
	 *  behind the chevron. */
	_fillGroups() {
		const s = this._state, out = [], by = new Map();
		for (const l of s.fill.lines) {
			if (l.ws || l.edit) continue;
			if (!by.has(l.fieldId)) { const g = { field: l.field, fieldId: l.fieldId, cands: [] }; by.set(l.fieldId, g); out.push(g); }
			by.get(l.fieldId).cands.push(l);
		}
		return out;
	}

	/** The default selection of a group: every candidate the matcher would
	 *  tick, capped to one for a single-value field. */
	_fillDefaultSel(g) {
		let keys = g.cands.filter((l) => l.defOn).map((l) => l.key);
		if (!g.field.many && keys.length > 1) keys = [keys[0]];
		return new Set(keys);
	}

	_fillEnsureSel() {
		const s = this._state;
		for (const g of this._fillGroups()) if (!s.fillSel[g.fieldId]) s.fillSel[g.fieldId] = this._fillDefaultSel(g);
		this._fillEnforceSingle();
	}

	/** A single-value field takes ONE value, so only one line may be ticked for
	 *  it. _fillExclusive keeps that true as the user clicks, but defaults are
	 *  applied without a click, and two of them could land on the same field
	 *  (an alias proposal and a fits-several-fields row). The write then kept
	 *  the last one and dropped the other silently, which is the whole of the
	 *  "I ticked it and it was not added" report. The first line in page order
	 *  wins; the rest go quietly off. */
	_fillEnforceSingle() {
		const s = this._state;
		if (!s.fill || !s.fill.lines) return;
		const seen = new Set();
		for (const l of s.fill.lines) {
			const f = this._fillFieldOf(l);
			if (!f || f.many || !this._fillIsOn(l)) continue;
			if (!seen.has(f.id)) { seen.add(f.id); continue; }
			if (l.ws) s.fillPick[l.key] = null;
			else if (l.edit) s.fillOff.add(l.key);
			else if (s.fillSel[l.fieldId]) s.fillSel[l.fieldId].delete(l.key);
		}
	}

	/** What a group shows: its selection, or, unticked, what ticking it would
	 *  select (the last selection, else the default, else the first). */
	_fillShown(g) {
		const s = this._state, sel = s.fillSel[g.fieldId];
		if (sel && sel.size) return g.cands.filter((l) => sel.has(l.key));
		const last = s.fillLast[g.fieldId];
		const keys = last && last.size ? last : this._fillDefaultSel(g);
		const shown = g.cands.filter((l) => keys.has(l.key));
		return shown.length ? shown : g.cands.slice(0, 1);
	}

	/** The row tick: off clears the selection (remembering it), on restores. */
	_fillRowToggle(g) {
		const s = this._state, sel = s.fillSel[g.fieldId];
		if (sel && sel.size) { s.fillLast[g.fieldId] = new Set(sel); s.fillSel[g.fieldId] = new Set(); }
		else s.fillSel[g.fieldId] = new Set(this._fillShown(g).map((l) => l.key));
		this._fillExclusive(g.field, null);
		s.pop = null;
		this._render();
	}

	/** Pick a candidate in the picker: the one value of a single-value field,
	 *  a member of a multi-value field's set. */
	_fillPickCand(g, line) {
		const s = this._state;
		const sel = s.fillSel[g.fieldId] || (s.fillSel[g.fieldId] = new Set());
		if (g.field.many) { if (sel.has(line.key)) sel.delete(line.key); else sel.add(line.key); }
		else { sel.clear(); sel.add(line.key); }
		this._fillExclusive(g.field, null);
		if (!g.field.many) { s.pop = null; s.popQ = ""; }
		this._render();
	}

	/** A record or option the matcher never proposed, chosen by hand from the
	 *  picker's search: becomes a candidate and is selected. */
	_fillAddCand(g, id, name) {
		const s = this._state;
		let line = g.cands.find((l) => l.id === id);
		if (!line) {
			const cur = this._fillCurrent(s.fillTarget.rec, g.field);
			line = { key: g.fieldId + ":" + id, fieldId: g.fieldId, field: g.field, kind: g.field.type === "choice" ? "choice" : "record",
				id, name, picked: true, mode: g.field.many ? "add" : (cur.length ? "replace" : "fill"), current: cur, defOn: false };
			s.fill.lines.push(line);
			g.cands.push(line);
		}
		this._fillPickCand(g, line);
	}

	/** A single-value field takes ONE value: when a line aimed at it comes on,
	 *  every other line aimed at it (a loose line given that field, an edit
	 *  line on it) goes off. */
	_fillExclusive(field, keep) {
		const s = this._state;
		if (field.many) return;
		const onNow = s.fill.lines.some((l) => !l.ws && !l.edit && l.fieldId === field.id && this._fillIsOn(l));
		if (!onNow && !keep) return;
		for (const o of s.fill.lines) {
			if (o.key === keep || !this._fillIsOn(o) || this._fillPickOf(o) !== field.id) continue;
			if (o.ws) s.fillPick[o.key] = null;
			else if (o.edit) s.fillOff.add(o.key);
			else if (keep) s.fillSel[field.id] = new Set();
		}
	}

	/** Tick, untick, or pick a field for a loose or edit line. */
	_fillToggle(line, pickId) {
		const s = this._state;
		if (line.ws) {
			const cur = this._fillPickOf(line);
			s.fillPick[line.key] = pickId ? (pickId === cur ? null : pickId) : (cur ? null : line.options[0].id);
		} else if (line.edit) {
			if (s.fillOff.has(line.key)) s.fillOff.delete(line.key); else s.fillOff.add(line.key);
		}
		const field = this._fillFieldOf(line);
		if (this._fillIsOn(line) && field) this._fillExclusive(field, line.key);
		s.pop = null;
		this._render();
	}

	/** Swap an edit line's value by hand. */
	_fillSwap(line, id, name) {
		const s = this._state;
		line.id = id; line.name = name; line.removed = false;
		s.fillOff.delete(line.key);
		this._fillExclusive(line.field, line.key);
		s.pop = null; s.popQ = "";
		this._render();
	}

	_fillPicked() {
		const s = this._state;
		return (s.fill && s.fill.status === "ready") ? s.fill.lines.filter((l) => this._fillIsOn(l)) : [];
	}

	/** The icon beside a proposed or held value: the record's own, else its
	 *  collection's; an option's own if it has one. Resolved once per line. */
	_fillIcon(line, id) {
		const key = id || line.id;
		if (line.iconHtml !== undefined && line.iconFor === key) return line.iconHtml;
		let html = "";
		try {
			if (line.kind === "record") {
				const rec = (line.rec && !id) ? line.rec : this.data.getRecord(key);
				let own = null; try { own = rec && rec.getIcon && rec.getIcon(); } catch (e) {}
				if (/^ti-/.test(own || "")) html = '<span class="gp-colicon ti ' + this._esc(own) + '"></span>';
				else {
					const g = line.colGuid || (line.field && line.field.filter_colguid) ||
						(rec ? this._recordCollectionGuid(rec) : null);
					if (g) html = this._colIconFor(g);
				}
			} else if (line.kind === "choice" && line.field) {
				const c = (line.field.choices || []).find((x) => x.id === key);
				if (c && /^ti-/.test(c.icon || "")) html = '<span class="gp-colicon ti ' + this._esc(c.icon) + '"></span>';
			}
		} catch (e) { html = ""; }
		line.iconHtml = html; line.iconFor = key;
		return html;
	}

	/** "not shown in Event": the field exists and will be written, but the
	 *  collection's property set leaves it off the page. */
	_fillHiddenNote(field) {
		const f = this._state.fill;
		if (!field || !f || !f.hiddenIds || !f.hiddenIds.has(field.id)) return "";
		return " · not shown in " + (f.hiddenSet || "this view");
	}

	/** The reason line under a value, in the design's words. Amber when the
	 *  evidence is partial or the write would displace something. */
	_fillWhy(line) {
		if (line.picked) return { text: "picked by hand", amber: false };
		if (line.kind === "date") return { text: "from “" + line.word + "”", amber: false };
		const partial = !!line.word && !line.strong && !line.dateHit && !line.alias;
		const bits = [];
		if (line.word && line.alias) bits.push("alias “" + line.word + "”");
		else if (partial) bits.push("partial match on “" + line.word + "”");
		else if (line.via) bits.push("via " + line.via);
		else bits.push("in the title");
		if (line.via && (line.word || partial)) bits.push("via " + line.via);
		if (line.colName) bits.push("in " + line.colName);
		return { text: bits.join(" · "), amber: partial };
	}

	// ── The three screens ─────────────────────────────────────────────────

	/** A caps section label with its copy beneath, capped at 620px (§6.0). */
	_fillSection(parent, label, copy, first) {
		const d = document.createElement("div");
		d.className = "gp-fsec" + (first ? " is-first" : "");
		d.innerHTML = '<div class="gp-fcaps">' + this._esc(label) + "</div>" +
			(copy ? '<div class="gp-fcopy">' + copy + "</div>" : "");
		parent.appendChild(d);
		return d;
	}

	/** The three-column grid every list here shares: 24px tick, 176px field,
	 *  the rest. */
	_fillGrid(parent, headers) {
		const g = document.createElement("div");
		g.className = "gp-fgrid";
		if (headers) {
			this._add(g, "<span></span>" + headers.map((h) => '<span class="gp-fcaps">' + h + "</span>").join("") +
				'<div class="gp-frule"></div>');
		}
		parent.appendChild(g);
		return g;
	}

	/** The tick cell: exactly the field cell's line box, so the box sits on
	 *  the FIRST line of a row that may wrap (§6.0). */
	_fillTick(grid, on, onClick, warn, idle) {
		const b = document.createElement("button");
		b.className = "gp-ftick" + (idle ? " is-idle" : "");
		b.innerHTML = '<span class="gp-fbox' + (on ? " is-on" : "") + (warn ? " is-warn" : "") + '">' +
			(on ? '<span class="ti ti-check"></span>' : "") + "</span>";
		if (onClick && !idle) b.addEventListener("click", onClick);
		grid.appendChild(b);
		return b;
	}

	_fillChev() { return '<span class="gp-fchev">' + Plugin.CHEVRON + "</span>"; }

	_renderFill(parent) {
		const s = this._state;
		const screen = this._screen(parent);
		const head = this._padTop(screen);
		this._add(head, '<div class="gp-h2">Fill From Title</div>' +
			'<div class="gp-blurb gp-blurb-660 gp-fblurb">Reads the title of the page you are on and ' +
			"proposes values for its fields: records whose name appears in it, options that do, " +
			"and what a matched record itself points at. Ticked lines are written; nothing already " +
			"in a field changes unless you tick it.</div>");
		const body = this._padScroll(screen);
		body.classList.add("gp-fbody");

		if (!s.fill) { s.fill = { status: "loading" }; setTimeout(() => this._fillCompute(), 0); }
		const fill = s.fill;
		if (fill.status === "loading") {
			this._add(body, '<div class="gp-emptycard">Reading the collections this page links to…</div>');
			this._fillFooter(screen, []);
			return;
		}
		if (fill.status === "notarget") {
			this._add(body, '<div class="gp-emptycard">Open a page first, then run Fill From Title ' +
				"from the command palette while you are on it.</div>");
			this._fillFooter(screen, []);
			return;
		}
		const t = s.fillTarget;
		this._add(body, '<div class="gp-fband">' +
			'<span class="gp-fbandtext">Found in the title of</span>' +
			'<span class="gp-fbandprop">' + this._esc(t.title || "(untitled)") + "</span>" +
			'<span class="gp-fbandtext">in</span>' +
			'<span class="gp-fbandprop">' + this._esc(fill.col.name) + "</span></div>");
		if (fill.status === "nofields") {
			this._add(body, '<div class="gp-emptycard">Nothing here can be filled from a title: ' +
				this._esc(fill.col.name) + " has no choice fields and no linked-record field " +
				"limited to one collection.</div>");
			this._fillFooter(screen, []);
			return;
		}
		this._fillEnsureSel();
		const groups = this._fillGroups();
		const loose = fill.lines.filter((l) => l.ws);
		const edits = fill.lines.filter((l) => l.edit);

		if (!groups.length && !loose.length) {
			this._add(body, '<div class="gp-emptycard">' + (fill.wsStatus === "loading"
				? "Nothing in this title matches a record or an option in " + this._esc(fill.col.name) +
				  "'s scoped fields yet; the rest of the workspace is still being searched"
				: "Nothing in this title matches a record or an option in " + this._esc(fill.col.name) +
				  "'s fields, beyond what the page already holds") + ".</div>");
		}

		// ── 1. Proposals: one row per field, candidates behind the chevron.
		if (groups.length) {
			const grid = this._fillGrid(body, ["FIELD", "VALUE"]);
			for (const g of groups) {
				const sel = s.fillSel[g.fieldId], on = !!(sel && sel.size);
				const shown = this._fillShown(g);
				const cur = this._fillCurrent(t.rec, g.field);
				const replaces = on && !g.field.many && cur.length > 0;
				const whys = [];
				let amber = replaces;
				for (const l of shown) { const w = this._fillWhy(l); if (whys.indexOf(w.text) === -1) whys.push(w.text); amber = amber || w.amber; }
				let why = whys.join(" · ");
				if (replaces) why += " · replaces " + cur.map((c) => c.name).join(", ");
				else if (on && g.field.many && cur.length) why += " · adds";
				why += this._fillHiddenNote(g.field);
				// How many candidates are behind the chevron. As a number ON the
				// chevron, not a sentence in the reason line: "· 1 more to
				// choose from" was longer than everything it sat beside.
				const more = g.cands.length - shown.length;
				this._fillTick(grid, on, () => this._fillRowToggle(g), replaces, false);
				const fb = document.createElement("button");
				fb.className = "gp-ffield" + (on ? "" : " is-dim");
				fb.textContent = g.field.label;
				fb.addEventListener("click", () => this._fillRowToggle(g));
				grid.appendChild(fb);
				const cell = document.createElement("div");
				cell.className = "gp-fval gp-anchor is-prop";
				cell.innerHTML = '<span class="gp-fvalcol"><span class="gp-fvalue' + (on ? "" : " is-dim") + '">' +
					shown.map((l) => this._fillIcon(l) + this._esc(l.name)).join(", ") + '</span><span class="gp-fwhy' +
					(amber ? " is-amber" : "") + '">' + this._esc(why) + "</span></span>";
				if (shown.some((l) => l.kind !== "date")) {
					const key = "alt:" + g.fieldId;
					const chev = document.createElement("button");
					chev.className = "gp-fchevbtn";
					chev.innerHTML = Plugin.CHEVRON;
					chev.addEventListener("click", (e) => { e.stopPropagation(); s.pop = s.pop === key ? null : key; s.popQ = ""; this._render(); });
					cell.appendChild(chev);
					// Its own line under the reason, not a clause inside it and
					// not a number on the chevron: both were tried and both
					// crowded the row. It opens the same picker.
					if (more > 0) {
						const b = document.createElement("button");
						b.className = "gp-fmoreline";
						b.textContent = more + (more === 1 ? " more to choose from" : " more to choose from");
						b.addEventListener("click", (e) => {
							e.stopPropagation();
							s.pop = s.pop === key ? null : key; s.popQ = ""; this._render();
						});
						cell.querySelector(".gp-fvalcol").appendChild(b);
					}
					if (s.pop === key) { const pop = this._fillCandPop(g, cur); cell.appendChild(pop); this._placePop(cell, pop, "left"); }
				}
				grid.appendChild(cell);
			}
		}

		// ── 2. Fits several fields: the field is the choice.
		if (loose.length) {
			const sec = this._fillSection(body, "FITS SEVERAL FIELDS",
				"These records fit more than one field on this page, so each needs a field before it can be written.", !groups.length);
			for (const line of loose) {
				const on = this._fillIsOn(line), pick = this._fillPickOf(line), field = this._fillFieldOf(line);
				const grid = this._fillGrid(sec, null);
				grid.classList.add("is-row");
				this._fillTick(grid, on, () => this._fillToggle(line), false, false);
				const fcell = document.createElement("div");
				fcell.className = "gp-anchor";
				const key = "field:" + line.key;
				const fb = document.createElement("button");
				fb.className = "gp-ffield gp-ffieldpick" + (field ? "" : " is-dim");
				fb.innerHTML = "<span>" + this._esc(field ? field.label : "Pick a field") + "</span>" + this._fillChev();
				fb.addEventListener("click", (e) => { e.stopPropagation(); s.pop = s.pop === key ? null : key; this._render(); });
				fcell.appendChild(fb);
				if (s.pop === key) {
					const pop = document.createElement("div");
					pop.className = "gp-pop gp-fpop gp-fpop-field";
					pop.addEventListener("click", (e) => e.stopPropagation());
					this._add(pop, '<div class="gp-fpopnote is-ruled">Which field should ' + this._esc(line.name) + " go in?</div>");
					const list = document.createElement("div");
					list.className = "gp-fpoplist";
					for (const f of line.options) {
						const held = this._fillCurrent(t.rec, f);
						const b = document.createElement("button");
						b.className = "gp-fpoprow" + (pick === f.id ? " is-on" : "");
						b.innerHTML = "<span>" + this._esc(f.label) + '</span><span class="gp-fpopmeta">' +
							this._esc(held.length ? held.map((c) => c.name).join(", ") : "empty") + "</span>";
						b.addEventListener("click", () => this._fillToggle(line, f.id));
						list.appendChild(b);
					}
					pop.appendChild(list);
					fcell.appendChild(pop);
					this._placePop(fcell, pop, "left");
				}
				grid.appendChild(fcell);
				const why = this._fillWhy(line);
				this._add(grid, '<div class="gp-fval"><span class="gp-fvalcol"><span class="gp-fvalue is-wrap">' +
					this._fillIcon(line) + this._esc(line.name) + '</span><span class="gp-fwhy' + (why.amber ? " is-amber" : "") + '">' +
					this._esc(why.text + this._fillHiddenNote(field)) + "</span></span></div>");
			}
		}

		// ── 3. On this page, behind a toggle.
		if (edits.length && s.filledOpen) {
			const sec = this._fillSection(body, "ON THIS PAGE",
				"What these fields already hold. Pick a different value to change one, or strike it.", !groups.length && !loose.length);
			let lastField = null;
			for (const line of edits) {
				const changed = !!(line.removed || line.id), on = this._fillIsOn(line);
				const grid = this._fillGrid(sec, null);
				grid.classList.add("is-row");
				this._fillTick(grid, on, () => this._fillToggle(line), !!line.removed, !changed);
				const first = line.fieldId !== lastField; lastField = line.fieldId;
				this._add(grid, '<span class="gp-ffield is-plain' + (on ? "" : " is-dim") + '">' + (first ? this._esc(line.field.label) : "") + "</span>");
				const cell = document.createElement("div");
				cell.className = "gp-fval gp-anchor";
				const value = line.removed ? line.editName : (line.id ? line.name : line.editName);
				const why = (line.removed ? "removed" : (line.id ? "changes " + line.editName : "already on this page")) +
					this._fillHiddenNote(line.field);
				cell.innerHTML = '<span class="gp-fvalcol"><span class="gp-fvalue is-wrap' +
					(on && !line.removed ? " is-teal" : "") + (line.removed ? " is-struck" : "") + '">' +
					this._fillIcon(line, line.id || line.editOf) + this._esc(value) +
					'</span><span class="gp-fwhy' + (on ? (line.removed ? " is-amber" : " is-teal") : "") + '">' + this._esc(why) + "</span></span>";
				const key = "alt:" + line.key;
				const chev = document.createElement("button");
				chev.className = "gp-fchevbtn";
				chev.innerHTML = Plugin.CHEVRON;
				chev.addEventListener("click", (e) => { e.stopPropagation(); s.pop = s.pop === key ? null : key; s.popQ = ""; this._render(); });
				cell.appendChild(chev);
				const x = document.createElement("button");
				x.className = "gp-fstrike";
				x.textContent = "×";
				x.setAttribute("data-gptip", line.removed ? "Keep this value" : "Remove this value");
				x.addEventListener("click", () => {
					line.removed = !line.removed;
					if (line.removed) { line.id = null; line.name = null; }
					s.fillOff.delete(line.key);
					this._render();
				});
				cell.appendChild(x);
				if (s.pop === key) {
					const pop = this._fillSearchPop(line.field, line.kind, (id, name) => this._fillSwap(line, id, name), line.editOf, "on the page");
					cell.appendChild(pop);
					this._placePop(cell, pop, "left");
				}
				grid.appendChild(cell);
			}
		}
		if (edits.length) {
			const tog = document.createElement("button");
			tog.className = "gp-ffilledtoggle";
			tog.textContent = (s.filledOpen ? "Hide " : "Show ") + edits.length +
				(edits.length === 1 ? " Value" : " Values") + " Already On This Page";
			tog.addEventListener("click", () => { s.filledOpen = !s.filledOpen; s.pop = null; this._render(); });
			body.appendChild(tog);
		}
		this._fillFooter(screen, this._fillPicked());
	}

	/** The candidates picker behind a proposal's chevron: a note when ticking
	 *  would displace a value, the other matches, then a search for anything
	 *  the matcher never proposed. */
	_fillCandPop(g, cur) {
		const s = this._state, sel = s.fillSel[g.fieldId] || new Set();
		const pop = document.createElement("div");
		pop.className = "gp-pop gp-fpop";
		pop.addEventListener("click", (e) => e.stopPropagation());
		this._add(pop, '<div class="gp-fpopnote">' +
			(cur.length && !g.field.many ? "Ticking this replaces " + this._esc(cur.map((c) => c.name).join(", ")) + ". " : "") +
			(g.cands.length > 1 ? "Other matches for " : "Matches for ") + this._esc(g.field.label) + ":</div>");
		const list = document.createElement("div");
		list.className = "gp-fpoplist";
		for (const l of g.cands) {
			const why = this._fillWhy(l);
			const b = document.createElement("button");
			b.className = "gp-fpoprow" + (sel.has(l.key) ? " is-on" : "");
			b.innerHTML = '<span class="gp-fpoplabel">' + this._fillIcon(l) + "<span>" + this._esc(l.name) + '</span></span><span class="gp-fpopmeta">' + this._esc(why.text) + "</span>";
			b.addEventListener("click", () => this._fillPickCand(g, l));
			list.appendChild(b);
		}
		pop.appendChild(list);
		// Search, below the matches: the fix for "close but wrong".
		if (g.cands.some((l) => l.kind !== "date")) {
			const more = this._fillSearchPop(g.field, g.field.type === "choice" ? "choice" : "record",
				(id, name) => this._fillAddCand(g, id, name), null, null, true);
			pop.appendChild(more);
		}
		return pop;
	}

	/** A search picker over a field's target collection (or the workspace
	 *  pool for a field that links anywhere), or its options for a choice
	 *  field. `bare` returns just the search + list, to nest under matches. */
	_fillSearchPop(field, kind, onPick, markId, markText, bare) {
		const s = this._state, fill = s.fill;
		const pop = document.createElement("div");
		pop.className = bare ? "gp-fpopmore" : "gp-pop gp-fpop";
		if (!bare) pop.addEventListener("click", (e) => e.stopPropagation());
		let opts = [], loading = false, isWs = false;
		if (kind === "choice") {
			opts = (field.choices || []).filter((c) => c.active !== false && c.label).map((c) => ({ label: c.label, guid: c.id }));
		} else {
			const target = field.filter_colguid ? (s.cols || []).find((c) => c.guid === field.filter_colguid) : null;
			if (target) {
				const cached = this._loadRecCache(target);
				if (cached === "loading") loading = true;
				else opts = (cached || []).map((r) => ({ label: r.name, guid: r.guid,
					// Each record's OWN icon, as Thymer draws it; the collection's
					// when it never had one.
					icon: /^ti-/.test(r.icon || "") ? '<span class="gp-colicon ti ' + this._esc(r.icon) + '"></span>' : this._colIcon(target) }));
			} else if (fill.wsStatus !== "ready") loading = true;
			else { isWs = true; opts = (fill.wsItems || []).map((it) => ({ label: it.name, guid: it.id, meta: it.colName,
				icon: it.colGuid ? this._colIconFor(it.colGuid) : "" })); }
		}
		const w = document.createElement("div");
		w.className = "gp-fpopsearch";
		this._popSearch(w, kind === "choice" ? "Search options…" : (isWs ? "Search the workspace…" : "Search records…"),
			s.popQ, (v) => { s.popQ = v; this._render(); });
		pop.appendChild(w);
		const list = document.createElement("div");
		list.className = "gp-fpoplist";
		const q = s.popQ || "";
		if (loading) this._add(list, '<div class="gp-fpopempty">Loading…</div>');
		else {
			const ranked = (isWs && !q) ? [] : this._rankRows(opts, q, (o) => o.label).slice(0, 60);
			for (const o of ranked) {
				const b = document.createElement("button");
				b.className = "gp-fpoprow" + (o.guid === markId ? " is-on" : "");
				b.innerHTML = '<span class="gp-fpoplabel">' + (o.icon || "") + "<span>" + this._esc(o.label) + "</span></span>" +
					'<span class="gp-fpopmeta">' + this._esc(o.guid === markId ? (markText || "") : (o.meta || "")) + "</span>";
				b.addEventListener("click", () => onPick(o.guid, o.label));
				list.appendChild(b);
			}
			if (!ranked.length) this._add(list, '<div class="gp-fpopempty">' +
				(isWs && !q ? "Type to search every record." : (bare && !q ? "Type to search for another." : "Nothing matches.")) + "</div>");
		}
		pop.appendChild(list);
		return pop;
	}

	/** Footer: quiet accent links at the left, the count and the write at
	 *  the right (the design's layout, not the shared _bar's). */
	_fillFooter(screen, picked) {
		const s = this._state;
		const fields = new Set(picked.map((l) => this._fillPickOf(l))).size;
		const bar = document.createElement("div");
		bar.className = "gp-footbar gp-ffoot";
		const left = document.createElement("div");
		left.className = "gp-ffootlinks";
		if (s.fill && s.fill.status === "ready" && s.fill.hasChoice) {
			const kw = s.kw || this._loadKeywords();
			const kwb = document.createElement("button");
			kwb.className = "gp-flink";
			kwb.textContent = "Keyword Aliases";
			kwb.addEventListener("click", () => {
				s.kwDraft = JSON.parse(JSON.stringify((kw.map[s.fill.col.guid]) || {}));
				s.pop = null; s.screen = "fillkw"; this._render();
			});
			left.appendChild(kwb);
			const stb = document.createElement("button");
			stb.className = "gp-flink";
			stb.textContent = "Settings";
			stb.addEventListener("click", () => {
				s.autoDraft = ((kw.auto || {})[s.fill.col.guid] || []).slice();
				s.scDraft = null; s.shortcutCapture = false;
				s.pop = null; s.screen = "fillauto"; this._render();
			});
			left.appendChild(stb);
		}
		bar.appendChild(left);
		const right = document.createElement("div");
		right.className = "gp-footacts";
		if (picked.length) this._add(right, '<span class="gp-ffootnote">' + picked.length + (picked.length === 1 ? " value" : " values") + " ticked</span>");
		this._quiet(right, "Cancel", () => this._closeModal());
		this._primary(right, fields ? "Fill " + fields + (fields === 1 ? " Field" : " Fields") : "Fill",
			() => this._doFill(picked), fields > 0);
		bar.appendChild(right);
		screen.appendChild(bar);
	}

	/** Keyword Aliases: VALUE · ALIASES, grouped by field with a count; no
	 *  tick gutter because nothing here ticks (§6.0). */
	_renderFillKeywords(parent) {
		const s = this._state, fill = s.fill, col = fill.col;
		const screen = this._screen(parent);
		const head = this._padTop(screen);
		this._add(head, '<div class="gp-h2">Keyword Aliases for ' + this._esc(col.name) + "</div>" +
			'<div class="gp-blurb gp-blurb-660">Words or phrases that, found in a title, select a value. ' +
			"Separate several with commas. Matched whole and in any case, so “meeting” also finds " +
			"“Meeting”; an alias that is part of a longer word does not fire.</div>");
		const body = this._padScroll(screen);
		body.classList.add("gp-fbody");
		const draft = s.kwDraft || (s.kwDraft = {});
		// Typing must NOT re-render: that would replace the input under the
		// caret. So the Save button, whose enabled state is decided once when
		// this screen is drawn, is held here and switched on directly by the
		// input handler. Without this it stayed dead however much you typed,
		// and an edited alias could not be saved at all.
		let saveBtn = null;
		const markDirty = () => { s.kwDirty = true; if (saveBtn) saveBtn.disabled = false; };
		this._add(body, '<div class="gp-kgrid is-head"><span class="gp-fcaps">VALUE</span><span class="gp-fcaps">ALIASES</span><div class="gp-frule"></div></div>');
		const order = (() => { let cfg = {}; try { cfg = col.api.getConfiguration() || {}; } catch (e) {}
			const o = (cfg.page_field_ids || []).slice(); for (const f of (cfg.fields || [])) if (o.indexOf(f.id) === -1) o.push(f.id); return o; })();
		const all = fill.choiceFields.concat(fill.recordFields, fill.unscoped)
			.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
		const input = (fieldId, valueId, host) => {
			const inp = document.createElement("input");
			const has = ((draft[fieldId] || {})[valueId] || []).length > 0;
			inp.className = "gp-kinput" + (has ? " has-words" : "");
			inp.type = "text";
			inp.placeholder = "e.g. meeting, call";
			inp.value = ((draft[fieldId] || {})[valueId] || []).join(", ");
			inp.addEventListener("keydown", (e) => e.stopPropagation());
			inp.addEventListener("input", () => {
				const list = inp.value.split(",").map((x) => x.trim()).filter(Boolean);
				if (!draft[fieldId]) draft[fieldId] = {};
				draft[fieldId][valueId] = list;
				inp.classList.toggle("has-words", list.length > 0);
				markDirty();
			});
			host.appendChild(inp);
			return inp;
		};
		const groups = document.createElement("div");
		groups.className = "gp-kgroups";
		for (const f of all) {
			const sec = document.createElement("div");
			sec.className = "gp-kgroup";
			const entries = f.type === "choice"
				? (f.choices || []).filter((x) => x.active !== false && x.label).map((c) => ({ id: c.id, label: c.label }))
				: Object.keys(draft[f.id] || {}).map((guid) => {
					let name = "(a record that no longer exists)";
					try { const r = this.data.getRecord(guid); if (r) name = r.getName() || "(untitled)"; } catch (e) {}
					return { id: guid, label: name, removable: true };
				});
			const withWords = entries.filter((e) => ((draft[f.id] || {})[e.id] || []).length).length;
			const count = f.type === "choice" ? withWords + " of " + entries.length + " with aliases"
				: (entries.length ? withWords + " of " + entries.length + " with aliases" : "no records yet");
			this._add(sec, '<div class="gp-khead"><span class="gp-fcaps">' + this._esc(f.label.toUpperCase()) +
				'</span><span class="gp-kcount">' + this._esc(count) + "</span></div>");
			const grid = document.createElement("div");
			grid.className = "gp-kgrid";
			for (const e of entries) {
				const cell = document.createElement("div");
				cell.className = "gp-klabel";
				cell.innerHTML = "<span>" + this._esc(e.label) + "</span>";
				if (e.removable) {
					const x = document.createElement("button");
					x.className = "gp-kx";
					x.textContent = "×";
					x.addEventListener("click", () => { delete draft[f.id][e.id]; if (!Object.keys(draft[f.id]).length) delete draft[f.id]; markDirty(); this._render(); });
					cell.appendChild(x);
				}
				grid.appendChild(cell);
				input(f.id, e.id, grid);
			}
			sec.appendChild(grid);
			if (f.type !== "choice") {
				const anchor = document.createElement("div");
				anchor.className = "gp-anchor gp-kadd";
				const key = "kw:" + f.id;
				const btn = document.createElement("button");
				btn.className = "gp-kaddbtn" + (s.pop === key ? " is-open" : "");
				btn.textContent = "+ Add a Record";
				btn.addEventListener("click", (e) => { e.stopPropagation(); s.pop = s.pop === key ? null : key; s.popQ = ""; this._render(); });
				anchor.appendChild(btn);
				if (s.pop === key) {
					const pop = this._fillSearchPop(f, "record", (guid) => {
						if (!draft[f.id]) draft[f.id] = {};
						if (!draft[f.id][guid]) draft[f.id][guid] = [];
						s.pop = null; s.kwFocus = f.id + ":" + guid; markDirty();
						this._render();
					}, null, null, false);
					anchor.appendChild(pop);
					this._placePop(anchor, pop, "left");
				}
				sec.appendChild(anchor);
			}
			groups.appendChild(sec);
		}
		body.appendChild(groups);
		if (s.kwFocus) {
			const [fid, vid] = s.kwFocus.split(":");
			s.kwFocus = null;
			const inputs = Array.from(body.querySelectorAll(".gp-kinput"));
			const want = ((draft[fid] || {})[vid] || []).join(", ");
			const inp = inputs.reverse().find((i) => i.value === want && i.previousSibling && i.previousSibling.querySelector(".gp-kx"));
			if (inp) setTimeout(() => inp.focus(), 0);
		}
		const acts = this._bar(screen, '<div class="gp-footnote">Saved with the plugin, so every device gets them.</div>');
		this._quiet(acts, "Back", () => { s.kwDraft = null; s.kwDirty = false; s.pop = null; s.screen = "fill"; this._render(); });
		saveBtn = this._primary(acts, "Save Aliases", () => {
			const isRecordField = {};
			for (const f of all) isRecordField[f.id] = f.type !== "choice";
			for (const fid of Object.keys(draft)) {
				if (!isRecordField[fid]) {
					for (const vid of Object.keys(draft[fid])) if (!draft[fid][vid].length) delete draft[fid][vid];
				}
				if (!Object.keys(draft[fid]).length) delete draft[fid];
			}
			const kw = s.kw || this._loadKeywords();
			if (Object.keys(draft).length) kw.map[col.guid] = draft; else delete kw.map[col.guid];
			s.kw = this._stageKeywords(kw);
			s.kwDraft = null; s.kwDirty = false; s.pop = null;
			s.fill = null; s.fillSel = {}; s.fillLast = {}; s.fillOff = new Set(); s.fillPick = {};
			s.screen = "fill"; this._render();
		}, !!s.kwDirty);
	}

	/** What an autofilled field would be filled with, in words. The design
	 *  hand-wrote these per field; here they come from the field's type and
	 *  target, which is what they actually depend on. */
	_fillAutoNote(f) {
		if (f.type === "choice") return "an option matched by name or alias";
		if (f.type === "datetime") return "a date written in the title";
		const s = this._state;
		const tc = f.filter_colguid ? (s.cols || []).find((c) => c.guid === f.filter_colguid) : null;
		let item = null;
		try { item = tc ? (tc.api.getConfiguration() || {}).item_name : null; } catch (e) {}
		const what = (item && !/^(note|page|record)$/i.test(item)) ? "a " + item.toLowerCase()
			: (tc ? "a record from " + tc.name : "a record");
		return what + " named in the title, or what a matched record's own " + f.label + " points at";
	}

	/** Fill In Settings: autofill per field with what it fills itself with,
	 *  what cannot autofill and why, and the shortcut as a click-to-record
	 *  key field. */
	_renderFillAuto(parent) {
		const s = this._state, fill = s.fill, col = fill.col;
		const screen = this._screen(parent);
		const head = this._padTop(screen);
		this._add(head, '<div class="gp-h2">Fill In Settings</div>');
		const body = this._padScroll(screen);
		body.classList.add("gp-fbody");
		const autoDraft = s.autoDraft || (s.autoDraft = []);

		const sec1 = this._fillSection(body, "AUTOFILL AT CREATION",
			"A ticked field fills itself on every new " + this._esc(col.name) + " page created with a title " +
			"already in place, while the field is blank and only where the match is sure enough to be ticked " +
			"on its own. Pages created empty are left alone.", true);
		const grid = this._fillGrid(sec1, ["FIELD", "FILLS ITSELF WITH"]);
		const autoFields = fill.choiceFields.concat(fill.recordFields, fill.dateFields || []);
		for (const f of autoFields) {
			const on = autoDraft.indexOf(f.id) !== -1;
			const toggle = () => {
				if (on) s.autoDraft = autoDraft.filter((x) => x !== f.id); else autoDraft.push(f.id);
				s.autoDirty = true; this._render();
			};
			this._fillTick(grid, on, toggle, false, false);
			const fb = document.createElement("button");
			fb.className = "gp-ffield" + (on ? "" : " is-dim");
			fb.textContent = f.label;
			fb.addEventListener("click", toggle);
			grid.appendChild(fb);
			this._add(grid, '<span class="gp-fnote' + (on ? "" : " is-dim") + '">' + this._esc(on ? this._fillAutoNote(f) : "left blank") + "</span>");
		}
		if ((fill.unscoped || []).length) {
			const names = fill.unscoped.map((f) => f.label);
			const list = names.length > 1 ? names.slice(0, -1).join(", ") + " and " + names[names.length - 1] : names[0];
			this._fillSection(body, "CANNOT AUTOFILL", this._esc(list) + (names.length > 1 ? " link" : " links") +
				" any record, so searching the whole workspace on every new page is too slow. Run Fill From Title on the page instead.", false);
		}
		const sec3 = this._fillSection(body, "SHORTCUT",
			"Opens Fill From Title anywhere in Thymer. Click the keys, then press the new ones; Esc keeps these.", false);
		const kwNow = s.kw || this._fillKw;
		const sc = s.scDraft || (kwNow && kwNow.shortcut) || Plugin.FILL_SHORTCUT_DEFAULT;
		const row = document.createElement("div");
		row.className = "gp-kgrid gp-scrow";
		this._add(row, '<span class="gp-sclabel">Open Fill From Title</span>');
		const btn = document.createElement("button");
		btn.className = "gp-scbtn" + (s.shortcutCapture ? " is-recording" : "");
		btn.textContent = s.shortcutCapture ? "press keys…" : Plugin._fillComboLabel(sc);
		btn.addEventListener("click", () => { s.shortcutCapture = !s.shortcutCapture; this._render(); });
		row.appendChild(btn);
		sec3.appendChild(row);

		const acts = this._bar(screen, '<div class="gp-footnote">Saved with the plugin, so every device gets it.</div>');
		this._quiet(acts, "Back", () => {
			s.autoDraft = null; s.scDraft = null; s.shortcutCapture = false; s.autoDirty = false;
			s.screen = "fill"; this._render();
		});
		this._primary(acts, "Save Settings", () => {
			const kw = s.kw || this._loadKeywords();
			if (!kw.auto) kw.auto = {};
			if ((s.autoDraft || []).length) kw.auto[col.guid] = s.autoDraft.slice(); else delete kw.auto[col.guid];
			if (s.scDraft) kw.shortcut = s.scDraft;
			s.kw = this._stageKeywords(kw);
			s.autoDraft = null; s.scDraft = null; s.shortcutCapture = false; s.autoDirty = false;
			s.screen = "fill"; this._render();
		}, !!(s.autoDirty || s.scDraft));
	}

	/** The write itself, shared by the Fill button and the autofill engine.
	 *  Grouped per field so a multi-value field is written ONCE with everything
	 *  it should hold: set([...]) replaces the whole array, which is why the
	 *  existing ids are re-read HERE and carried in rather than assumed from
	 *  the preview. blanksOnly is the autofill contract: a single-value field
	 *  that gained a value since the compute is left alone. */
	/** The write itself, shared by the Fill button and the autofill engine.
	 *
	 *  A PROPERTY WRITE DOES NOT LAND SYNCHRONOUSLY. Measured in the running
	 *  app: `prop.set([guid])` returns, and reading the property back in the
	 *  same tick still gives the OLD value; ~300ms later it gives the new one.
	 *  So a read-back has to wait, and the first version of this check did not:
	 *  it declared every write a failure and escalated all the way to addValue
	 *  on top of a set that had in fact worked.
	 *
	 *  Grouped per field so a multi-value field is written ONCE with everything
	 *  it should hold: set([...]) replaces the whole array, so the base is
	 *  re-read here and never taken from the preview. blanksOnly is the
	 *  autofill contract: a single-value field that gained a value since the
	 *  compute is left alone. */
	async _writeFill(rec, byField, blanksOnly, guid) {
		const wait = (ms) => new Promise((r) => setTimeout(r, ms));
		const fresh = () => (guid && this.data.getRecord(guid)) || rec;
		const jobs = [];

		for (const g of byField.values()) {
			try {
				const cur = this._fillCurrent(rec, g.field);
				if (blanksOnly && !g.field.many && cur.length) continue;
				let base = cur.map((c) => c.id);
				for (const e of (g.edits || [])) {
					base = base.filter((id) => id !== e.editOf);
					if (e.newId && base.indexOf(e.newId) === -1) base.push(e.newId);
				}
				const adds = g.adds.filter((id) => base.indexOf(id) === -1);
				const ids = g.field.many ? base.concat(adds)
					: (adds.length ? [adds[adds.length - 1]] : base.slice(0, 1));
				const job = { g, ids, before: base.slice(), ok: false, how: "set" };
				jobs.push(job);
				job.wrote = this._fillPut(fresh(), g, ids);
			} catch (e) { jobs.push({ g, ids: [], before: [], ok: false, how: "threw", wrote: false }); }
		}
		if (!jobs.length) return { ok: 0, failed: 0, missed: [] };

		// Let the writes settle, then read them back.
		await wait(500);
		let pending = jobs.filter((j) => !(j.ok = j.wrote && this._fillLanded(fresh(), j.g, j.ids)));
		if (pending.length) {
			for (const j of pending) { j.wrote = this._fillPut(fresh(), j.g, j.ids) || j.wrote; j.how = "set again"; }
			await wait(700);
			pending = pending.filter((j) => !(j.ok = j.wrote && this._fillLanded(fresh(), j.g, j.ids)));
		}
		// Last resort for record fields: add the values one at a time. Only
		// reached when the value is verifiably still absent, so it cannot
		// duplicate one that landed.
		if (pending.length) {
			for (const j of pending) {
				if (j.g.kind !== "record") continue;
				try {
					const prop = fresh().prop(j.g.field.id);
					const have = this._fillCurrent(fresh(), j.g.field).map((c) => c.id);
					for (const id of j.ids) {
						if (have.indexOf(id) === -1 && prop && prop.addValue) prop.addValue(id);
					}
					j.how = "addValue";
				} catch (e) {}
			}
			await wait(700);
			for (const j of pending) j.ok = this._fillLanded(fresh(), j.g, j.ids);
		}

		let ok = 0, failed = 0;
		const missed = [];
		for (const j of jobs) {
			this._fillTrace(j, fresh());
			if (j.ok) ok++; else { failed++; missed.push(j.g.field.label); }
		}
		return { ok, failed, missed };
	}

	_fillPut(target, g, ids) {
		try {
			const prop = target.prop(g.field.id);
			if (!prop) return false;
			if (g.kind === "date") prop.set(g.values[g.values.length - 1]);
			else if (g.kind === "choice") prop.setChoice(ids);
			else prop.set(ids);
			return true;
		} catch (e) { return false; }
	}

	_fillLanded(target, g, ids) {
		try {
			const now = this._fillCurrent(target, g.field);
			if (g.kind === "date") return now.length > 0;
			const have = now.map((c) => c.id);
			return ids.every((id) => have.indexOf(id) !== -1);
		} catch (e) { return false; }
	}

	/** A ring buffer of the last 20 writes, for the next time a value goes
	 *  missing: window.__gpFillLog. */
	_fillTrace(j, target) {
		try {
			const log = window.__gpFillLog || (window.__gpFillLog = []);
			let after = [];
			try { after = this._fillCurrent(target, j.g.field).map((c) => c.id); } catch (e) {}
			log.push({ at: new Date().toISOString(), field: j.g.field.label, id: j.g.field.id,
				kind: j.g.kind, many: !!j.g.field.many, scoped: !!j.g.field.filter_colguid,
				before: j.before, wrote: j.ids, after, how: j.how, verified: !!j.ok });
			if (log.length > 20) log.shift();
		} catch (e) {}
	}

	/* ── Autofill at creation ─────────────────────────────────────────────
	 * Fill From Title, run by itself on a NEW page that arrived already
	 * carrying a title (Quick Capture, duplicate, extract, a table row named
	 * before Enter). Per collection, per field, opt-in from the Keyword
	 * Aliases screen. Three promises, all load-bearing:
	 *   - only pages with a title at the FIRST look (~400ms) qualify; a page
	 *     created empty and then typed into is left to the command, because
	 *     matching a half-typed title fills the wrong things
	 *   - the title must then hold STILL for two consecutive looks before
	 *     anything is computed, for the same reason
	 *   - blanks only, and only lines the preview would TICK on its own;
	 *     replaces never happen here, and the whole-workspace fields are out
	 *     (1.3s per page creation is not a price to pay silently) */

	_scheduleAutofill(newGuid) {
		let kw = null;
		try { kw = this._loadKeywords(); } catch (e) { return; }
		if (!kw || !Object.keys(kw.auto || {}).length) return;
		setTimeout(() => this._autofillCheck(newGuid, kw, 0, null, 0), 400);
	}

	_autofillCheck(guid, kw, attempt, lastTitle, stable) {
		const rec = this.data.getRecord(guid);
		if (!rec) {
			if (attempt < 6) setTimeout(() => this._autofillCheck(guid, kw, attempt + 1, lastTitle, stable), 300);
			return;
		}
		let title = ""; try { title = rec.getName() || ""; } catch (e) {}
		if (attempt === 0 && !title) return;          // created empty: manual only
		if (!title || title !== lastTitle) {
			if (attempt < 14) setTimeout(() => this._autofillCheck(guid, kw, attempt + 1, title, 0), 800);
			return;
		}
		if (stable < 1) {                             // two matching looks in a row
			setTimeout(() => this._autofillCheck(guid, kw, attempt + 1, title, stable + 1), 800);
			return;
		}
		const colGuid = this._recordCollectionGuid(rec);
		const fieldIds = colGuid ? ((kw.auto || {})[colGuid] || []) : [];
		if (!fieldIds.length) return;
		this._autofillRun(rec, guid, title, colGuid, fieldIds);
	}

	async _autofillRun(rec, guid, title, colGuid, fieldIds) {
		let cols = [];
		try { cols = await this._collections(); } catch (e) { return; }
		const ctx = { detached: true, cols, kw: this._loadKeywords(), recCache: {},
			fillTarget: { rec, guid, title, colGuid },
			fillOff: new Set(), fillPick: {}, fill: null };
		try { await this._fillCompute(ctx); } catch (e) { return; }
		const fill = ctx.fill;
		if (!fill || fill.status !== "ready") return;
		const lines = fill.lines.filter((l) => !l.ws && l.defOn && l.mode !== "replace" &&
			fieldIds.indexOf(l.fieldId) !== -1);
		if (!lines.length) return;
		const byField = new Map();
		for (const l of lines) {
			if (!byField.has(l.fieldId)) byField.set(l.fieldId, { field: l.field, kind: l.kind, adds: [], values: [], edits: [] });
			byField.get(l.fieldId).adds.push(l.id);
			byField.get(l.fieldId).values.push(l.value);
		}
		const live = this.data.getRecord(guid) || rec;
		const { ok } = await this._writeFill(live, byField, true, guid);
		if (ok) this._toast("Filled " + ok + (ok === 1 ? " field" : " fields") + " from the title of " +
			(title.length > 40 ? title.slice(0, 40) + "…" : title) + ".");
	}

	/* ── Enter in the title field ─────────────────────────────────────────
	 * The same engine, but the trigger is the hand on the keyboard, not the
	 * moment of creation: title a page, press Enter, and the page fills.
	 *
	 * It is a stronger signal than autofill (the user ASKED), so it is not
	 * restricted to the per-field autofill opt-in; it is the same weaker
	 * write, though: blanks only, nothing that would replace, and only
	 * lines the preview would tick on its own. That is also what makes a
	 * re-trigger harmless: the second run finds the fields already filled
	 * and does nothing.
	 *
	 * `raw` is the text the keydown found IN the input. It gates the run:
	 * once the title has settled it must still read back as the same text.
	 * A property input never passes that test, which is the whole point of
	 * capturing it. An empty `raw` (a title field we could not read text
	 * from) skips the gate rather than killing the feature. */

	_titleEnterSchedule(guid, raw) {
		const rec = this.data.getRecord(guid);
		let title = ""; try { title = rec ? rec.getName() || "" : ""; } catch (e) {}
		const last = this._titleLast;
		// One fill per Enter, not one per keydown the OS repeats, and not two
		// for a double Enter on the same unchanged title.
		if (last.guid === guid && Date.now() - last.at < 1500 &&
			last.title === title && last.raw === raw) return;
		last.guid = guid; last.at = Date.now(); last.title = title; last.raw = raw;
		setTimeout(() => this._titleEnterCheck(guid, raw, 0, null, 0), 350);
	}

	_titleEnterCheck(guid, raw, attempt, lastTitle, stable) {
		const rec = this.data.getRecord(guid);
		if (!rec) return;
		let title = ""; try { title = rec.getName() || ""; } catch (e) {}
		if (!title) {
			// The commit can lag the keydown by a tick; give it a short leash.
			if (attempt < 4) setTimeout(() => this._titleEnterCheck(guid, raw, attempt + 1, title, 0), 400);
			return;
		}
		if (title !== lastTitle) {
			if (attempt < 4) setTimeout(() => this._titleEnterCheck(guid, raw, attempt + 1, title, 0), 400);
			return;
		}
		if (stable < 1) {                       // two matching looks in a row
			setTimeout(() => this._titleEnterCheck(guid, raw, attempt + 1, title, stable + 1), 400);
			return;
		}
		// The settled title must still be the text that was in the input:
		// canonical, because the field may normalise what was typed.
		if (raw && Plugin._fillCanon(title) !== Plugin._fillCanon(raw)) return;
		this._titleEnterRun(rec, guid, title);
	}

	async _titleEnterRun(rec, guid, title) {
		const colGuid = this._recordCollectionGuid(rec);
		let cols = [];
		try { cols = await this._collections(); } catch (e) { return; }
		const ctx = { detached: true, cols, kw: this._loadKeywords(), recCache: {},
			fillTarget: { rec, guid, title, colGuid },
			fillOff: new Set(), fillPick: {}, fill: null };
		try { await this._fillCompute(ctx); } catch (e) { return; }
		const fill = ctx.fill;
		if (!fill || fill.status !== "ready") return;
		const lines = fill.lines.filter((l) => !l.ws && !l.edit && l.defOn && l.mode !== "replace");
		if (!lines.length) return;
		const byField = new Map();
		for (const l of lines) {
			if (!byField.has(l.fieldId)) byField.set(l.fieldId, { field: l.field, kind: l.kind, adds: [], values: [], edits: [] });
			byField.get(l.fieldId).adds.push(l.id);
			byField.get(l.fieldId).values.push(l.value);
		}
		const live = this.data.getRecord(guid) || rec;
		const { ok } = await this._writeFill(live, byField, true, guid);
		if (ok) this._toast("Filled " + ok + (ok === 1 ? " field" : " fields") + " from " +
			(title.length > 40 ? title.slice(0, 40) + "…" : title) + ".");
	}

	/** Write the ticked lines from the Fill button. */
	async _doFill(picked) {
		const s = this._state;
		if (!s || s.busy || !picked.length) return;
		s.busy = true;
		const t = s.fillTarget;
		const byField = new Map();
		for (const l of picked) {
			const field = this._fillFieldOf(l);
			if (!field) continue;
			if (!byField.has(field.id)) byField.set(field.id, { field, kind: l.kind, adds: [], values: [], edits: [] });
			if (l.edit) { byField.get(field.id).edits.push({ editOf: l.editOf, newId: l.id }); continue; }
			byField.get(field.id).adds.push(l.id);
			byField.get(field.id).values.push(l.value);
		}
		// A FRESH handle, never the one the panel handed over when the dialog
		// opened: a stale handle's writes reach the backend but not the open
		// view, which read as "nothing happened until I restarted Thymer".
		const rec = this.data.getRecord(t.guid) || t.rec;
		// Close first: the user's part is done, and verifying takes about a
		// second because the write has to settle before it can be read back.
		const title = t.title;
		this._closeModal();
		const { ok, failed, missed } = await this._writeFill(rec, byField, false, t.guid);
		if (!failed) {
			this._toast("Filled " + ok + (ok === 1 ? " field" : " fields") + " on " + (title || "the page") + ".");
		} else {
			// Name them. "Failed on 1 field" sent the last report looking for a
			// value that had never been written.
			this._toast((ok ? "Filled " + ok + ", but " : "") + (missed || []).join(" and ") +
				(missed && missed.length === 1 ? " did not save." : " did not save."));
		}
	}

	// ══════════════════════════════════════════════════════════════════════
	// Screen: Rearrange — browse a collection's properties and reorder them
	// ══════════════════════════════════════════════════════════════════════

	/* Collections on the left, that collection's properties on the right,
	 * draggable. It adds nothing and removes nothing: the only thing it writes
	 * is the ORDER, and it writes it through the same _orderedFields() the Add
	 * flow uses, so built-in and archived fields keep their exact positions
	 * even though they are never shown here. */
	_renderRearrange(parent) {
		const s = this._state;
		const screen = this._screen(parent);

		const head = this._padTop(screen);
		this._add(head, '<div class="gp-h2">Rearrange</div>' +
			'<div class="gp-blurb gp-blurb-640">Browse what every collection already has, and drag ' +
			"a property to move it. Nothing is added or removed here — only the order changes, " +
			"and only in the collections you actually touch.</div>");

		// NOT gp-scroll: this screen is for browsing, so the two lists fill the
		// panel and scroll themselves. Inherited from the Add screen they kept
		// its 268px cap, which left 294px of empty panel underneath and made 53
		// collections look like 8.
		const grid = document.createElement("div");
		grid.className = "gp-pad gp-fill gp-two-col gp-rear-grid";

		// ── left: which collection ───────────────────────────────────────────
		const left = document.createElement("div");
		left.className = "gp-col-l";
		this._add(left, '<div class="gp-caps">COLLECTION</div>');
		this._search(left, "Search collections…", s.rearQ, (v) => {
			s.rearQ = v;
			this._drawRearCols();
		});
		const colList = document.createElement("div");
		colList.className = "gp-picklist gp-rearcols";
		left.appendChild(colList);
		grid.appendChild(left);

		// ── right: its properties, in order ──────────────────────────────────
		const right = document.createElement("div");
		right.className = "gp-col-r";
		this._add(right, '<div class="gp-orderhead"><div class="gp-caps">FIELD ORDER</div>' +
			'<div class="gp-orderhint">Drag to reorder</div></div>');
		const fieldList = document.createElement("div");
		fieldList.className = "gp-rearfields";
		right.appendChild(fieldList);
		grid.appendChild(right);
		screen.appendChild(grid);

		const acts = this._bar(screen, '<div class="gp-footnote">' + this._esc(this._rearNote()) + "</div>");
		this._quiet(acts, "Cancel", () => {
			s.rearOrder = {};
			s.rearDirty = false;
			this._closeModal();
		});
		this._primary(acts, "Save", () => this._saveRearrange(), !!s.rearDirty);

		this._drawRearCols();
		this._drawRearFields();
	}

	/** How many collections the user has actually reordered. Derived by
	 *  comparing against the live order, never a flag set on every drag. */
	_rearChanged() {
		const s = this._state;
		const out = [];
		for (const guid of Object.keys(s.rearOrder || {})) {
			const col = (s.cols || []).find((c) => c.guid === guid);
			if (!col) continue;
			const live = this._userFields(col.api.getConfiguration()).map((f) => f.id);
			const now = s.rearOrder[guid].map((f) => f.id);
			if (live.join(" ") !== now.join(" ")) out.push(col);
		}
		return out;
	}

	/** Which properties in this collection have actually MOVED, derived rather
	 *  than flagged, so dragging a row back where it started clears its own mark.
	 *
	 *  Not "its index differs from the live order": one drag shifts every row
	 *  between the old slot and the new one, so that test lights up half the
	 *  list and says nothing about what the user did. The rows outside the
	 *  longest common subsequence of (live, now) are the moved ones, which for a
	 *  single drag is exactly the row that was dragged. The lists are one
	 *  collection's user fields, tens of entries, so the quadratic table costs
	 *  nothing. */
	_rearMovedIds(guid) {
		const s = this._state;
		const col = (s.cols || []).find((c) => c.guid === guid);
		const now = (s.rearOrder[guid] || []).map((f) => f.id);
		if (!col || !now.length) return new Set();
		const live = this._userFields(col.api.getConfiguration()).map((f) => f.id);
		const n = live.length, m = now.length;
		const dp = [];
		for (let i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
		for (let i = 1; i <= n; i++) {
			for (let j = 1; j <= m; j++) {
				dp[i][j] = live[i - 1] === now[j - 1]
					? dp[i - 1][j - 1] + 1
					: Math.max(dp[i - 1][j], dp[i][j - 1]);
			}
		}
		const stayed = new Set();
		let i = n, j = m;
		while (i > 0 && j > 0) {
			if (live[i - 1] === now[j - 1]) { stayed.add(now[j - 1]); i--; j--; }
			else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
			else j--;
		}
		return new Set(now.filter((id) => !stayed.has(id)));
	}

	_rearNote() {
		const n = this._rearChanged().length;
		if (!n) return "Nothing moved yet.";
		return "Rearranging " + n + (n === 1 ? " collection" : " collections");
	}

	_drawRearCols() {
		const s = this._state, p = this._panel();
		const host = p && p.querySelector(".gp-rearcols");
		if (!host) return;
		host.innerHTML = "";
		if (!s.rearSel) {
			const first = (s.cols || []).find((c) => this._userFields(c.api.getConfiguration()).length);
			s.rearSel = first ? first.guid : null;
		}
		const q = s.rearQ || "";
		let shown = 0;
		for (const c of (s.cols || [])) {
			if (this._matchScore(c.name, q) <= 0) continue;
			const fields = this._userFields(c.api.getConfiguration());
			if (!fields.length) continue;
			shown++;
			const on = c.guid === s.rearSel;
			const moved = this._rearChanged().some((x) => x.guid === c.guid);
			const b = document.createElement("button");
			b.className = "gp-rearcol" + (on ? " is-on" : "");
			b.innerHTML = '<span class="gp-poplabel">' + this._colIcon(c) +
				"<span>" + this._esc(c.name) + "</span></span>" +
				'<span class="gp-rearmeta">' + (moved ? "rearranged" : fields.length + " fields") + "</span>";
			if (moved) b.classList.add("is-moved");
			b.addEventListener("click", () => {
				s.rearSel = c.guid;
				this._drawRearCols();
				this._drawRearFields();
			});
			host.appendChild(b);
		}
		if (!shown) this._add(host, '<div class="gp-pickempty">Nothing matches that.</div>');
	}

	/** The working order for a collection, seeded from its live fields. */
	_rearList(guid) {
		const s = this._state;
		const col = (s.cols || []).find((c) => c.guid === guid);
		if (!col) return [];
		const live = this._userFields(col.api.getConfiguration())
			.map((f) => ({ id: f.id, label: f.label, type: f.type, icon: f.icon }));
		const held = s.rearOrder[guid];
		// A held order is only valid while it covers exactly the same fields —
		// the collection can change under us while the dialog is open.
		if (held && held.length === live.length &&
			held.every((h) => live.some((f) => f.id === h.id))) return held;
		s.rearOrder[guid] = live;
		return live;
	}

	_drawRearFields() {
		const s = this._state, p = this._panel();
		const host = p && p.querySelector(".gp-rearfields");
		if (!host) return;
		host.innerHTML = "";
		if (!s.rearSel) {
			this._add(host, '<div class="gp-pickempty">Pick a collection on the left.</div>');
			return;
		}
		const list = this._rearList(s.rearSel);
		const moved = this._rearMovedIds(s.rearSel);
		list.forEach((f, i) => {
			const row = document.createElement("div");
			row.className = "gp-orderrow gp-rearrow" +
				(moved.has(f.id) ? " is-moved" : "") +
				(s.dragIdx === i ? " is-dragging" : "");
			row.setAttribute("data-sort", String(i));
			row.innerHTML = '<span class="gp-grip">&#10303;</span>' +
				'<span class="gp-ordername">' + this._esc(f.label) + "</span>" +
				'<span class="gp-ordertype">' + this._esc(f.type) + "</span>" +
				(moved.has(f.id) ? '<span class="gp-tag">MOVED</span>' : "");
			host.appendChild(row);
		});
		this._sortable(host, (from, to) => {
			const arr = s.rearOrder[s.rearSel];
			const [it] = arr.splice(from, 1);
			arr.splice(to, 0, it);
			s.dragIdx = to;
			this._drawRearFields();
		}, (moved) => {
			s.dragIdx = null;
			if (moved) s.rearDirty = this._rearChanged().length > 0;
			this._drawRearFields();
			this._drawRearCols();
			this._syncRearFooter();
		});
	}

	_syncRearFooter() {
		const s = this._state, p = this._panel();
		if (!p) return;
		const note = p.querySelector(".gp-footnote");
		if (note) note.textContent = this._rearNote();
		const b = p.querySelector(".gp-primary");
		if (b) b.disabled = !s.rearDirty;
	}

	async _saveRearrange() {
		const s = this._state;
		if (!s || s.busy) return;
		const changed = this._rearChanged();
		if (!changed.length) return;
		s.busy = true;
		const done = [], failed = [];
		for (const col of changed) {
			try {
				const live = col.api.getConfiguration();
				const next = JSON.parse(JSON.stringify(live));
				// Same writer the Add flow uses: user fields take the chosen order,
				// and every built-in or archived entry is put back after the number
				// of user fields that preceded it. They are interleaved in this
				// workspace, so they cannot simply be pushed to the ends.
				next.fields = this._orderedFields(next.fields, [], s.rearOrder[col.guid], null);
				const ok = await col.api.saveConfiguration(next);
				if (ok) done.push(col.name); else failed.push(col.name);
			} catch (e) { failed.push(col.name); }
		}
		this._closeModal();
		if (!failed.length) {
			this._toast(done.length === 1
				? "Reordered " + done[0] + "."
				: "Reordered " + done.length + " collections.");
		} else {
			this._toast("Reordered " + done.length + ". Failed on: " + failed.join(", ") + ".");
		}
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

	_injectStyle() {
		const css = `
/* Every metric below is lifted from the design file's inline styles. Where the
   design writes a literal rgba(255,255,255,.x) — a white veil that only reads
   correctly on a dark plate — it is expressed here as a currentColor mix, which
   resolves the same in dark and does not turn into an invisible or blinding
   line under a light theme. The amber, red and teal literals stay literal:
   those are semantic colours the design fixes, not surface tints. */
/* Colour resolves through THYMER'S OWN theme variables, so the plugin follows
   the workspace theme instead of guessing at it. The design file and the style
   guide both declare --thy-*; those names do NOT exist in the app. Measured
   against :root, the real ones are below, and a plugin written on --thy-*
   resolves every token to its fallback hex and only looks right in dark by
   accident. Hexes here are dark fallbacks only.
   Also measured: the bg scale runs DARKER as the number rises, and the command
   palette surface (bg-600) is already the lightest the theme defines, so a
   raised surface has to be mixed rather than taken from a token.
   NO BACKTICKS anywhere below, comments included, or this template literal
   terminates early and the plugin will not parse. */
:root {
	--gp-surface:      var(--cmdpal-bg-color, var(--panel-bg-color, #1b2126));
	/* A picker has to read as a surface ON TOP of the panel. Thymer's own menus
	   (--link-menu-bg-color, --tooltip-bg-color, --cmdpal-bg-color) all sit one
	   step lighter than the panel they float over; mapping the popover to the
	   same token as the panel made it melt into the modal. One step up the
	   theme's own scale keeps that relationship in any theme. */
	--gp-surface-pop:  var(--color-bg-500, #1f262b);
	--gp-surface-chip: color-mix(in srgb, var(--gp-text) 8%, transparent);
	--gp-text:         var(--color-text-50, #eef4f7);
	--gp-text-2:       var(--color-text-100, #c4ced4);
	--gp-text-body:    var(--color-text-400, #8a97a0);
	--gp-text-dim:     var(--color-text-700, #5b6a73);
	--gp-line:         var(--divider-color, rgba(255,255,255,.09));
	--gp-rule:         color-mix(in srgb, var(--gp-text) 7%, transparent);
	--gp-accent:       var(--color-primary-500, #2dd4bf);
	--gp-accent-band:  var(--cmdpal-selected-bg-color, #2f9e8a);
	--gp-accent-text:  var(--color-primary-400, #4fd1c5);
	/* The label on an accent fill. NOT --color-primary-text-100: that token is a
	   primary-TINTED text colour, and in this theme it resolves to near-white
	   (.929), which is why every accent button came out white-on-teal. The
	   design's own value is a near-black, and the accent it sits on is a light
	   teal in every Thymer theme. */
	--gp-on-accent:    #10171b;
	--gp-warn:         #e0a33e;
	--gp-danger:       #f2867a;
	--gp-veil-4:       color-mix(in srgb, var(--gp-text) 4%, transparent);
	--gp-veil-3:       color-mix(in srgb, var(--gp-text) 3%, transparent);
	--gp-veil-5:       color-mix(in srgb, var(--gp-text) 5%, transparent);
	--gp-veil-6:       color-mix(in srgb, var(--gp-text) 6%, transparent);
	--gp-veil-7:       color-mix(in srgb, var(--gp-text) 7%, transparent);
	--gp-veil-8:       color-mix(in srgb, var(--gp-text) 8%, transparent);
	--gp-veil-10:      color-mix(in srgb, var(--gp-text) 10%, transparent);
	--gp-veil-20:      color-mix(in srgb, var(--gp-text) 20%, transparent);
	--gp-veil-40:      color-mix(in srgb, var(--gp-text) 40%, transparent);
	--gp-veil-28:      color-mix(in srgb, var(--gp-text) 28%, transparent);
	--gp-faint:        color-mix(in srgb, var(--gp-text) 14%, transparent);
	--gp-hover:        color-mix(in srgb, var(--gp-text) 4.5%, transparent);
	--gp-font:         "Space Grotesk", var(--font-sans), system-ui, sans-serif;
	--gp-mono:         "Space Mono", ui-monospace, monospace;
	/* One knob for the whole dialog. Every metric in this sheet is the design
	   file's own number; the zoom property scales layout AND type together, so the design
	   stays exactly itself and simply reads larger. The design is 920px on a
	   1656px-wide window at devicePixelRatio 1.83, which measured small on the
	   real screen. Nudge this, nothing else. */
	--gp-zoom:         1.15;
}

/* ── frame ───────────────────────────────────────────────────────────────── */
.gp-ovl {
	position: fixed; inset: 0; z-index: 99998;
	background: rgba(0,0,0,.45);
	display: flex; align-items: center; justify-content: center; padding: 24px;
}
/* The design file has no box-sizing reset, so it inherits the browser's own
   model: divs and spans are content-box, buttons and inputs are border-box
   (the UA stylesheet). Thymer forces border-box app-wide, which silently ate
   every declared size's borders — a 17px tick box came out 17 instead of 19,
   and the 320px popover 320 instead of 322. Restoring the UA model per element
   type is what makes the design's numbers mean what it meant by them.
   Class-level, not :where(), so it cannot lose a tie with Thymer's * rule. */
.gp-panel, .gp-panel * { box-sizing: content-box; }
.gp-panel button, .gp-panel input,
.gp-panel select, .gp-panel textarea { box-sizing: border-box; }
.gp-panel {
	position: relative; z-index: 99999;
	zoom: var(--gp-zoom);
	/* Widths are in the panel's own (zoomed) pixels, so the viewport limits are
	   divided back out: at zoom 1.15 a 920px panel occupies 1058 real pixels,
	   and "the window minus the overlay's padding" has to be expressed in the
	   same units the panel is laid out in. */
	width: min(920px, calc((100vw - 32px) / var(--gp-zoom)));
	max-height: min(760px, calc((100dvh - 48px) / var(--gp-zoom)));
	display: flex; flex-direction: column;
	border-radius: 4px; overflow: hidden;
	background: var(--gp-surface);
	border: 1px solid var(--gp-line);
	box-shadow: 0 24px 64px rgba(0,0,0,.5);
	color: var(--cmdpal-fg-color, var(--text-color, inherit));
	font-family: var(--gp-font);
	/* Thymer's ambient is 15.2px/300; the design's is a browser default at 400.
	   Every element below sets its own size, so this is only what unsized text
	   falls back to — but without it that text inherits the app's light weight. */
	font-size: 13px; line-height: 17px; font-weight: 400;
	-webkit-font-smoothing: antialiased;
}
:where(.gp-panel) button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
:where(.gp-panel) input { font: inherit; }
.gp-panel *:focus-visible { outline: 2px solid color-mix(in srgb, var(--gp-accent) 55%, transparent); outline-offset: 2px; }

.gp-frame-head {
	display: flex; align-items: baseline; gap: 10px;
	padding: 22px 24px 18px; border-bottom: 1px solid var(--gp-rule); flex: none;
}
.gp-frame-title { font-weight: 700; font-size: 19px; line-height: 1.2; color: var(--gp-text); }
.gp-frame-ver { font-size: 12px; line-height: 15.5px; color: var(--gp-text-dim); }

/* ── shell: sidebar + content ────────────────────────────────────────────── */
.gp-shell { display: grid; grid-template-columns: 214px 1fr; min-height: 492px; flex: 1; min-width: 0; }
/* min-height:0 is what lets the content column scroll instead of stretching
   the grid row past the panel's max-height. */
.gp-shell > * { min-height: 0; min-width: 0; }
.gp-nav {
	border-right: 1px solid var(--gp-rule);
	padding: 18px 10px; display: flex; flex-direction: column; gap: 3px;
}
.gp-navlabel {
	font-weight: 500; font-size: 10.5px; line-height: 13.5px; letter-spacing: .14em;
	color: var(--gp-text-dim); padding: 0 10px 8px;
}
.gp-navlabel.is-later { padding: 20px 10px 8px; }
.gp-navitem {
	display: flex; align-items: center; justify-content: space-between; gap: 8px;
	width: 100%; text-align: left; padding: 8px 10px; border-radius: 4px;
	background: transparent; color: var(--gp-text-body);
	font-size: 13.5px; line-height: 17.5px; font-weight: 500;
	transition: background .12s ease, color .12s ease;
}
.gp-navitem:hover { background: var(--gp-hover); }
.gp-navitem.is-on {
	background: var(--gp-veil-7);
	color: var(--gp-text); font-weight: 600;
}
.gp-navbadge {
	font-weight: 500; font-size: 10.5px; line-height: 13.5px; color: var(--gp-text-2);
	background: var(--gp-veil-8);
	padding: 1px 6px; border-radius: 4px;
}
.gp-navspacer { flex: 1; }
.gp-navfoot { font-size: 11.5px; line-height: 1.6; color: var(--gp-text-dim); padding: 0 10px; }
.gp-content { display: flex; flex-direction: column; }

/* Under ~780px usable the sidebar becomes a horizontal nav: caps labels with
   underline TABS beside them, not the sidebar's filled pills. */
.gp-panel.is-narrow .gp-shell { display: flex; flex-direction: column; }
.gp-panel.is-narrow .gp-nav {
	flex-direction: row; flex-wrap: wrap; align-items: center; gap: 6px 18px;
	border-right: 0; border-bottom: 1px solid var(--gp-rule); padding: 12px 24px;
}
.gp-panel.is-narrow .gp-navgroup { display: flex; align-items: center; gap: 8px; }
.gp-panel.is-narrow .gp-navlabel { font-size: 10px; line-height: 13px; padding: 0; }
.gp-navtab {
	display: flex; align-items: center; gap: 6px; padding: 6px 2px; white-space: nowrap;
	font-weight: 500; font-size: 13px; line-height: 17px; color: var(--gp-text-body);
	border-bottom: 2px solid transparent;
}
.gp-navtab:hover { color: var(--gp-text); }
.gp-navtab.is-on { font-weight: 600; color: var(--gp-text); border-bottom-color: var(--gp-accent); }

/* ── screen scaffolding ──────────────────────────────────────────────────── */
.gp-screen { display: flex; flex-direction: column; flex: 1; min-height: 0; }
/* Solid, because the body scrolls UNDER it and section headers were showing
   through the gap between blurb and list on the aliases screen. */
.gp-padtop { padding: 20px 24px 0; flex: none; position: relative; z-index: 1; background: var(--gp-surface); }
.gp-pad { padding: 16px 24px 8px; }
/* The design file has no cap on the middle band because a page simply grows.
   Inside a modal capped at 760px it has to scroll, and it must be the ONLY
   thing that does, so the head and the footer stay where they are. */
.gp-scroll { flex: 1; min-height: 0; overflow-y: auto; }
.gp-footbar {
	display: flex; align-items: center; justify-content: space-between; gap: 12px;
	padding: 14px 24px; border-top: 1px solid var(--gp-rule); margin-top: auto; flex: none;
}
.gp-footbar-solo { display: block; }
.gp-footacts { display: flex; align-items: center; gap: 10px; }
.gp-footnote { font-size: 12.5px; line-height: 16px; color: var(--gp-text-body); }
/* The save confirmation. It lives here because the buttons cannot carry it:
   with nothing left to save there is only a Close. */
.gp-footnote.is-saved { color: var(--gp-accent-text); font-weight: 600; }

/* ── shared type ─────────────────────────────────────────────────────────── */
.gp-h2 { font-weight: 600; font-size: 15px; line-height: 19.5px; color: var(--gp-text); margin-bottom: 6px; }
.gp-blurb { font-size: 13.5px; line-height: 1.65; color: var(--gp-text-body); text-wrap: pretty; }
.gp-blurb-640 { max-width: 640px; }
.gp-blurb-tight { max-width: 460px; margin-top: 12px; }
.gp-caps {
	font-weight: 500; font-size: 10.5px; line-height: 13.5px; letter-spacing: .14em;
	color: var(--gp-text-dim); padding: 0 0 8px 2px;
}
.gp-caps-flat { padding: 0 0 0 2px; }
.gp-caps-s {
	font-weight: 500; font-size: 10px; line-height: 13px; letter-spacing: .14em;
	color: var(--gp-text-dim); padding: 0 0 5px 2px;
}

/* ── controls ────────────────────────────────────────────────────────────── */
.gp-quiet {
	font-weight: 500; font-size: 13px; line-height: 17px; color: var(--gp-text-body);
	padding: 9px 12px; border-radius: 4px;
}
.gp-quiet:hover { color: var(--gp-text); }
.gp-primary {
	border-radius: 4px; padding: 9px 20px; white-space: nowrap;
	font-size: 13px; line-height: 17px; font-weight: 600;
	background: var(--gp-accent); color: var(--gp-on-accent);
}
.gp-primary:hover:not(:disabled) { filter: brightness(1.08); }
/* Disabled is its own drawn state in the design, not the whole button faded:
   a dim label on a faint plate. */
.gp-primary:disabled {
	background: var(--gp-veil-6);
	color: color-mix(in srgb, var(--gp-text) 35%, transparent);
	cursor: default;
}
.gp-danger {
	font-weight: 500; font-size: 12.5px; line-height: 16px; color: var(--gp-danger);
	border: 1px solid color-mix(in srgb, var(--gp-danger) 35%, transparent);
	background: color-mix(in srgb, var(--gp-danger) 8%, transparent);
	border-radius: 4px; padding: 7px 12px; white-space: nowrap;
}
.gp-danger:hover {
	border-color: color-mix(in srgb, var(--gp-danger) 60%, transparent);
	background: color-mix(in srgb, var(--gp-danger) 16%, transparent);
}
.gp-dashed {
	width: 100%; border: 1px dashed var(--gp-faint); border-radius: 4px;
	padding: 9px; font-weight: 500; font-size: 12.5px; line-height: 16px; color: var(--gp-text-body);
	transition: border-color .12s ease, color .12s ease;
}
.gp-dashed-lg { padding: 11px; font-size: 13px; line-height: 17px; }
.gp-dashed:hover { border-color: var(--gp-veil-28); color: var(--gp-text); }
.gp-dashed.is-open {
	border-color: color-mix(in srgb, var(--gp-accent) 45%, transparent);
	color: var(--gp-accent-text);
}
/* Scoped to .gp-panel because Thymer styles inputs with a selector of equal
   specificity to a bare class, and its monospace stack was winning: the
   computed family came back as Cascadia Code, not this one.
   The line-height is PINNED. Space Mono is not installed here (probed: it
   measures identical to a nonexistent family), and every fallback has its own
   normal line-height, so an unpinned box lands at a different height on every
   machine. 8 + 18.5 + 8 + 2 = the design's 36.5px, whatever the face. */
.gp-panel .gp-search {
	-webkit-appearance: none; appearance: none;
	width: 100%; box-sizing: border-box;
	background: var(--gp-surface-chip); border: 1px solid var(--gp-rule);
	border-radius: 4px; padding: 8px 11px;
	font-family: var(--gp-mono); font-size: 12.5px; line-height: 18.5px;
	color: var(--gp-text); box-shadow: none;
}
.gp-panel .gp-search:focus { outline: none; border-color: color-mix(in srgb, var(--gp-accent) 45%, transparent); }
.gp-panel .gp-search::placeholder { color: var(--gp-text-dim); }

/* The chevron: a stroked SVG in a flex-centred box. A text glyph (U+2304)
   cannot be centred against a label — its metrics differ per font, so it hangs
   below the optical centre by an amount nothing can correct for. */
.gp-chev {
	display: flex; align-items: center; justify-content: center;
	width: 12px; height: 12px; flex: none; color: var(--gp-accent-text);
}
.gp-chev svg { display: block; }

/* Tick box. 2px radius — the one thing in this plugin that is not 4px. */
.gp-cb {
	display: flex; align-items: center; justify-content: center; flex: none;
	/* The tick takes the SAME token the row labels take, not the palette's
	   selected-row foreground: that one lands a step darker and reads grey
	   against the band. */
	border-radius: 2px; line-height: 1; color: var(--gp-text);
	background: transparent;
	/* The design's 20% veil is too faint to read as a control on this panel;
	   Parham called it out on every checkbox. 40% reads as an empty box. */
	border: 1px solid var(--gp-veil-40);
}
/* The selection band, the same one the chosen row and the chosen value wear,
   rather than the brighter accent: a ticked box is a thing selected. */
.gp-cb.is-on { background: var(--gp-accent-band); border-color: var(--gp-accent-band); }
.gp-cb .ti { display: block; line-height: 1; }
/* ONE size for every selection box in the plugin, at Parham's call. The design
   sized them per column and per list (17, 15, 14, 13) and in the built screens
   that reads as boxes failing to line up rather than as a hierarchy. 13 is the
   smallest of them, and the one it settled on. Only the Change screen's confirm
   keeps a size of its own (gp-cb-16): that is a destructive-action control, not
   a selection. */
.gp-cb-13 { width: 13px; height: 13px; font-size: 9px; }
/* A pick row aligns to the top of a two-line label, so its box needs the nudge
   the retired 15px class used to carry. Rows that centre their contents do not,
   which is why this is scoped rather than sitting on the size. */
.gp-pickrow .gp-cb { margin-top: 1px; }

/* ── Add Properties: stepper ─────────────────────────────────────────────── */
.gp-stepper { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
.gp-step {
	font-weight: 600; font-size: 12px; line-height: 15.5px; padding: 5px 10px; border-radius: 4px;
	color: var(--gp-text-body); background: var(--gp-veil-5);
}
.gp-step.is-on { color: var(--gp-on-accent); background: var(--gp-accent); }
.gp-step.is-locked:not(.is-on) { color: var(--gp-text-dim); cursor: default; }
.gp-steparrow { color: var(--gp-text-dim); font-size: 12px; line-height: 15.5px; }

/* ── Add Properties, step 1 ──────────────────────────────────────────────── */
.gp-two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
.gp-col-l { padding-right: 20px; border-right: 1px solid var(--gp-rule); min-width: 0; }
.gp-col-r { padding-left: 20px; min-width: 0; }
.gp-picklist { margin-top: 10px; max-height: 268px; overflow: auto; }
/* The group break, not the rows, is what sets the rhythm of both columns:
   rows are 52.9px on either side and 54px apart within a group, but a break
   costs a 10px caps header plus this margin. The left column carries up to
   three of them and the collections beside it two, so the value is shared.
   The design's 12px was airy at this scale and 6px closed the groups up too
   far; 8px is the next step down on the 4px grid the rest of this sheet is
   built on. */
.gp-pickgroup { margin-bottom: 8px; }
.gp-pickwrap { margin-bottom: 1px; }
.gp-pickrow {
	display: flex; align-items: flex-start; gap: 10px; width: 100%; text-align: left;
	padding: 6px 8px; border-radius: 4px; margin-bottom: 1px;
}
.gp-pickrow:hover { background: var(--gp-hover); }
.gp-pickmain { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.gp-pickname { font-weight: 500; font-size: 13px; line-height: 17px; color: var(--gp-text); }
.gp-pickmeta {
	font-size: 11.5px; line-height: 15px; color: var(--gp-text-dim);
	white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.gp-pickempty { padding: 10px 8px; font-size: 12.5px; line-height: 16px; color: var(--gp-text-dim); }
/* Drift strip: amber, because it reports a state rather than a failure. */
.gp-drift {
	display: flex; flex-direction: column; align-items: flex-start; gap: 5px;
	margin: 2px 0 6px 33px; padding: 8px 10px; border-radius: 4px;
	background: color-mix(in srgb, var(--gp-warn) 7%, transparent);
	border: 1px solid color-mix(in srgb, var(--gp-warn) 22%, transparent);
}
.gp-drifttext { font-size: 11.5px; line-height: 1.45; color: var(--gp-warn); text-wrap: pretty; }

/* ── Add Properties, step 2: order ───────────────────────────────────────── */
.gp-order { display: grid; grid-template-columns: 190px 1fr; gap: 0; }
.gp-order-l { padding-right: 16px; border-right: 1px solid var(--gp-rule); min-width: 0; }
.gp-order-r { padding-left: 20px; min-width: 0; }
.gp-ordertab {
	display: flex; flex-direction: column; gap: 2px; width: 100%; text-align: left;
	padding: 8px 10px; border-radius: 4px; font-weight: 500; font-size: 13px; line-height: 17px;
	color: var(--gp-text-body); background: transparent;
}
.gp-ordertab:hover { background: var(--gp-hover); }
.gp-ordertab.is-on {
	font-weight: 600; color: var(--gp-text);
	background: var(--gp-veil-7);
}
.gp-ordertabmeta { font-size: 11px; line-height: 14px; color: var(--gp-text-dim); }
.gp-orderhead {
	display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
	padding: 0 2px 8px;
}
.gp-orderhead .gp-caps { padding: 0; }
.gp-orderhint { font-size: 11.5px; line-height: 15px; color: var(--gp-text-dim); }
.gp-orderlist { max-height: 236px; overflow: auto; }
/* No border by default: it appears only on the row being dragged, so the list
   reads as a stack rather than as a grid of boxes. */
.gp-orderrow {
	display: grid; grid-template-columns: 16px minmax(0,1fr) max-content max-content;
	align-items: center; gap: 10px; padding: 8px 10px; margin-bottom: 2px;
	border-radius: 4px; cursor: grab;
	background: var(--gp-veil-3);
	border: 1px solid transparent;
}
.gp-orderrow.is-new { background: color-mix(in srgb, var(--gp-accent) 10%, transparent); }
.gp-orderrow.is-dragging {
	background: color-mix(in srgb, var(--gp-accent) 18%, transparent);
	border-color: color-mix(in srgb, var(--gp-accent) 55%, transparent);
}
.gp-grip { font-size: 12px; line-height: 15.5px; color: var(--gp-text-dim); cursor: grab; letter-spacing: .1em; }
/* Pointer-driven reordering: the row must not start a text selection or hand
   the gesture to the scroller. It also has to LOOK draggable — there was no
   hover and no cursor change, so nothing invited the gesture. */
.gp-orderrow {
	user-select: none; -webkit-user-select: none; touch-action: none;
	cursor: grab; transition: background .1s ease;
}
.gp-orderrow:hover { background: var(--gp-veil-8); }
.gp-orderrow:hover .gp-grip { color: var(--gp-text-2); }
.gp-orderrow:active, .gp-orderrow.is-dragging { cursor: grabbing; }
/* The row under the pointer during a drag keeps the accent it already had. */
.gp-orderrow.is-new:hover { background: color-mix(in srgb, var(--gp-accent) 16%, transparent); }
.gp-orderrow.is-dragging:hover {
	background: color-mix(in srgb, var(--gp-accent) 18%, transparent);
}
/* A moved property is marked exactly the way a new one is on the Order step:
   the same tint and the same pill, reading MOVED instead of NEW. Two screens
   drawing the same kind of list should not invent two different marks.
   Declared after the hover rules so hovering a moved row does not wash the
   mark off. */
.gp-orderrow.is-moved { background: color-mix(in srgb, var(--gp-accent) 10%, transparent); }
.gp-orderrow.is-moved:hover { background: color-mix(in srgb, var(--gp-accent) 16%, transparent); }
.gp-orderrow.is-moved.is-dragging, .gp-orderrow.is-moved.is-dragging:hover {
	background: color-mix(in srgb, var(--gp-accent) 18%, transparent);
}
.gp-ordername {
	font-weight: 500; font-size: 13px; line-height: 17px; color: var(--gp-text);
	white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.gp-ordername.is-out { color: var(--gp-text-dim); }
.gp-ordertype { font-size: 11.5px; line-height: 15px; color: var(--gp-text-dim); }
.gp-ordertoggle {
	display: flex; align-items: center; gap: 7px; padding: 2px 4px;
	border-radius: 4px; white-space: nowrap;
}
.gp-ordertoggle:hover { opacity: .85; }
.gp-tag {
	font-weight: 500; font-size: 9.5px; line-height: 12.5px; letter-spacing: .1em; white-space: nowrap;
	border-radius: 4px; padding: 2px 5px; color: var(--gp-accent-text);
	background: color-mix(in srgb, var(--gp-accent) 10%, transparent);
	border: 1px solid color-mix(in srgb, var(--gp-accent) 25%, transparent);
}
.gp-tag.is-out {
	color: var(--gp-text-dim);
	background: var(--gp-veil-5);
	border-color: var(--gp-veil-8);
}
.gp-orderold { font-size: 11px; line-height: 14px; color: var(--gp-text-dim); white-space: nowrap; opacity: .7; }
.gp-ordernote {
	padding: 10px 2px 0; font-size: 11.5px; line-height: 1.6;
	color: var(--gp-text-dim); text-wrap: pretty;
}

/* ── Templates ───────────────────────────────────────────────────────────── */
.gp-tplbody { padding: 18px 24px 8px; }
.gp-tplcard { border: 1px solid var(--gp-rule); border-radius: 4px; padding: 14px; margin-bottom: 10px; }
.gp-tplhead {
	display: flex; align-items: flex-start; justify-content: space-between;
	gap: 12px; margin-bottom: 10px;
}
.gp-tplmain { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.gp-tpltitle { font-weight: 600; font-size: 14px; line-height: 18px; color: var(--gp-text); }
.gp-panel .gp-tplname {
	background: var(--gp-surface-chip);
	border: 1px solid color-mix(in srgb, var(--gp-accent) 35%, transparent);
	border-radius: 4px; padding: 5px 8px; font-weight: 600; font-size: 14px; line-height: 18px; color: var(--gp-text);
}
.gp-panel .gp-tplname:focus { outline: none; border-color: var(--gp-accent); }
.gp-tplmeta { font-size: 12px; line-height: 15.5px; color: var(--gp-text-dim); }
.gp-tplacts { display: flex; align-items: center; gap: 6px; flex: none; }
.gp-addto {
	font-weight: 600; font-size: 12.5px; line-height: 16px; color: var(--gp-on-accent);
	background: var(--gp-accent); border-radius: 4px; padding: 7px 14px; white-space: nowrap;
}
.gp-addto:hover { filter: brightness(1.08); }
.gp-tpledit {
	font-weight: 500; font-size: 12.5px; line-height: 16px; padding: 7px 14px; border-radius: 4px;
	white-space: nowrap; color: var(--gp-text-2); background: transparent;
	border: 1px solid var(--gp-faint);
}
.gp-tpledit:hover { border-color: var(--gp-veil-28); }
.gp-tpledit.is-on {
	font-weight: 600; color: var(--gp-on-accent);
	background: var(--gp-accent); border-color: var(--gp-accent);
}
.gp-tplchips { display: flex; flex-wrap: wrap; gap: 6px; }
.gp-tplchip {
	display: inline-flex; align-items: center; gap: 6px;
	background: var(--gp-surface-chip); border: 1px solid var(--gp-rule);
	border-radius: 4px; padding: 6px 10px; white-space: nowrap;
}
.gp-tplchipname { font-weight: 600; font-size: 12.5px; line-height: 16px; color: var(--gp-accent-text); }
.gp-tplchiptype { font-size: 11px; line-height: 14px; color: var(--gp-text-dim); }
.gp-tplchipx { font-size: 13px; line-height: 1; color: var(--gp-text-dim); padding: 0 0 0 2px; }
.gp-tplchipx:hover { color: var(--gp-text); }
.gp-tpledit-body { margin-top: 10px; }
.gp-tpladd {
	border: 1px solid color-mix(in srgb, var(--gp-accent) 28%, transparent);
	background: color-mix(in srgb, var(--gp-accent) 5%, transparent);
	border-radius: 4px; padding: 12px;
}
.gp-tpladdbar { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.gp-tpladdbar .gp-search { flex: 1; }
.gp-candlist { display: grid; grid-template-columns: 1fr 1fr; gap: 1px 12px; max-height: 172px; overflow: auto; }
.gp-candrow {
	display: flex; align-items: center; gap: 9px; width: 100%; text-align: left;
	padding: 6px 8px; border-radius: 4px; min-width: 0;
}
.gp-candrow:hover { background: var(--gp-veil-5); }
.gp-candplus { font-size: 13px; line-height: 17px; color: var(--gp-accent-text); flex: none; }
.gp-candname {
	font-weight: 500; font-size: 13px; line-height: 17px; color: var(--gp-text);
	white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.gp-candmeta { font-size: 11px; line-height: 14px; color: var(--gp-text-dim); white-space: nowrap; flex: none; }
.gp-candempty { padding: 6px 8px; font-size: 12.5px; line-height: 16px; color: var(--gp-text-dim); grid-column: 1 / -1; }
.gp-tplfoot {
	display: flex; align-items: center; justify-content: space-between; gap: 16px;
	margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--gp-rule);
}
.gp-tplfoottext { font-size: 12px; line-height: 1.55; color: var(--gp-text-dim); text-wrap: pretty; }
.gp-emptycard {
	border: 1px dashed var(--gp-veil-10); border-radius: 4px;
	padding: 22px; text-align: center; font-size: 13px; line-height: 1.65;
	color: var(--gp-text-dim); text-wrap: pretty;
}
.gp-newtpl {
	border: 1px solid color-mix(in srgb, var(--gp-accent) 28%, transparent);
	background: color-mix(in srgb, var(--gp-accent) 5%, transparent);
	border-radius: 4px; padding: 14px; margin-bottom: 10px;
}
.gp-newtpltitle { font-weight: 600; font-size: 13.5px; line-height: 17.5px; color: var(--gp-text); margin-bottom: 10px; }
.gp-newtplgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.gp-newtplcol { min-width: 0; }
.gp-newtplcol .gp-caps { padding: 0 0 6px 2px; }
.gp-newtpllist { max-height: 188px; overflow: auto; }
.gp-newtplcoll {
	display: block; width: 100%; text-align: left; padding: 7px 9px; border-radius: 4px;
	font-weight: 500; font-size: 13px; line-height: 17px; color: var(--gp-text-body); background: transparent;
	white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.gp-newtplcoll:hover { background: var(--gp-hover); }
.gp-newtplcoll.is-on {
	font-weight: 600; color: var(--gp-text);
	background: var(--gp-veil-7);
}
.gp-newtplfield {
	display: flex; align-items: center; gap: 9px; width: 100%; text-align: left;
	padding: 6px 8px; border-radius: 4px; min-width: 0;
}
.gp-newtplfield:hover { background: var(--gp-hover); }
.gp-newtplfname {
	font-weight: 500; font-size: 13px; line-height: 17px; color: var(--gp-text);
	white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.gp-newtplftype { font-size: 11px; line-height: 14px; color: var(--gp-text-dim); flex: none; }
.gp-newtplbar { display: flex; align-items: center; gap: 10px; margin-top: 14px; }
.gp-panel .gp-newtplinput {
	flex: 1; background: var(--gp-surface-chip); border: 1px solid var(--gp-rule);
	border-radius: 4px; padding: 9px 11px; font-size: 13px; line-height: 17px; color: var(--gp-text);
}
.gp-panel .gp-newtplinput:focus { outline: none; border-color: color-mix(in srgb, var(--gp-accent) 45%, transparent); }
.gp-newtplbar .gp-primary { padding: 9px 18px; }

/* ── the rules screens ───────────────────────────────────────────────────── */
.gp-seg {
	display: flex; align-items: center; gap: 3px; width: 300px; padding: 3px;
	background: var(--gp-veil-5);
	border-radius: 4px; margin-bottom: 14px;
}
.gp-seg button {
	flex: 1; padding: 9px; border-radius: 4px; background: transparent;
	color: var(--gp-text-body); font-size: 12.5px; line-height: 16px; font-weight: 500; text-align: center;
	transition: background .12s ease, color .12s ease;
}
.gp-seg button:hover { color: var(--gp-text); }
.gp-seg button.is-on { background: var(--gp-accent); color: var(--gp-on-accent); font-weight: 600; }

.gp-pickline { display: flex; align-items: flex-end; gap: 12px; margin-bottom: 16px; }
.gp-anchor { position: relative; }
.gp-pickline .gp-caps { padding: 0 0 6px 2px; }
.gp-trigger {
	display: flex; align-items: center; justify-content: space-between; gap: 12px;
	min-width: 230px; padding: 9px 12px; border-radius: 4px; white-space: nowrap;
	border: 1px solid color-mix(in srgb, var(--gp-accent) 35%, transparent);
	background: color-mix(in srgb, var(--gp-accent) 8%, transparent);
	color: var(--gp-accent-text); font-size: 13.5px; line-height: 17.5px; font-weight: 500;
	transition: background .12s ease, border-color .12s ease;
}
.gp-trigger:hover {
	border-color: color-mix(in srgb, var(--gp-accent) 60%, transparent);
	background: color-mix(in srgb, var(--gp-accent) 14%, transparent);
}
/* The note sits on the trigger's baseline, so it carries the trigger's own
   bottom inset and nothing else. */
.gp-sidenote { font-size: 12.5px; line-height: 16px; color: var(--gp-text-dim); padding-bottom: 10px; }

/* ── popovers ────────────────────────────────────────────────────────────── */
.gp-pop {
	position: absolute; top: calc(100% + 4px); left: 0; z-index: 30; width: 320px;
	background: var(--gp-surface-pop); border: 1px solid var(--gp-line); border-radius: 4px;
	box-shadow: 0 18px 40px rgba(0,0,0,.5);
}
.gp-pop-value { width: 320px; }
.gp-pop-field { width: 300px; }
.gp-pop-excl { width: 340px; }
.gp-popnote {
	padding: 11px 14px 10px; font-size: 12px; line-height: 1.55;
	color: var(--gp-text-body); border-bottom: 1px solid var(--gp-rule); text-wrap: pretty;
}
.gp-popsearchwrap { padding: 12px; }
/* A popover search sits on the popover's own plate, not on a raised one. */
.gp-panel .gp-popsearch { background: none; border-color: var(--gp-veil-10); padding: 9px 11px; }
/* The picker lists borrow the HOST's font, not the plugin's. That is the
   style guide's rule — where Thymer already has a component the user knows, use
   it as the app draws it — and the design file sets it on every popover list.
   It is also why these rows are 33px and not 35: system-ui's line box at 13px
   is 15, Space Grotesk's is 17. */
.gp-poplist {
	/* 3px, not the design's 1px. A 1px gap snaps to 0.55 device pixels on a
	   1.83 DPR display, so two highlighted rows next to each other (the
	   keyboard cursor sitting above the chosen value) read as one merged
	   plate. Measured after: 3px of gap, 5.47 device pixels, unmistakable.
	   The row gives 2px back off its own padding so the plate shrinks rather
	   than the list growing by the whole gap. */
	padding: 0 12px 12px; display: flex; flex-direction: column; gap: 3px;
	max-height: 248px; overflow: auto;
	font-family: system-ui, -apple-system, sans-serif;
}
.gp-pop-value .gp-poplist { max-height: 196px; padding: 0 12px 10px; }
.gp-pop-value .gp-popsearchwrap { padding: 10px 12px; }
.gp-panel .gp-pop-value .gp-popsearch { padding: 8px 10px; }
.gp-pop-field .gp-poplist { max-height: 236px; padding: 10px 12px; }
.gp-pop-excl .gp-poplist { max-height: 236px; }
.gp-poprow {
	display: flex; align-items: center; justify-content: space-between; gap: 10px;
	/* 8px, one less than the design's 9: the two pixels pay for the gap above,
	   so a row's plate shrinks slightly while the list's rhythm stays put. */
	width: 100%; text-align: left; padding: 8px 12px; border-radius: 4px;
	background: transparent; color: var(--gp-text-2); font-size: 13px; line-height: 15px;
}
/* Three row states, all borrowed from the host's own command palette rather
   than invented: nothing at rest, Thymer's hover plate under the keyboard or
   the pointer, and its selected-row teal on the value actually set.
   The teal belongs to the SET value. Giving it to the focused row as well made
   a just-opened picker look like it had two values chosen at once, because the
   keyboard cursor starts on row one: None and @today both came up teal.
   Do NOT reach for --cmdpal-hover-fg-color to go with the plate. It resolves
   to BLACK in this theme (and --cmdpal-current-bg/fg are both #FFFFFF), so the
   palette's fg tokens cannot be trusted; only the bg ones were measured good.
   The old marker was a 6% grey veil, which was invisible. */
.gp-poprow:hover, .gp-poprow.is-active {
	background: var(--cmdpal-hover-bg-color, var(--gp-veil-6));
	color: var(--gp-text);
}
.gp-poprow:hover .gp-popcount, .gp-poprow.is-active .gp-popcount,
.gp-poprow:hover .gp-colicon, .gp-poprow.is-active .gp-colicon { color: inherit; opacity: 1; }
.gp-poprow.is-on { background: var(--gp-accent-band); color: var(--cmdpal-selected-fg-color, #f2fbf9); }
.gp-poprow.is-on .gp-popcount { color: inherit; }
.gp-poprow.is-off { color: var(--gp-text-dim); cursor: not-allowed; }
.gp-poprow.is-off:hover { background: transparent; }
.gp-popcount { font-size: 11px; line-height: 14px; color: var(--gp-text-dim); white-space: nowrap; }
/* A group break inside a popover list. First one sits flush; the rest get
   air above so the two bands read apart. */
.gp-poplist .gp-popgroup { padding: 2px 12px 4px; }
.gp-poplist .gp-popgroup ~ .gp-popgroup { padding-top: 10px; }
/* Amber, not red: excluding never deletes a rule, it only stops it firing. */
.gp-popwarn { font-size: 11px; line-height: 14px; color: #c9a227; white-space: nowrap; }
.gp-popempty { padding: 10px 12px; font-size: 12.5px; line-height: 16px; color: var(--gp-text-dim); font-family: var(--gp-font); }
.gp-poprule { height: 1px; background: var(--gp-rule); }
.gp-popfoot {
	display: block; width: 100%; text-align: left; padding: 11px 14px;
	background: transparent; font-size: 12.5px; line-height: 16px; font-weight: 500; color: var(--gp-accent-text);
}
.gp-popfoot.is-quiet { color: var(--gp-text-body); }
.gp-popfoot:hover { color: var(--gp-text); }

/* ── collection icons ────────────────────────────────────────────────────── */
/* Thymer's own glyph, at the size it uses in the sidebar. Quiet by default so
   the NAME is what you read; it brightens with its row. */
.gp-colicon {
	flex: none; font-size: 14px; line-height: 1; width: 16px;
	color: var(--gp-text-dim); opacity: .9;
}
.gp-poplabel, .gp-triglabel, .gp-ordertabname {
	display: flex; align-items: center; gap: 8px; min-width: 0;
}
.gp-poplabel > span, .gp-triglabel > span, .gp-ordertabname {
	overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.gp-poprow.is-on .gp-colicon, .gp-triglabel .gp-colicon { color: inherit; opacity: 1; }
.gp-pickname .gp-colicon { margin-right: 7px; vertical-align: -2px; }
.gp-chip .gp-colicon { color: var(--gp-accent-text); opacity: 1; }
.gp-newtplcoll { display: flex; align-items: center; gap: 8px; }
.gp-newtplcoll > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gp-ordertab .gp-ordertabname { font: inherit; }

/* ── the tables ──────────────────────────────────────────────────────────── */
.gp-grid { display: grid; align-items: center; }
.gp-grid-inherit { grid-template-columns: minmax(160px,1fr) 140px 140px 140px; gap: 14px 12px; }
.gp-grid-inherit.is-tight { grid-template-columns: minmax(120px,1fr) 96px 96px 96px; }
.gp-grid-def { grid-template-columns: minmax(160px,240px) 220px; gap: 12px; width: max-content; }
.gp-gridrule { grid-column: 1 / -1; height: 1px; background: var(--gp-rule); margin: 0 0 2px; }
.gp-mid { display: flex; justify-content: center; }
.gp-caps.gp-mid { text-align: center; white-space: nowrap; display: block; }
.gp-cellname { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.gp-fname2 {
	font-weight: 500; font-size: 13.5px; line-height: 17.5px; color: var(--gp-text);
	white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.gp-ftype { font-size: 11.5px; line-height: 15px; color: var(--gp-text-dim); }
/* An em dash where a toggle would do nothing. Quieter than the row's own dim
   text, so it reads as absence rather than as a value. */
.gp-dash { font-size: 13px; line-height: 17px; color: color-mix(in srgb, var(--gp-text-dim) 70%, transparent); }
.gp-tick { padding: 5px; border-radius: 4px; background: transparent; }
.gp-tick:hover { background: var(--gp-veil-5); }
.gp-legend { padding: 12px 2px 0; font-size: 11.5px; line-height: 1.6; color: var(--gp-text-dim); text-wrap: pretty; }
/* The value button has two states: quiet while it is still asking for a value,
   teal once it carries one. */
.gp-valuebtn {
	display: flex; align-items: center; justify-content: space-between; gap: 6px;
	width: 100%; box-sizing: border-box; border-radius: 4px; padding: 7px 9px;
	white-space: nowrap; font-weight: 400; font-size: 12.5px; line-height: 16px;
	color: var(--gp-text-body); border: 1px solid var(--gp-veil-10);
	background: transparent;
}
.gp-valuebtn .gp-chev { color: inherit; opacity: .85; }
.gp-valuelabel { overflow: hidden; text-overflow: ellipsis; }
.gp-valuebtn.is-set {
	font-weight: 500; color: var(--gp-accent-text);
	border-color: color-mix(in srgb, var(--gp-accent) 35%, transparent);
	background: color-mix(in srgb, var(--gp-accent) 8%, transparent);
}
.gp-valuebtn:hover { border-color: var(--gp-veil-20); }
.gp-valuebtn.is-set:hover { border-color: color-mix(in srgb, var(--gp-accent) 60%, transparent); }
.gp-addwrap {
	margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--gp-rule);
	width: 472px; max-width: 100%;
}

/* ── excluded chips ──────────────────────────────────────────────────────── */
.gp-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
.gp-chip {
	display: inline-flex; align-items: center; gap: 8px; padding: 6px 10px;
	background: var(--gp-surface-chip); border: 1px solid var(--gp-rule);
	border-radius: 4px; white-space: nowrap;
}
.gp-chipname { font-weight: 600; font-size: 12.5px; line-height: 16px; color: var(--gp-accent-text); }
.gp-chipx { padding: 0 0 0 2px; font-size: 13px; line-height: 1; color: var(--gp-text-dim); }
.gp-chipx:hover { color: var(--gp-text); }

/* ── the import / clash rows, kept from the fold-in ──────────────────────── */
.gp-importcard { border: 1px solid var(--gp-rule); border-radius: 4px; padding: 14px; }
.gp-clash {
	border: 1px solid color-mix(in srgb, var(--gp-warn) 35%, transparent);
	background: color-mix(in srgb, var(--gp-warn) 8%, transparent);
	border-radius: 4px; padding: 12px 14px; margin-top: 14px;
}
.gp-clashtitle { font-weight: 600; font-size: 13px; line-height: 17px; color: var(--gp-warn); margin-bottom: 4px; }
.gp-clashtext { font-size: 12px; line-height: 1.55; color: var(--gp-text-body); text-wrap: pretty; }
.gp-clashbtn {
	margin-top: 8px; font-weight: 600; font-size: 12px; line-height: 15.5px; color: var(--gp-warn);
	padding: 3px 6px; border-radius: 4px;
}
.gp-clashbtn:hover { filter: brightness(1.25); }

/* ── Rearrange ───────────────────────────────────────────────────────────── */
.gp-rearcol {
	display: flex; align-items: center; justify-content: space-between; gap: 10px;
	width: 100%; text-align: left; padding: 8px 10px; border-radius: 4px;
	margin-bottom: 1px; font-weight: 500; font-size: 13px; line-height: 17px;
	color: var(--gp-text-body); background: transparent;
}
.gp-rearcol:hover { background: var(--gp-veil-4); }
/* Thymer's own selection band, the same one its pickers and this plugin's
   popover rows use. A grey veil was tried at 3% and at 10% and neither reads as
   chosen the way the native band does. */
.gp-rearcol.is-on {
	font-weight: 600; background: var(--gp-accent-band);
	color: var(--cmdpal-selected-fg-color, #f2fbf9);
}
.gp-rearcol.is-on:hover { background: var(--gp-accent-band); }
.gp-rearcol.is-on .gp-colicon, .gp-rearcol.is-on .gp-rearmeta { color: inherit; opacity: 1; }
.gp-rearmeta { font-size: 11px; line-height: 14px; color: var(--gp-text-dim); white-space: nowrap; flex: none; }
/* A collection you have actually moved something in says so, so the Save
   button's count is traceable to specific rows. */
.gp-rearcol.is-moved .gp-rearmeta { color: var(--gp-accent-text); }
/* Both columns fill the panel and scroll on their own. */
.gp-fill { flex: 1; min-height: 0; }
.gp-rear-grid > .gp-col-l, .gp-rear-grid > .gp-col-r {
	display: flex; flex-direction: column; min-height: 0;
}
.gp-rear-grid .gp-rearcols, .gp-rear-grid .gp-rearfields {
	flex: 1; min-height: 0; max-height: none; overflow-y: auto;
}
.gp-rearfields { margin-top: 8px; }
.gp-rearrow { grid-template-columns: 16px minmax(0,1fr) max-content; }
/* Only a moved row carries the fourth cell. Widening every row instead would
   put the grid's 10px gap after the type column on rows that have nothing to
   put there, and shift the type left on all the others. */
.gp-rearrow.is-moved { grid-template-columns: 16px minmax(0,1fr) max-content max-content; }
.gp-rearrow .gp-ordername { display: flex; align-items: center; gap: 8px; }

/* ── Change: the one non-additive screen, and it looks it ────────────────── */
/* Amber throughout, never the teal the additive screens use. Red is reserved
   for the single case this screen cannot fix: a field another plugin pairs. */
.gp-changehead { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
.gp-changebadge {
	font-weight: 500; font-size: 10px; line-height: 13px; letter-spacing: .14em; color: var(--gp-warn);
	background: color-mix(in srgb, var(--gp-warn) 10%, transparent);
	border: 1px solid color-mix(in srgb, var(--gp-warn) 30%, transparent);
	border-radius: 4px; padding: 3px 7px; white-space: nowrap;
}
.gp-changetitle { font-weight: 600; font-size: 15px; line-height: 19.5px; color: var(--gp-text); }
.gp-blurb-660 { max-width: 660px; }
.gp-changeband {
	display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 8px;
	padding: 12px 14px; border-radius: 4px; margin-bottom: 18px;
	background: color-mix(in srgb, var(--gp-accent) 7%, transparent);
	border: 1px solid color-mix(in srgb, var(--gp-accent) 28%, transparent);
}
.gp-bandtext { font-size: 12.5px; line-height: 16px; color: var(--gp-text-body); white-space: nowrap; }
.gp-bandprop { font-weight: 600; font-size: 13px; line-height: 17px; color: var(--gp-accent-text); white-space: nowrap; }
.gp-bandspec { font-size: 12px; line-height: 15.5px; color: var(--gp-text-dim); }
.gp-changegrid {
	display: grid; align-items: center; gap: 10px 14px;
	grid-template-columns: 22px minmax(120px,180px) minmax(200px,1fr) max-content;
}
.gp-right { text-align: right; }
.gp-changetick { display: flex; justify-content: center; padding: 2px; border-radius: 4px; }
.gp-changetick:hover { opacity: .8; }
.gp-changecol { display: flex; align-items: center; gap: 7px; min-width: 0;
	font-weight: 500; font-size: 13px; line-height: 17px; color: var(--gp-text); }
.gp-changecol > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gp-changecol.is-off, .gp-changetext.is-off { color: var(--gp-text-dim); }
.gp-changetext { font-size: 12.5px; line-height: 1.5; color: var(--gp-text-body); text-wrap: pretty; }
.gp-syncedtag {
	font-weight: 500; font-size: 9px; line-height: 12px; letter-spacing: .1em; white-space: nowrap;
	color: var(--gp-danger); background: color-mix(in srgb, var(--gp-danger) 10%, transparent);
	border: 1px solid color-mix(in srgb, var(--gp-danger) 35%, transparent);
	border-radius: 4px; padding: 2px 5px; flex: none;
}
.gp-changenote { padding: 12px 2px 0; font-size: 11.5px; line-height: 15px; color: var(--gp-text-dim); }
.gp-syncedband {
	margin-top: 14px; padding: 11px 13px; border-radius: 4px;
	font-size: 12px; line-height: 1.6; color: var(--gp-danger); text-wrap: pretty;
	background: color-mix(in srgb, var(--gp-danger) 8%, transparent);
	border: 1px solid color-mix(in srgb, var(--gp-danger) 30%, transparent);
}
/* Record cost: amber when it is non-zero, because there IS a fix on this
   screen — untick the collection. Grey when nothing is affected. */
.gp-costcell { display: flex; justify-content: flex-end; }
.gp-cost { font-size: 12px; line-height: 15.5px; white-space: nowrap; text-align: right; color: var(--gp-text-dim); }
.gp-cost.is-off { color: var(--gp-text-dim); opacity: .6; }
.gp-cost.is-hot {
	color: var(--gp-warn); cursor: pointer;
	border-bottom: 1px dashed color-mix(in srgb, var(--gp-warn) 50%, transparent); padding-bottom: 1px;
}
.gp-costcell:hover .gp-cost.is-hot { border-bottom-color: var(--gp-warn); }
.gp-pop-cost { width: 330px; }
.gp-costlist { max-height: 216px; padding: 10px 12px; }
.gp-costrow { display: flex; flex-direction: column; gap: 3px; padding: 8px 10px; border-radius: 4px; }
.gp-costtitle { font-weight: 500; font-size: 12.5px; line-height: 16px; color: var(--gp-text-2); }
.gp-costvals { font-size: 11.5px; line-height: 1.5; }
.gp-costkeep { color: var(--gp-accent-text); }
.gp-costlose { color: var(--gp-text-dim); }
.gp-costmore { padding: 0 14px 10px; font-size: 11.5px; line-height: 15px; color: var(--gp-text-dim); }
.gp-costfoot { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 12px; }
.gp-costlink { font-weight: 500; font-size: 12px; line-height: 15.5px; color: var(--gp-accent-text); padding: 5px 6px; border-radius: 4px; }
.gp-costlink.is-quiet { color: var(--gp-text-body); }
.gp-costlink:hover { color: var(--gp-text); }
/* The confirm tick, and the amber button it unlocks. */
.gp-confirmbtn { display: flex; align-items: center; gap: 10px; text-align: left; max-width: 520px; }
.gp-confirmbtn:hover { opacity: .85; }
.gp-cb-16 { width: 16px; height: 16px; font-size: 11px; }
.gp-cb-warn.is-on { background: var(--gp-warn); border-color: var(--gp-warn); color: #171208; }
.gp-confirmlabel { font-size: 12.5px; line-height: 1.55; color: var(--gp-text-body); text-wrap: pretty; }
.gp-warnbtn {
	font-weight: 600; font-size: 13px; line-height: 17px; border-radius: 4px;
	padding: 9px 20px; white-space: nowrap;
	color: #171208; background: var(--gp-warn); border: 1px solid var(--gp-warn);
}
.gp-warnbtn:hover:not(:disabled) { filter: brightness(1.08); }
.gp-warnbtn:disabled {
	color: color-mix(in srgb, var(--gp-warn) 45%, transparent);
	background: transparent;
	border-color: color-mix(in srgb, var(--gp-warn) 25%, transparent);
	cursor: default;
}
/* The entry point, in the Add list. */
.gp-driftbtn {
	font-weight: 600; font-size: 11.5px; line-height: 15px; color: var(--gp-warn);
	white-space: nowrap; padding: 3px 6px; border-radius: 4px;
}
.gp-driftbtn:hover { filter: brightness(1.25); }

/* ── Fill From Title, Keyword Aliases, Fill In Settings ────────────────── */
/* One row grammar (design §6.0): 24px tick · 176px field · the rest, value
   with its reason beneath. The tick cell is exactly the field cell's line box
   (13.5px × 1.45 + 2×3px = 25.6px) so a box sits on the FIRST line of a row
   that wraps. Checkboxes 13px, 2px radius, 40% veil border, selection band
   fill. Sections are caps on their own line with copy beneath, 620px max. */
.gp-fblurb { margin-bottom: 14px; }
.gp-fband {
	display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px;
	padding: 11px 14px; border-radius: 4px; margin-bottom: 16px;
	background: color-mix(in srgb, var(--gp-accent) 7%, transparent);
	border: 1px solid color-mix(in srgb, var(--gp-accent) 30%, transparent);
}
.gp-fbandtext { font-size: 13px; color: var(--gp-text-body); white-space: nowrap; }
.gp-fbandprop { font-weight: 600; font-size: 13.5px; color: var(--gp-accent-text); }
.gp-fcaps { font-weight: 500; font-size: 10.5px; letter-spacing: .14em; color: var(--gp-text-dim); }
.gp-frule { grid-column: 1 / -1; height: 1px; background: var(--gp-veil-7); margin: 7px 0 3px; }
.gp-fgrid { display: grid; grid-template-columns: 24px 176px minmax(0, 1fr); align-items: start; gap: 0 12px; min-width: 0; }
.gp-fgrid.is-row { padding: 3px 0; margin-bottom: 2px; }
.gp-fsec { padding: 14px 0 6px; margin-top: 12px; border-top: 1px solid var(--gp-veil-7); }
.gp-fsec.is-first { margin-top: 0; border-top: 0; padding-top: 0; }
.gp-fsec > .gp-fcaps { display: block; }
.gp-fcopy { font-size: 11.5px; line-height: 1.6; color: var(--gp-text-dim); text-wrap: pretty; max-width: 620px; margin: 5px 0 10px; }
.gp-ftick { display: flex; justify-content: center; align-items: center; height: 25.6px; padding: 0; border-radius: 4px; }
.gp-ftick:hover { opacity: .8; }
.gp-ftick.is-idle { cursor: default; opacity: .45; }
.gp-fbox {
	display: flex; align-items: center; justify-content: center; flex: none;
	width: 13px; height: 13px; border-radius: 2px; font-size: 9px; line-height: 1;
	color: var(--gp-text); background: transparent; border: 1px solid var(--gp-veil-40);
}
.gp-fbox.is-on { background: var(--gp-accent-band); border-color: var(--gp-accent-band); }
.gp-fbox.is-warn.is-on { background: var(--gp-warn); border-color: var(--gp-warn); color: #171208; }
.gp-fbox .ti { display: block; line-height: 1; }
.gp-ffield {
	display: block; width: 100%; text-align: left; font-weight: 500; font-size: 13.5px; line-height: 1.45;
	color: var(--gp-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 3px 0;
}
.gp-ffield.is-dim { color: var(--gp-text-2); }
.gp-ffield.is-plain { cursor: default; }
.gp-ffieldpick { display: flex; align-items: center; gap: 6px; }
.gp-ffieldpick > span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.gp-ffieldpick.is-dim { color: var(--gp-text-dim); }
.gp-fchev { display: flex; align-items: center; justify-content: center; width: 12px; height: 12px; flex: none; color: var(--gp-accent-text); }
.gp-fval { position: relative; display: flex; align-items: flex-start; gap: 8px; min-width: 0; padding: 3px 0; }
.gp-fval.is-prop { padding: 6px 0; }
.gp-fvalcol { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.gp-fvalue { font-weight: 500; font-size: 13.5px; line-height: 1.45; color: var(--gp-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gp-fvalue.is-wrap { white-space: normal; overflow-wrap: anywhere; text-wrap: pretty; }
.gp-fvalue .gp-colicon { margin-right: 6px; vertical-align: -2px; }
.gp-fvalue.is-dim { color: var(--gp-text-2); }
.gp-fvalue.is-teal { color: var(--gp-accent-text); }
.gp-fvalue.is-struck { color: var(--gp-text-dim); text-decoration: line-through; }
.gp-fwhy { font-size: 11.5px; line-height: 1.45; color: var(--gp-text-dim); white-space: normal; overflow-wrap: anywhere; text-wrap: pretty; }
.gp-fwhy.is-amber { color: var(--gp-warn); }
.gp-fwhy.is-teal { color: var(--gp-accent-text); }
.gp-fnote { font-size: 12.5px; line-height: 1.6; padding: 3px 0; text-wrap: pretty; color: var(--gp-text-body); }
.gp-fnote.is-dim { color: var(--gp-text-dim); }
.gp-fchevbtn { display: flex; align-items: center; justify-content: center; width: 16px; height: 16px; flex: none; margin-top: 3px; color: var(--gp-accent-text); }
.gp-fmoreline {
	align-self: flex-start; text-align: left; padding: 0; margin-top: 1px;
	font-size: 11.5px; line-height: 1.45; color: var(--gp-accent-text);
}
.gp-fmoreline:hover { filter: brightness(1.25); }
.gp-fchevbtn:hover { color: var(--gp-text); }
.gp-fstrike { flex: none; margin-top: 2px; font-size: 13px; line-height: 1; color: var(--gp-text-dim); padding: 0 2px; }
.gp-fstrike:hover { color: var(--gp-text); }
.gp-ffilledtoggle { font-weight: 500; font-size: 12px; color: var(--gp-text-dim); padding: 5px 2px; border-radius: 4px; margin-top: 14px; }
.gp-ffilledtoggle:hover { color: var(--gp-text); }
/* pickers: search first, host font in the list, chosen row on the band */
.gp-fpop { width: 320px; }
.gp-fpop-field { width: 300px; }
/* The note's text starts where the rows' text starts: list padding + row
   padding = 24px. */
.gp-fpopnote { padding: 10px 24px 9px; font-size: 12px; line-height: 1.55; color: var(--gp-text-body); text-wrap: pretty; }
.gp-fpopnote.is-ruled { padding: 11px 24px 10px; border-bottom: 1px solid var(--gp-veil-7); }
.gp-fpopsearch { padding: 10px 12px 0; }
.gp-fpopmore .gp-fpopsearch { padding-top: 4px; border-top: 1px solid var(--gp-veil-7); margin-top: 2px; padding-top: 10px; }
.gp-fpoplist { padding: 8px 12px 10px; display: flex; flex-direction: column; gap: 3px; max-height: 196px; overflow: auto; font-family: system-ui, -apple-system, sans-serif; }
.gp-fpoprow {
	display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; text-align: left;
	padding: 8px 12px; border-radius: 4px; font-size: 13px; line-height: 15px; color: var(--gp-text-2);
}
.gp-fpoprow:hover { background: var(--gp-veil-6); }
.gp-fpoprow.is-on { color: #f2fbf9; background: var(--gp-accent-band); }
.gp-fpoplabel { display: flex; align-items: center; gap: 7px; min-width: 0; }
.gp-fpoplabel > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gp-fpoplabel .gp-colicon { flex: none; }
.gp-fpopmeta { font-size: 11px; line-height: 14px; white-space: nowrap; color: var(--gp-text-dim); min-width: 0; max-width: 55%; overflow: hidden; text-overflow: ellipsis; flex: none; }
.gp-fpoprow.is-on .gp-fpopmeta { color: inherit; }
.gp-fpopempty { padding: 10px 12px; font-size: 12.5px; color: var(--gp-text-dim); font-family: var(--gp-font); }
/* footer: links left, count + actions right */
.gp-ffootlinks { display: flex; align-items: center; gap: 16px; }
.gp-flink { font-weight: 500; font-size: 12.5px; color: var(--gp-accent-text); padding: 4px 2px; border-radius: 4px; }
.gp-flink:hover { color: var(--gp-text); }
.gp-ffootnote { font-size: 12.5px; color: var(--gp-text-dim); margin-right: 4px; }
/* aliases: 200px value column, no gutter */
.gp-kgrid { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 4px 12px; align-items: center; min-width: 0; }
.gp-kgrid.is-head { gap: 0 12px; margin-bottom: 8px; }
.gp-kgroups { display: flex; flex-direction: column; gap: 14px; }
.gp-kgroup { display: flex; flex-direction: column; gap: 6px; }
.gp-khead { display: flex; align-items: baseline; gap: 10px; }
.gp-khead .gp-fcaps { white-space: nowrap; }
.gp-kcount { font-size: 11.5px; color: var(--gp-text-dim); }
.gp-klabel { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; font-weight: 500; font-size: 13.5px; line-height: 1.45; color: var(--gp-text); }
.gp-klabel > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gp-kx { font-size: 13px; line-height: 1; color: var(--gp-text-dim); padding: 0 0 0 2px; }
.gp-kx:hover { color: var(--gp-text); }
.gp-panel .gp-kinput {
	width: 100%; box-sizing: border-box; background: var(--gp-surface-chip); border: 1px solid var(--gp-veil-6);
	border-radius: 4px; padding: 7px 10px; font-family: var(--gp-mono); font-size: 12.5px; color: var(--gp-text);
}
.gp-panel .gp-kinput.has-words { background: color-mix(in srgb, var(--gp-accent) 6%, transparent); border-color: color-mix(in srgb, var(--gp-accent) 28%, transparent); }
.gp-panel .gp-kinput:focus { outline: none; border-color: color-mix(in srgb, var(--gp-accent) 45%, transparent); }
.gp-kadd { width: 200px; }
.gp-kaddbtn { width: 100%; border: 1px dashed var(--gp-faint); border-radius: 4px; padding: 9px; font-weight: 500; font-size: 12.5px; line-height: 16px; color: var(--gp-text-body); }
.gp-kaddbtn:hover, .gp-kaddbtn.is-open { border-color: var(--gp-veil-28); color: var(--gp-text); }
/* settings: the shortcut row */
.gp-scrow { gap: 0 12px; }
.gp-sclabel { font-weight: 500; font-size: 13.5px; color: var(--gp-text-2); }
.gp-scbtn {
	width: 176px; text-align: left; box-sizing: border-box; border-radius: 4px; padding: 7px 10px;
	font-family: var(--gp-mono); font-size: 12.5px; color: var(--gp-text);
	background: var(--gp-surface-chip); border: 1px solid var(--gp-veil-6);
}
.gp-scbtn.is-recording { color: var(--gp-text-dim); border-color: color-mix(in srgb, var(--gp-accent) 45%, transparent); }

/* ── tooltip ─────────────────────────────────────────────────────────────── */
/* Above the toast, because a tooltip is never the thing you want covered. */
.gp-caps[data-gptip] { cursor: help; }
/* The affordance. Same dashed underline the hoverable record cost uses, so
   "there is more behind this" has one mark in this plugin rather than two. */
.gp-tiplabel {
	border-bottom: 1px dashed color-mix(in srgb, var(--gp-text-dim) 55%, transparent);
	padding-bottom: 2px; transition: color .12s ease, border-color .12s ease;
}
.gp-caps[data-gptip]:hover .gp-tiplabel {
	color: var(--gp-text-2); border-bottom-color: var(--gp-text-2);
}
.gp-tip {
	position: fixed; z-index: 100001; max-width: 290px;
	background: var(--gp-surface-pop); color: var(--gp-text-2);
	border: 1px solid var(--gp-line); border-radius: 4px;
	padding: 8px 11px; font-size: 12px; line-height: 1.45; font-family: var(--gp-font);
	box-shadow: 0 10px 32px rgba(0,0,0,.45); pointer-events: none; text-wrap: pretty;
	opacity: 0; transition: opacity .1s ease;
}
.gp-tip.is-in { opacity: 1; }

/* ── toast ───────────────────────────────────────────────────────────────── */
.gp-toast {
	position: fixed; left: 50%; bottom: 54px; transform: translate(-50%, 12px);
	z-index: 100000; max-width: min(520px, calc(100vw - 48px));
	background: var(--gp-surface); color: var(--cmdpal-fg-color, var(--text-color, inherit));
	border: 1px solid var(--gp-line); border-radius: 4px;
	padding: 10px 16px; font-size: 13px; line-height: 17px; font-family: var(--gp-font);
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
