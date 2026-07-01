//#region src/rt.ts
let React;
let api;
let ui;
function initRuntime(a) {
	api = a;
	React = a.react;
	ui = a.ui;
}

//#endregion
//#region src/ui.tsx
/** The photos a batch action targets: the current multi-selection, or the
*  single active photo when nothing is multi-selected. Grid order is preserved
*  (we filter `photos`, not the id set). Re-renders on any selection change. */
function useSelectedPhotos() {
	const photos = api.stores.useCatalogStore((s) => s.photos);
	const selectedIds = api.stores.useCatalogStore((s) => s.selectedIds);
	const activeId = api.stores.useCatalogStore((s) => s.activePhotoId);
	return React.useMemo(() => {
		if (selectedIds.size > 0) return photos.filter((p) => selectedIds.has(p.id));
		if (activeId) {
			const a = photos.find((p) => p.id === activeId);
			return a ? [a] : [];
		}
		return [];
	}, [
		photos,
		selectedIds,
		activeId
	]);
}
/** A muted line of helper text. */
function Hint({ children }) {
	return /* @__PURE__ */ React.createElement("div", { style: {
		color: ui.tokens.textMuted,
		fontSize: 11,
		lineHeight: 1.4
	} }, children);
}
/** A small inline notice used for warnings and result summaries. `tone` picks
*  the accent colour without inventing new tokens. */
function Notice({ tone = "info", children }) {
	const color = tone === "warn" ? "var(--color-rating)" : tone === "danger" ? "#e5484d" : tone === "ok" ? "#46a758" : ui.tokens.textSecondary;
	return /* @__PURE__ */ React.createElement("div", { style: {
		borderLeft: `2px solid ${color}`,
		paddingLeft: 8,
		color: ui.tokens.textSecondary,
		fontSize: 12,
		lineHeight: 1.5
	} }, children);
}

//#endregion
//#region src/rename/engine.ts
const DEFAULT_OPTIONS = {
	template: "{name}",
	seqStart: 1,
	seqStep: 1,
	seqPad: 3,
	caseMode: "asis"
};
const TOKEN_GROUPS = [
	{
		group: "Naming",
		tokens: [
			{
				insert: "{name}",
				label: "Original name",
				sample: "IMG_1234"
			},
			{
				insert: "{seq}",
				label: "Sequence number",
				sample: "001"
			},
			{
				insert: "{seq:4}",
				label: "Sequence (width 4)",
				sample: "0001"
			},
			{
				insert: "{letter}",
				label: "Sequence letter",
				sample: "a"
			},
			{
				insert: "{LETTER}",
				label: "Sequence letter (caps)",
				sample: "A"
			},
			{
				insert: "{folder}",
				label: "Folder name",
				sample: "Trip"
			},
			{
				insert: "{ext}",
				label: "Extension",
				sample: "nef"
			}
		]
	},
	{
		group: "Capture date",
		tokens: [
			{
				insert: "{yyyy}",
				label: "Year (4)",
				sample: "2026"
			},
			{
				insert: "{yy}",
				label: "Year (2)",
				sample: "26"
			},
			{
				insert: "{mon}",
				label: "Month",
				sample: "06"
			},
			{
				insert: "{day}",
				label: "Day",
				sample: "30"
			},
			{
				insert: "{hour}",
				label: "Hour (24h)",
				sample: "14"
			},
			{
				insert: "{min}",
				label: "Minute",
				sample: "05"
			},
			{
				insert: "{sec}",
				label: "Second",
				sample: "42"
			},
			{
				insert: "{date}",
				label: "Date (yyyymmdd)",
				sample: "20260630"
			},
			{
				insert: "{time}",
				label: "Time (hhmmss)",
				sample: "140542"
			}
		]
	},
	{
		group: "Camera & EXIF",
		tokens: [
			{
				insert: "{make}",
				label: "Camera make",
				sample: "NIKON"
			},
			{
				insert: "{model}",
				label: "Camera model",
				sample: "Z8"
			},
			{
				insert: "{lens}",
				label: "Lens",
				sample: "24-70mm"
			},
			{
				insert: "{iso}",
				label: "ISO",
				sample: "400"
			},
			{
				insert: "{fnum}",
				label: "Aperture",
				sample: "f2.8"
			},
			{
				insert: "{shutter}",
				label: "Shutter",
				sample: "1_250"
			},
			{
				insert: "{focal}",
				label: "Focal length",
				sample: "35mm"
			}
		]
	}
];
/** Every recognised bare token id (without args), for validation. */
const KNOWN_TOKENS = /* @__PURE__ */ new Set([
	"name",
	"seq",
	"letter",
	"folder",
	"ext",
	"yyyy",
	"yy",
	"mon",
	"day",
	"hour",
	"min",
	"sec",
	"date",
	"time",
	"make",
	"model",
	"lens",
	"iso",
	"fnum",
	"shutter",
	"focal"
]);
/** Characters no mainstream filesystem accepts. Replaced with "_" inside a
*  resolved token value so e.g. a "1/250" shutter is safe. Legal-but-cosmetic
*  chars (space, hyphen, dot) are deliberately preserved so a user's literal
*  separators survive; core's rename also strips any stray "/" or "\". */
const ILLEGAL = /[<>:"/\\|?*]/g;
function sanitizeValue(v) {
	return v.replace(ILLEGAL, "_").trim();
}
function splitExt(filename) {
	const i = filename.lastIndexOf(".");
	return i > 0 ? {
		base: filename.slice(0, i),
		ext: filename.slice(i + 1)
	} : {
		base: filename,
		ext: ""
	};
}
function pad(n, width) {
	const s = Math.trunc(Math.abs(n)).toString();
	return (n < 0 ? "-" : "") + (s.length >= width ? s : "0".repeat(width - s.length) + s);
}
/** Spreadsheet-style base-26 lettering: 0→a, 25→z, 26→aa, 27→ab … */
function seqLetter(index) {
	let n = Math.max(0, Math.trunc(index));
	let out = "";
	do {
		out = String.fromCharCode(97 + n % 26) + out;
		n = Math.floor(n / 26) - 1;
	} while (n >= 0);
	return out;
}
/** Capture moment for date tokens: EXIF DateTimeOriginal, else the catalog's
*  dateCreated. Returns null when neither is usable (date tokens → ""). */
function captureDate(photo) {
	const raw = photo.exif.dateTimeOriginal;
	if (raw) {
		const m = raw.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
		if (m) {
			const [, y, mo, d, h, mi, s] = m;
			const dt = new Date(+y, +mo - 1, +d, +h, +mi, +s);
			if (!Number.isNaN(dt.getTime())) return dt;
		}
	}
	if (photo.dateCreated) {
		const dt = new Date(photo.dateCreated);
		if (!Number.isNaN(dt.getTime())) return dt;
	}
	return null;
}
/** Resolve one token (already split into name + optional arg). Returns the raw
*  (un-sanitized) replacement, or null for an unknown token. */
function resolveToken(name, arg, ctx) {
	const { photo, index, opts } = ctx;
	const exif = photo.exif;
	const date = captureDate(photo);
	const two = (n) => pad(n, 2);
	switch (name) {
		case "name": return splitExt(photo.filename).base;
		case "ext": return splitExt(photo.filename).ext;
		case "folder": return photo.directoryHandle?.name || (photo.folder ? photo.folder.split("/").pop() ?? "" : "");
		case "seq": {
			const width = arg && /^\d+$/.test(arg) ? +arg : opts.seqPad;
			return pad(opts.seqStart + index * opts.seqStep, width);
		}
		case "letter": return seqLetter(index);
		case "LETTER": return seqLetter(index).toUpperCase();
		case "yyyy": return date ? String(date.getFullYear()) : "";
		case "yy": return date ? two(date.getFullYear() % 100) : "";
		case "mon": return date ? two(date.getMonth() + 1) : "";
		case "day": return date ? two(date.getDate()) : "";
		case "hour": return date ? two(date.getHours()) : "";
		case "min": return date ? two(date.getMinutes()) : "";
		case "sec": return date ? two(date.getSeconds()) : "";
		case "date": return date ? `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}` : "";
		case "time": return date ? `${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}` : "";
		case "make": return exif.cameraMake ?? "";
		case "model": return exif.cameraModel ?? "";
		case "lens": return exif.lens ?? "";
		case "iso": return exif.iso != null ? String(exif.iso) : "";
		case "fnum": return exif.aperture != null ? `f${exif.aperture}` : "";
		case "shutter": return exif.shutterSpeed ?? "";
		case "focal": return exif.focalLength != null ? `${exif.focalLength}mm` : "";
		default: return null;
	}
}
const TOKEN_RE = /\{([A-Za-z]+)(?::([^}]*))?\}/g;
/** Render a template for one photo into a sanitized base name (no extension).
*  `letter`/`LETTER` are case-sensitive; all other token names are matched
*  case-insensitively. Unknown tokens resolve to "" (and are surfaced by
*  collectUnknownTokens for a warning). */
function renderTemplate(photo, index, opts) {
	const ctx = {
		photo,
		index,
		opts
	};
	let base = sanitizeValue(opts.template.replace(TOKEN_RE, (_all, rawName, arg) => {
		const val = resolveToken(rawName === "LETTER" ? "LETTER" : rawName === "letter" ? "letter" : rawName.toLowerCase(), arg, ctx);
		return val == null ? "" : sanitizeValue(val);
	})).replace(/[ _-]{2,}/g, (m) => m[0]).replace(/^[-_. ]+|[-_. ]+$/g, "");
	if (opts.caseMode === "lower") base = base.toLowerCase();
	else if (opts.caseMode === "upper") base = base.toUpperCase();
	return base;
}
/** Token ids present in the template that aren't recognised — for a live
*  "unknown token" hint. `letter`/`LETTER` both fold to the known "letter". */
function collectUnknownTokens(template) {
	const seen = /* @__PURE__ */ new Set();
	for (const m of template.matchAll(TOKEN_RE)) {
		const id = m[1].toLowerCase();
		if (!KNOWN_TOKENS.has(id)) seen.add(m[1]);
	}
	return [...seen];
}
/** Build a rename plan for `targets` (already in the intended order). Detects
*  in-batch duplicate names and whether a temp pass is required to dodge
*  target↔target name swaps. Virtual copies are marked skipped — they share the
*  master's file, so core refuses to rename them. */
function planRename(targets, opts) {
	const items = targets.map((photo, i) => {
		const ext = splitExt(photo.filename).ext;
		const newBase = renderTemplate(photo, i, opts);
		const newName = ext ? `${newBase}.${ext}` : newBase;
		const item = {
			id: photo.id,
			oldName: photo.filename,
			newName,
			newBase,
			unchanged: newName === photo.filename
		};
		if (photo.copyOf) item.skip = "Virtual copy (rename the original)";
		else if (!newBase) item.skip = "Template produced an empty name";
		return item;
	});
	const folderById = new Map(targets.map((p) => [p.id, p.folder]));
	const nameCount = /* @__PURE__ */ new Map();
	for (const it of items) {
		if (it.skip || it.unchanged) continue;
		const key = `${folderById.get(it.id) ?? ""}/${it.newName.toLowerCase()}`;
		nameCount.set(key, (nameCount.get(key) ?? 0) + 1);
	}
	const duplicates = items.filter((it) => !it.skip && !it.unchanged && (nameCount.get(`${folderById.get(it.id) ?? ""}/${it.newName.toLowerCase()}`) ?? 0) > 1).map((it) => it.newName);
	const currentByFolder = /* @__PURE__ */ new Map();
	for (const p of targets) {
		const set = currentByFolder.get(p.folder) ?? /* @__PURE__ */ new Set();
		set.add(p.filename.toLowerCase());
		currentByFolder.set(p.folder, set);
	}
	const needsTempPass = items.some((it) => {
		if (it.skip || it.unchanged) return false;
		const folder = folderById.get(it.id) ?? "";
		const current = currentByFolder.get(folder);
		return !!current && current.has(it.newName.toLowerCase()) && it.newName.toLowerCase() !== it.oldName.toLowerCase();
	});
	return {
		items,
		duplicates: [...new Set(duplicates)],
		needsTempPass,
		unknownTokens: collectUnknownTokens(opts.template)
	};
}

//#endregion
//#region src/rename/apply.ts
async function rename(id, base) {
	const r = await api.catalog.renamePhoto(id, base);
	return r.ok ? { ok: true } : {
		ok: false,
		reason: r.reason
	};
}
async function applyRename(plan, onProgress) {
	const active = plan.items.filter((it) => !it.skip && !it.unchanged);
	const outcome = {
		renamed: 0,
		skipped: plan.items.filter((it) => it.skip).map((it) => ({
			name: it.oldName,
			reason: it.skip
		})),
		failed: []
	};
	const total = active.length;
	let done = 0;
	const report = (current) => onProgress?.({
		done,
		total,
		current
	});
	const nonce = Date.now().toString(36);
	if (plan.needsTempPass) {
		const staged = /* @__PURE__ */ new Set();
		for (let i = 0; i < active.length; i++) {
			const it = active[i];
			const r = await rename(it.id, `__aet_${nonce}_${i}`);
			if (r.ok) staged.add(it.id);
			else outcome.failed.push({
				name: it.oldName,
				reason: r.reason ?? "Rename failed."
			});
		}
		for (const it of active) {
			if (!staged.has(it.id)) continue;
			report(it.newName);
			const r = await rename(it.id, it.newBase);
			if (r.ok) outcome.renamed++;
			else {
				const origBase = it.oldName.replace(/\.[^.]+$/, "");
				await rename(it.id, origBase);
				outcome.failed.push({
					name: it.oldName,
					reason: r.reason ?? "Rename failed."
				});
			}
			done++;
		}
	} else for (const it of active) {
		report(it.newName);
		const r = await rename(it.id, it.newBase);
		if (r.ok) outcome.renamed++;
		else outcome.failed.push({
			name: it.oldName,
			reason: r.reason ?? "Rename failed."
		});
		done++;
	}
	report("");
	return outcome;
}

//#endregion
//#region src/rename/RenameTab.tsx
const BUILTIN_PRESETS = [
	{
		name: "Original name",
		opts: {
			...DEFAULT_OPTIONS,
			template: "{name}"
		}
	},
	{
		name: "Name + number",
		opts: {
			...DEFAULT_OPTIONS,
			template: "{name}_{seq}"
		}
	},
	{
		name: "Date + number",
		opts: {
			...DEFAULT_OPTIONS,
			template: "{date}_{seq}"
		}
	},
	{
		name: "Year-month + number",
		opts: {
			...DEFAULT_OPTIONS,
			template: "{yyyy}-{mon}_{seq}"
		}
	},
	{
		name: "Camera + number",
		opts: {
			...DEFAULT_OPTIONS,
			template: "{model}_{seq}"
		}
	}
];
const OPTS_KEY = "rename.options";
const PRESETS_KEY = "rename.presets";
const PREVIEW_LIMIT = 8;
function RenameTab() {
	const { Button, TextInput, NumberInput, SegmentedControl, Select, Section, Field, Row, Stack, ProgressBar, tokens } = ui;
	const targets = useSelectedPhotos();
	const [opts, setOpts] = React.useState(() => api.settings.get(OPTS_KEY, DEFAULT_OPTIONS));
	const [userPresets, setUserPresets] = React.useState(() => api.settings.get(PRESETS_KEY, []));
	const [applying, setApplying] = React.useState(false);
	const [prog, setProg] = React.useState(null);
	const [summary, setSummary] = React.useState(null);
	const [presetName, setPresetName] = React.useState("");
	const set = (patch) => {
		setOpts((prev) => {
			const next = {
				...prev,
				...patch
			};
			api.settings.set(OPTS_KEY, next);
			return next;
		});
		setSummary(null);
	};
	const plan = React.useMemo(() => planRename(targets, opts), [targets, opts]);
	const active = plan.items.filter((it) => !it.skip && !it.unchanged);
	const skipped = plan.items.filter((it) => it.skip);
	const canApply = targets.length > 0 && active.length > 0 && plan.duplicates.length === 0 && !applying;
	const insertToken = (t) => set({ template: opts.template + t });
	const savePreset = () => {
		const name = presetName.trim();
		if (!name) return;
		const next = [...userPresets.filter((p) => p.name !== name), {
			name,
			opts
		}];
		setUserPresets(next);
		api.settings.set(PRESETS_KEY, next);
	};
	const deletePreset = () => {
		const name = presetName.trim();
		const next = userPresets.filter((p) => p.name !== name);
		setUserPresets(next);
		api.settings.set(PRESETS_KEY, next);
		setPresetName("");
	};
	const applyPreset = (name) => {
		const p = [...BUILTIN_PRESETS, ...userPresets].find((x) => x.name === name);
		if (p) {
			set({ ...p.opts });
			setPresetName(name);
		}
	};
	const savedMatch = userPresets.some((p) => p.name === presetName.trim());
	const run = async () => {
		setApplying(true);
		setSummary(null);
		try {
			setSummary(await applyRename(plan, (p) => setProg({
				done: p.done,
				total: p.total
			})));
		} finally {
			setApplying(false);
			setProg(null);
		}
	};
	return /* @__PURE__ */ React.createElement(Stack, { gap: 12 }, /* @__PURE__ */ React.createElement(Section, { title: "Template" }, /* @__PURE__ */ React.createElement(Stack, { gap: 8 }, /* @__PURE__ */ React.createElement(TextInput, {
		value: opts.template,
		onChange: (v) => set({ template: v }),
		style: { fontFamily: tokens.fontMono },
		placeholder: "{name}_{seq}"
	}), /* @__PURE__ */ React.createElement(Hint, null, "Click to add a token. Anything else is kept as typed."), TOKEN_GROUPS.map((g) => /* @__PURE__ */ React.createElement("div", { key: g.group }, /* @__PURE__ */ React.createElement("div", { style: {
		color: tokens.textMuted,
		fontSize: 10,
		textTransform: "uppercase",
		letterSpacing: .4,
		marginBottom: 4
	} }, g.group), /* @__PURE__ */ React.createElement(Row, {
		gap: 4,
		wrap: true
	}, g.tokens.map((t) => /* @__PURE__ */ React.createElement("button", {
		key: t.insert,
		onClick: () => insertToken(t.insert),
		title: `${t.label} — e.g. ${t.sample}`,
		style: {
			font: "inherit",
			fontSize: 11,
			fontFamily: tokens.fontMono,
			padding: "2px 6px",
			borderRadius: 4,
			border: `1px solid ${tokens.border}`,
			background: tokens.surface2,
			color: tokens.textSecondary,
			cursor: "pointer"
		}
	}, t.insert))))))), /* @__PURE__ */ React.createElement(Section, { title: "Numbering" }, /* @__PURE__ */ React.createElement(Row, {
		gap: 10,
		wrap: true
	}, /* @__PURE__ */ React.createElement(Field, { label: "Start" }, /* @__PURE__ */ React.createElement(NumberInput, {
		value: opts.seqStart,
		onChange: (v) => set({ seqStart: Math.trunc(v) }),
		min: 0,
		step: 1,
		width: 64
	})), /* @__PURE__ */ React.createElement(Field, { label: "Step" }, /* @__PURE__ */ React.createElement(NumberInput, {
		value: opts.seqStep,
		onChange: (v) => set({ seqStep: Math.trunc(v) || 1 }),
		min: 1,
		step: 1,
		width: 64
	})), /* @__PURE__ */ React.createElement(Field, { label: "Digits" }, /* @__PURE__ */ React.createElement(NumberInput, {
		value: opts.seqPad,
		onChange: (v) => set({ seqPad: Math.max(1, Math.trunc(v)) }),
		min: 1,
		max: 8,
		step: 1,
		width: 64
	})), /* @__PURE__ */ React.createElement(Field, { label: "Case" }, /* @__PURE__ */ React.createElement(SegmentedControl, {
		value: opts.caseMode,
		onChange: (v) => set({ caseMode: v }),
		options: [
			{
				value: "asis",
				label: "Aa"
			},
			{
				value: "lower",
				label: "aa"
			},
			{
				value: "upper",
				label: "AA"
			}
		]
	})))), /* @__PURE__ */ React.createElement(Section, { title: "Presets" }, /* @__PURE__ */ React.createElement(Stack, { gap: 6 }, /* @__PURE__ */ React.createElement(Select, {
		value: "",
		onChange: applyPreset,
		placeholder: "Load a preset…",
		groups: [{
			title: "Built-in",
			items: BUILTIN_PRESETS.map((p) => ({
				value: p.name,
				label: p.name
			}))
		}, ...userPresets.length ? [{
			title: "Saved",
			items: userPresets.map((p) => ({
				value: p.name,
				label: p.name
			}))
		}] : []]
	}), /* @__PURE__ */ React.createElement(Row, { gap: 6 }, /* @__PURE__ */ React.createElement("div", { style: { flex: 1 } }, /* @__PURE__ */ React.createElement(TextInput, {
		value: presetName,
		onChange: setPresetName,
		placeholder: "Save current as…"
	})), /* @__PURE__ */ React.createElement(Button, {
		size: "sm",
		onClick: savePreset,
		disabled: !presetName.trim()
	}, savedMatch ? "Update" : "Save"), savedMatch && /* @__PURE__ */ React.createElement(Button, {
		size: "sm",
		variant: "danger",
		onClick: deletePreset
	}, "Delete")))), /* @__PURE__ */ React.createElement(Section, { title: `Preview (${active.length} to rename)` }, /* @__PURE__ */ React.createElement(Stack, { gap: 8 }, targets.length === 0 && /* @__PURE__ */ React.createElement(Hint, null, "Select one or more photos in the grid."), plan.unknownTokens.length > 0 && /* @__PURE__ */ React.createElement(Notice, { tone: "warn" }, "Unknown token", plan.unknownTokens.length > 1 ? "s" : "", ": ", plan.unknownTokens.map((t) => `{${t}}`).join(", "), " — resolved to nothing."), plan.duplicates.length > 0 && /* @__PURE__ */ React.createElement(Notice, { tone: "danger" }, "Template produces duplicate names (add ", "{seq}", " or ", "{letter}", "): ", plan.duplicates.slice(0, 3).join(", "), plan.duplicates.length > 3 ? "…" : ""), plan.needsTempPass && active.length > 0 && /* @__PURE__ */ React.createElement(Notice, { tone: "info" }, "Names overlap the current set — a safe two-pass rename will be used."), active.length > 0 && /* @__PURE__ */ React.createElement("div", { style: {
		fontFamily: tokens.fontMono,
		fontSize: 11,
		lineHeight: 1.7
	} }, active.slice(0, PREVIEW_LIMIT).map((it) => /* @__PURE__ */ React.createElement("div", {
		key: it.id,
		style: {
			display: "flex",
			gap: 6,
			alignItems: "center",
			whiteSpace: "nowrap",
			overflow: "hidden"
		}
	}, /* @__PURE__ */ React.createElement("span", { style: {
		color: tokens.textMuted,
		overflow: "hidden",
		textOverflow: "ellipsis"
	} }, it.oldName), /* @__PURE__ */ React.createElement("span", { style: { color: tokens.textMuted } }, "→"), /* @__PURE__ */ React.createElement("span", { style: {
		color: tokens.textPrimary,
		overflow: "hidden",
		textOverflow: "ellipsis"
	} }, it.newName))), active.length > PREVIEW_LIMIT && /* @__PURE__ */ React.createElement("div", { style: { color: tokens.textMuted } }, "…and ", active.length - PREVIEW_LIMIT, " more")), skipped.length > 0 && /* @__PURE__ */ React.createElement(Hint, null, skipped.length, " skipped: ", skipped.slice(0, 3).map((s) => `${s.oldName} (${s.skip})`).join("; "), skipped.length > 3 ? "…" : ""))), prog && /* @__PURE__ */ React.createElement(ProgressBar, { value: prog.total ? prog.done / prog.total : 0 }), summary && /* @__PURE__ */ React.createElement(Notice, { tone: summary.failed.length ? "warn" : "ok" }, "Renamed ", summary.renamed, summary.skipped.length ? `, skipped ${summary.skipped.length}` : "", summary.failed.length ? `, failed ${summary.failed.length}: ${summary.failed.slice(0, 2).map((f) => f.reason).join("; ")}` : "."), /* @__PURE__ */ React.createElement(Button, {
		variant: "primary",
		full: true,
		disabled: !canApply,
		onClick: run
	}, applying ? "Renaming…" : `Rename ${active.length || ""} file${active.length === 1 ? "" : "s"}`));
}

//#endregion
//#region src/metadata/model.ts
const pad2 = (n) => n < 10 ? "0" + n : String(n);
/** Format a Date as EXIF "YYYY:MM:DD HH:MM:SS" in local time. */
function formatExifDate(d) {
	return `${d.getFullYear()}:${pad2(d.getMonth() + 1)}:${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
/** Parse EXIF "YYYY:MM:DD HH:MM:SS" to a Date, or null. */
function parseExifDate(s) {
	if (!s) return null;
	const m = s.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
	if (!m) return null;
	const [, y, mo, d, h, mi, se] = m;
	const dt = new Date(+y, +mo - 1, +d, +h, +mi, +se);
	return Number.isNaN(dt.getTime()) ? null : dt;
}
/** Resolve the DateOp to a concrete "YYYY:MM:DD HH:MM:SS" for one photo, or
*  null when there's nothing to write (no-op, or a shift with no base time). */
function resolveDate(op, photo) {
	if (op.kind === "none") return null;
	if (op.kind === "set") return op.value || null;
	const base = parseExifDate(photo.exif.dateTimeOriginal);
	if (!base) return null;
	return formatExifDate(new Date(base.getTime() + op.seconds * 1e3));
}
/** Decimal degrees → [deg, min, sec] rationals + hemisphere ref char. */
function decimalToDms(value, positive, negative) {
	const ref = value < 0 ? negative : positive;
	const abs = Math.abs(value);
	const deg = Math.floor(abs);
	const minFloat = (abs - deg) * 60;
	const min = Math.floor(minFloat);
	const sec = (minFloat - min) * 60;
	return {
		ref,
		pairs: [
			[deg, 1],
			[min, 1],
			[Math.round(sec * 1e3), 1e3]
		]
	};
}
/** Current editable values for a photo, for prefill in the single-photo case. */
function currentMeta(photo) {
	const e = photo.exif;
	const meta = {
		artist: e.artist ?? "",
		copyright: e.copyright ?? "",
		description: e.imageDescription ?? "",
		keywords: photo.keywords ?? []
	};
	if (e.gpsLatitude != null) meta.gpsLat = e.gpsLatitude;
	if (e.gpsLongitude != null) meta.gpsLon = e.gpsLongitude;
	return meta;
}

//#endregion
//#region src/metadata/tiff.ts
const TYPE_SIZE = {
	1: 1,
	2: 1,
	3: 2,
	4: 4,
	5: 8,
	6: 1,
	7: 1,
	8: 2,
	9: 4,
	10: 8,
	11: 4,
	12: 8
};
const TAG_EXIF_IFD = 34665;
const TAG_GPS_IFD = 34853;
const TAG_INTEROP_IFD = 40965;
const TAG_STRIP_OFFSETS = 273;
const TAG_STRIP_BYTECOUNTS = 279;
const TAG_TILE_OFFSETS = 324;
const TAG_TILE_BYTECOUNTS = 325;
const TAG_JPEG_THUMB_OFFSET = 513;
const TAG_JPEG_THUMB_LENGTH = 514;
var Reader = class {
	view;
	base;
	little;
	constructor(view, base, little) {
		this.view = view;
		this.base = base;
		this.little = little;
	}
	u16(off) {
		return this.view.getUint16(this.base + off, this.little);
	}
	u32(off) {
		return this.view.getUint32(this.base + off, this.little);
	}
};
/** Parse a TIFF starting at `base` inside `buf`. Returns null if not a TIFF. */
function parseTiff(buf, base = 0) {
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	if (base + 8 > buf.byteLength) return null;
	const bomBE = view.getUint16(base, false);
	const little = bomBE === 18761;
	if (!little && bomBE !== 19789) return null;
	const r = new Reader(view, base, little);
	if (r.u16(2) !== 42) return null;
	const state = { complex: false };
	const ifd0 = readIfd(buf, r, r.u32(4), 0, state);
	if (!ifd0) return null;
	return {
		little,
		ifd0,
		complex: state.complex
	};
}
function readIfd(buf, r, ifdOffset, depth, state) {
	if (ifdOffset <= 0 || r.base + ifdOffset + 2 > buf.byteLength) return null;
	if (depth > 6) {
		state.complex = true;
		return null;
	}
	const count = r.u16(ifdOffset);
	const node = { tags: [] };
	let offsetTag;
	let byteCountsTag;
	for (let i = 0; i < count; i++) {
		const entryOff = ifdOffset + 2 + i * 12;
		if (r.base + entryOff + 12 > buf.byteLength) break;
		const tag = r.u16(entryOff);
		const type = r.u16(entryOff + 2);
		const cnt = r.u32(entryOff + 4);
		const size = (TYPE_SIZE[type] ?? 1) * cnt;
		const valueFieldOff = entryOff + 8;
		const dataOff = size <= 4 ? valueFieldOff : r.u32(valueFieldOff);
		const absData = r.base + dataOff;
		if (tag === TAG_EXIF_IFD || tag === TAG_GPS_IFD || tag === TAG_INTEROP_IFD) {
			const sub = readIfd(buf, r, r.u32(valueFieldOff), depth + 1, state);
			if (sub) if (tag === TAG_EXIF_IFD) node.exif = sub;
			else if (tag === TAG_GPS_IFD) node.gps = sub;
			else node.interop = sub;
			continue;
		}
		if (size > 4 && (absData < 0 || absData + size > buf.byteLength)) {
			state.complex = true;
			continue;
		}
		const t = {
			tag,
			type,
			count: cnt,
			bytes: buf.subarray(absData, absData + size)
		};
		node.tags.push(t);
		if (tag === TAG_STRIP_OFFSETS || tag === TAG_TILE_OFFSETS || tag === TAG_JPEG_THUMB_OFFSET) offsetTag = tag;
		else if (tag === TAG_STRIP_BYTECOUNTS || tag === TAG_TILE_BYTECOUNTS || tag === TAG_JPEG_THUMB_LENGTH) byteCountsTag = tag;
	}
	if (offsetTag !== void 0) {
		const offs = readIntTag(r, node, offsetTag);
		const counts = offsetTag === TAG_JPEG_THUMB_OFFSET ? readIntTag(r, node, TAG_JPEG_THUMB_LENGTH) : readIntTag(r, node, byteCountsTag ?? -1);
		if (!offs || !counts || offs.length !== counts.length) state.complex = true;
		else {
			const blocks = [];
			for (let i = 0; i < offs.length; i++) {
				const start = r.base + offs[i];
				const end = start + counts[i];
				if (start < 0 || end > buf.byteLength) {
					state.complex = true;
					break;
				}
				blocks.push(buf.subarray(start, end));
			}
			if (blocks.length === offs.length) {
				node.blocks = blocks;
				node.offsetTag = offsetTag;
				const ot = node.tags.find((x) => x.tag === offsetTag);
				if (ot) ot.bytes = void 0;
			}
		}
	}
	node.next = readIfd(buf, r, r.u32(ifdOffset + 2 + count * 12), depth + 1, state) ?? void 0;
	return node;
}
/** Decode an integer tag (BYTE/SHORT/LONG) already captured in `node.tags`. */
function readIntTag(r, node, tag) {
	const t = node.tags.find((x) => x.tag === tag);
	if (!t || !t.bytes) return null;
	const dv = new DataView(t.bytes.buffer, t.bytes.byteOffset, t.bytes.byteLength);
	const out = [];
	for (let i = 0; i < t.count; i++) if (t.type === 3) out.push(dv.getUint16(i * 2, r.little));
	else if (t.type === 4) out.push(dv.getUint32(i * 4, r.little));
	else if (t.type === 1) out.push(dv.getUint8(i));
	else return null;
	return out;
}
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8");
/** Read an ASCII/UTF-8 tag as a trimmed string, or undefined. */
function getAscii(node, tag) {
	const t = node?.tags.find((x) => x.tag === tag);
	if (!t || !t.bytes || t.type !== 2) return void 0;
	let end = t.bytes.length;
	while (end > 0 && t.bytes[end - 1] === 0) end--;
	return dec.decode(t.bytes.subarray(0, end)).trim() || void 0;
}
/** Set (or, with undefined/empty, remove) an ASCII tag. Written as UTF-8 + NUL;
*  mainstream readers (exiftool, Lightroom, Explorer) accept UTF-8 here. */
function setAscii(node, tag, value) {
	const idx = node.tags.findIndex((x) => x.tag === tag);
	if (!value) {
		if (idx >= 0) node.tags.splice(idx, 1);
		return;
	}
	const body = enc.encode(value);
	const bytes = new Uint8Array(body.length + 1);
	bytes.set(body, 0);
	const t = {
		tag,
		type: 2,
		count: bytes.length,
		bytes
	};
	if (idx >= 0) node.tags[idx] = t;
	else node.tags.push(t);
}
/** Ensure an Exif sub-IFD exists (for DateTimeOriginal etc.). */
function ensureExif(tiff) {
	if (!tiff.ifd0.exif) tiff.ifd0.exif = { tags: [] };
	return tiff.ifd0.exif;
}
/** Ensure a GPS sub-IFD exists. */
function ensureGps(tiff) {
	if (!tiff.ifd0.gps) tiff.ifd0.gps = { tags: [] };
	return tiff.ifd0.gps;
}
/** Set a RATIONAL/ SRATIONAL array (each value a [num, den] pair). */
function setRationals(node, tag, pairs, little, signed = false) {
	const bytes = new Uint8Array(pairs.length * 8);
	const dv = new DataView(bytes.buffer);
	pairs.forEach(([n, d], i) => {
		if (signed) {
			dv.setInt32(i * 8, n, little);
			dv.setInt32(i * 8 + 4, d, little);
		} else {
			dv.setUint32(i * 8, n, little);
			dv.setUint32(i * 8 + 4, d, little);
		}
	});
	const t = {
		tag,
		type: signed ? 10 : 5,
		count: pairs.length,
		bytes
	};
	const idx = node.tags.findIndex((x) => x.tag === tag);
	if (idx >= 0) node.tags[idx] = t;
	else node.tags.push(t);
}
const align2 = (n) => n & 1 ? n + 1 : n;
function plannedEntriesFor(node, little) {
	const entries = [];
	for (const t of node.tags) if (t.tag === node.offsetTag) entries.push({
		tag: t.tag,
		type: t.type,
		count: t.count,
		offsetKind: true
	});
	else if (t.bytes) entries.push({
		tag: t.tag,
		type: t.type,
		count: t.count,
		bytes: t.bytes
	});
	if (node.exif) entries.push({
		tag: TAG_EXIF_IFD,
		type: 4,
		count: 1,
		pointer: "exif"
	});
	if (node.gps) entries.push({
		tag: TAG_GPS_IFD,
		type: 4,
		count: 1,
		pointer: "gps"
	});
	if (node.interop) entries.push({
		tag: TAG_INTEROP_IFD,
		type: 4,
		count: 1,
		pointer: "interop"
	});
	entries.sort((a, b) => a.tag - b.tag);
	return entries;
}
/** Re-serialize `tiff` to a standalone TIFF byte buffer. */
function serializeTiff(tiff) {
	const little = tiff.little;
	const order = [];
	const walk = (n) => {
		order.push(n);
		if (n.exif) walk(n.exif);
		if (n.gps) walk(n.gps);
		if (n.interop) walk(n.interop);
		if (n.next) walk(n.next);
	};
	walk(tiff.ifd0);
	const planned = [];
	let cursor = 8;
	for (const node of order) {
		const entries = plannedEntriesFor(node, little);
		const ifdOffset = cursor;
		const entriesSize = 2 + entries.length * 12 + 4;
		let dataSize = 0;
		for (const e of entries) {
			const len = e.offsetKind ? e.count * 4 : e.bytes ? e.bytes.length : 0;
			if (len > 4) dataSize += align2(len);
		}
		const dataOffset = ifdOffset + entriesSize;
		planned.push({
			node,
			entries,
			ifdOffset,
			dataOffset,
			dataSize
		});
		cursor = dataOffset + dataSize;
	}
	const blockOffsets = /* @__PURE__ */ new Map();
	for (const node of order) {
		if (!node.blocks) continue;
		const offs = [];
		for (const b of node.blocks) {
			offs.push(cursor);
			cursor = align2(cursor + b.length);
		}
		blockOffsets.set(node, offs);
	}
	const out = new Uint8Array(cursor);
	const dv = new DataView(out.buffer);
	const nodeToPlan = new Map(planned.map((p) => [p.node, p]));
	dv.setUint16(0, little ? 18761 : 19789, false);
	dv.setUint16(2, 42, little);
	dv.setUint32(4, tiff.ifd0 ? nodeToPlan.get(tiff.ifd0).ifdOffset : 0, little);
	for (let pi = 0; pi < planned.length; pi++) {
		const p = planned[pi];
		let dataPtr = p.dataOffset;
		dv.setUint16(p.ifdOffset, p.entries.length, little);
		p.entries.forEach((e, i) => {
			const entryOff = p.ifdOffset + 2 + i * 12;
			dv.setUint16(entryOff, e.tag, little);
			let type = e.type;
			let count = e.count;
			let valueBytes;
			if (e.pointer) {
				const child = e.pointer === "exif" ? p.node.exif : e.pointer === "gps" ? p.node.gps : p.node.interop;
				valueBytes = u32Bytes(child ? nodeToPlan.get(child).ifdOffset : 0, little);
				type = 4;
				count = 1;
			} else if (e.offsetKind) {
				const offs = blockOffsets.get(p.node) ?? [];
				type = 4;
				count = offs.length;
				const b = new Uint8Array(offs.length * 4);
				const bd = new DataView(b.buffer);
				offs.forEach((o, k) => bd.setUint32(k * 4, o, little));
				valueBytes = b;
			} else valueBytes = e.bytes ?? /* @__PURE__ */ new Uint8Array(0);
			dv.setUint16(entryOff + 2, type, little);
			dv.setUint32(entryOff + 4, count, little);
			if (valueBytes.length <= 4) out.set(valueBytes, entryOff + 8);
			else {
				dv.setUint32(entryOff + 8, dataPtr, little);
				out.set(valueBytes, dataPtr);
				dataPtr = align2(dataPtr + valueBytes.length);
			}
		});
		const nextOff = p.ifdOffset + 2 + p.entries.length * 12;
		const nextNode = p.node.next;
		dv.setUint32(nextOff, nextNode ? nodeToPlan.get(nextNode).ifdOffset : 0, little);
	}
	for (const node of order) {
		if (!node.blocks) continue;
		const offs = blockOffsets.get(node);
		node.blocks.forEach((b, i) => out.set(b, offs[i]));
	}
	return out;
}
function u32Bytes(n, little) {
	const b = /* @__PURE__ */ new Uint8Array(4);
	new DataView(b.buffer).setUint32(0, n >>> 0, little);
	return b;
}

//#endregion
//#region src/metadata/jpeg.ts
const EXIF_SIG = [
	69,
	120,
	105,
	102,
	0,
	0
];
function isExifApp1(buf, payloadStart) {
	if (payloadStart + EXIF_SIG.length > buf.length) return false;
	return EXIF_SIG.every((b, i) => buf[payloadStart + i] === b);
}
function parse(buf) {
	if (buf.length < 2 || buf[0] !== 255 || buf[1] !== 216) return null;
	const segments = [{
		marker: 216,
		raw: buf.subarray(0, 2),
		isExif: false
	}];
	let off = 2;
	while (off + 4 <= buf.length) {
		if (buf[off] !== 255) return null;
		const marker = buf[off + 1];
		if (marker === 218 || marker === 217) break;
		const len = buf[off + 2] << 8 | buf[off + 3];
		const end = off + 2 + len;
		if (end > buf.length) return null;
		const payloadStart = off + 4;
		segments.push({
			marker,
			raw: buf.subarray(off, end),
			isExif: marker === 225 && isExifApp1(buf, payloadStart)
		});
		off = end;
	}
	return {
		segments,
		rest: buf.subarray(off)
	};
}
/** The embedded Exif TIFF bytes (past "Exif\0\0"), or null if there's none. */
function getExifTiff(buf) {
	const parts = parse(buf);
	if (!parts) return null;
	const seg = parts.segments.find((s) => s.isExif);
	if (!seg) return null;
	return seg.raw.subarray(4 + EXIF_SIG.length);
}
const MAX_APP1 = 65535;
/** Rebuild `buf` with its Exif APP1 replaced (or inserted) carrying `tiff`.
*  Throws if the TIFF is too large for a single APP1 segment (caller falls back
*  to a sidecar) or if the JPEG can't be parsed. */
function writeExifIntoJpeg(buf, tiff) {
	const parts = parse(buf);
	if (!parts) throw new Error("Not a parseable JPEG.");
	const segLen = EXIF_SIG.length + tiff.length + 2;
	if (segLen > MAX_APP1) throw new Error("EXIF block exceeds the 64 KB JPEG segment limit.");
	const app1 = new Uint8Array(2 + segLen);
	app1[0] = 255;
	app1[1] = 225;
	app1[2] = segLen >> 8 & 255;
	app1[3] = segLen & 255;
	app1.set(EXIF_SIG, 4);
	app1.set(tiff, 4 + EXIF_SIG.length);
	const kept = parts.segments.filter((s) => !s.isExif);
	const chunks = [
		kept[0].raw,
		app1,
		...kept.slice(1).map((s) => s.raw),
		parts.rest
	];
	const total = chunks.reduce((n, c) => n + c.length, 0);
	const out = new Uint8Array(total);
	let p = 0;
	for (const c of chunks) {
		out.set(c, p);
		p += c.length;
	}
	return out;
}

//#endregion
//#region src/metadata/xmp.ts
const NS = {
	dc: "http://purl.org/dc/elements/1.1/",
	exif: "http://ns.adobe.com/exif/1.0/",
	xmp: "http://ns.adobe.com/xap/1.0/"
};
function esc(s) {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function unesc(s) {
	return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
/** EXIF "YYYY:MM:DD HH:MM:SS" → XMP ISO "YYYY-MM-DDTHH:MM:SS". */
function exifDateToIso(s) {
	const m = s.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}:\d{2}:\d{2})/);
	return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}` : s;
}
/** Decimal degrees → XMP "DDD,MM.mmmmH" form. */
function decimalToXmp(value, positive, negative) {
	const ref = value < 0 ? negative : positive;
	const abs = Math.abs(value);
	const deg = Math.floor(abs);
	return `${deg},${((abs - deg) * 60).toFixed(4)}${ref}`;
}
/** Element serializations for each managed property that has a value. A key set
*  to null means "explicitly clear" (remove the property, write nothing). */
function managedElements(fields) {
	const { meta, date } = fields;
	const out = [];
	if (meta.artist !== void 0) out.push({
		tag: "dc:creator",
		xml: meta.artist ? `<dc:creator><rdf:Seq><rdf:li>${esc(meta.artist)}</rdf:li></rdf:Seq></dc:creator>` : null
	});
	if (meta.copyright !== void 0) out.push({
		tag: "dc:rights",
		xml: meta.copyright ? `<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">${esc(meta.copyright)}</rdf:li></rdf:Alt></dc:rights>` : null
	});
	if (meta.description !== void 0) out.push({
		tag: "dc:description",
		xml: meta.description ? `<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${esc(meta.description)}</rdf:li></rdf:Alt></dc:description>` : null
	});
	if (meta.keywords !== void 0) out.push({
		tag: "dc:subject",
		xml: meta.keywords.length ? `<dc:subject><rdf:Bag>${meta.keywords.map((k) => `<rdf:li>${esc(k)}</rdf:li>`).join("")}</rdf:Bag></dc:subject>` : null
	});
	if (date) out.push({
		tag: "exif:DateTimeOriginal",
		xml: `<exif:DateTimeOriginal>${esc(exifDateToIso(date))}</exif:DateTimeOriginal>`
	});
	if (meta.gpsLat !== void 0 && meta.gpsLon !== void 0) {
		out.push({
			tag: "exif:GPSLatitude",
			xml: `<exif:GPSLatitude>${decimalToXmp(meta.gpsLat, "N", "S")}</exif:GPSLatitude>`
		});
		out.push({
			tag: "exif:GPSLongitude",
			xml: `<exif:GPSLongitude>${decimalToXmp(meta.gpsLon, "E", "W")}</exif:GPSLongitude>`
		});
	}
	return out;
}
function freshPacket(inner) {
	return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Advanced EXIF Tools">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="${NS.dc}"\n    xmlns:exif="${NS.exif}"\n    xmlns:xmp="${NS.xmp}">\n   ${inner}\n  </rdf:Description>\n </rdf:RDF>\n</x:xmpmeta>\n<?xpacket end="w"?>`;
}
/** Produce updated XMP text carrying `fields`, preserving foreign properties in
*  an existing packet. */
function upsertXmp(existing, fields) {
	const managed = managedElements(fields);
	const additions = managed.filter((m) => m.xml).map((m) => m.xml);
	if (!existing || !/<rdf:Description[\s>]/.test(existing)) return freshPacket(additions.join("\n   "));
	let text = existing;
	for (const m of managed) {
		const re = new RegExp(`\\s*<${m.tag}[\\s\\S]*?<\\/${m.tag}>`, "g");
		text = text.replace(re, "");
		text = text.replace(new RegExp(`\\s*<${m.tag}\\b[^>]*/>`, "g"), "");
		text = text.replace(new RegExp(`\\s+${m.tag}="[^"]*"`, "g"), "");
	}
	text = text.replace(/<rdf:Description\b([^>]*)>/, (_full, attrs) => {
		let a = attrs;
		if (!/xmlns:dc=/.test(a)) a += ` xmlns:dc="${NS.dc}"`;
		if (!/xmlns:exif=/.test(a) && additions.some((x) => x.includes("exif:"))) a += ` xmlns:exif="${NS.exif}"`;
		return `<rdf:Description${a}>`;
	});
	const insertion = additions.length ? `   ${additions.join("\n   ")}\n  ` : "";
	return text.replace(/<\/rdf:Description>/, `${insertion}</rdf:Description>`);
}
function firstAltOrSeq(xmp, tag) {
	const block = new RegExp(`<${tag}[\\s\\S]*?>([\\s\\S]*?)</${tag}>`).exec(xmp);
	if (block) {
		const li = /<rdf:li(?:\s[^>]*)?>([\s\S]*?)<\/rdf:li>/.exec(block[1]);
		if (li) return unesc(li[1].trim());
	}
	const attr = new RegExp(`\\s${tag}="([^"]*)"`).exec(xmp);
	return attr ? unesc(attr[1].trim()) : void 0;
}
function bagItems(xmp, tag) {
	const block = new RegExp(`<${tag}[\\s\\S]*?>([\\s\\S]*?)</${tag}>`).exec(xmp);
	if (!block) return [];
	const items = [];
	const re = /<rdf:li(?:\s[^>]*)?>([\s\S]*?)<\/rdf:li>/g;
	let m;
	while (m = re.exec(block[1])) {
		const v = unesc(m[1].trim());
		if (v) items.push(v);
	}
	return items;
}
/** Parse the fields we manage out of an XMP sidecar's text. */
function readXmp(text) {
	const meta = {};
	const creator = firstAltOrSeq(text, "dc:creator");
	if (creator) meta.artist = creator;
	const rights = firstAltOrSeq(text, "dc:rights");
	if (rights) meta.copyright = rights;
	const desc = firstAltOrSeq(text, "dc:description");
	if (desc) meta.description = desc;
	const kws = bagItems(text, "dc:subject");
	if (kws.length) meta.keywords = kws;
	const out = { meta };
	const iso = /<exif:DateTimeOriginal>([\s\S]*?)<\/exif:DateTimeOriginal>/.exec(text) ?? new RegExp(`\\sexif:DateTimeOriginal="([^"]*)"`).exec(text);
	if (iso) {
		const v = unesc(iso[1].trim());
		const m = v.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})/);
		out.date = m ? `${m[1]}:${m[2]}:${m[3]} ${m[4]}` : v;
	}
	return out;
}

//#endregion
//#region src/metadata/apply.ts
const IFD0_DESC = 270;
const IFD0_ARTIST = 315;
const IFD0_COPYRIGHT = 33432;
const IFD0_DATETIME = 306;
const EXIF_DTO = 36867;
const EXIF_DTD = 36868;
const GPS_LATREF = 1;
const GPS_LAT = 2;
const GPS_LONREF = 3;
const GPS_LON = 4;
function extOf(filename) {
	const i = filename.lastIndexOf(".");
	return i >= 0 ? filename.slice(i + 1).toLowerCase() : "";
}
function hasAnyEdit(edits, dateStr) {
	return dateStr != null || edits.artist !== void 0 || edits.copyright !== void 0 || edits.description !== void 0 || edits.keywords !== void 0 || edits.gpsLat !== void 0 && edits.gpsLon !== void 0;
}
/** Mutate a parsed TIFF with the requested edits (excluding keywords, which
*  have no native EXIF tag and ride along in the catalog / sidecar). */
function applyEditsToTiff(tiff, edits, dateStr) {
	if (edits.artist !== void 0) setAscii(tiff.ifd0, IFD0_ARTIST, edits.artist || void 0);
	if (edits.copyright !== void 0) setAscii(tiff.ifd0, IFD0_COPYRIGHT, edits.copyright || void 0);
	if (edits.description !== void 0) setAscii(tiff.ifd0, IFD0_DESC, edits.description || void 0);
	if (dateStr) {
		setAscii(tiff.ifd0, IFD0_DATETIME, dateStr);
		const exif = ensureExif(tiff);
		setAscii(exif, EXIF_DTO, dateStr);
		setAscii(exif, EXIF_DTD, dateStr);
	}
	if (edits.gpsLat !== void 0 && edits.gpsLon !== void 0) {
		const gps = ensureGps(tiff);
		const lat = decimalToDms(edits.gpsLat, "N", "S");
		const lon = decimalToDms(edits.gpsLon, "E", "W");
		setAscii(gps, GPS_LATREF, lat.ref);
		setRationals(gps, GPS_LAT, lat.pairs, tiff.little);
		setAscii(gps, GPS_LONREF, lon.ref);
		setRationals(gps, GPS_LON, lon.pairs, tiff.little);
	}
}
/** Confirm the edited string/date tags read back from freshly serialized bytes. */
function verifyTags(tiffBytes, edits, dateStr) {
	const t = parseTiff(tiffBytes, 0);
	if (!t) return false;
	const check = (node, tag, want) => !want || getAscii(node, tag) === want;
	if (edits.artist && !check(t.ifd0, IFD0_ARTIST, edits.artist)) return false;
	if (edits.copyright && !check(t.ifd0, IFD0_COPYRIGHT, edits.copyright)) return false;
	if (edits.description && !check(t.ifd0, IFD0_DESC, edits.description)) return false;
	if (dateStr && getAscii(t.ifd0.exif, EXIF_DTO) !== dateStr) return false;
	return true;
}
/** Deep-compare the external data blocks (strips/tiles/thumbnail) of two IFD
*  trees, in the same walk order the serializer used. */
function blocksIntact(a, b) {
	const collect = (n, out) => {
		if (n.blocks) out.push(...n.blocks);
		if (n.exif) collect(n.exif, out);
		if (n.gps) collect(n.gps, out);
		if (n.interop) collect(n.interop, out);
		if (n.next) collect(n.next, out);
	};
	const ba = [];
	const bb = [];
	collect(a, ba);
	collect(b, bb);
	if (ba.length !== bb.length) return false;
	for (let i = 0; i < ba.length; i++) {
		if (ba[i].length !== bb[i].length) return false;
		for (let j = 0; j < ba[i].length; j++) if (ba[i][j] !== bb[i][j]) return false;
	}
	return true;
}
/** In-place JPEG EXIF. Throws (→ sidecar fallback) if it can't be done safely. */
function editJpeg(buf, edits, dateStr) {
	const existing = getExifTiff(buf);
	const tiff = existing ? parseTiff(existing, 0) ?? {
		little: true,
		ifd0: { tags: [] },
		complex: false
	} : {
		little: true,
		ifd0: { tags: [] },
		complex: false
	};
	applyEditsToTiff(tiff, edits, dateStr);
	const out = serializeTiff(tiff);
	if (!verifyTags(out, edits, dateStr)) throw new Error("EXIF verification failed.");
	return writeExifIntoJpeg(buf, out);
}
/** In-place TIFF EXIF. Throws (→ sidecar fallback) for complex layouts or if the
*  round-trip validation (tags + untouched pixel blocks) doesn't hold. */
function editTiff(buf, edits, dateStr) {
	const tiff = parseTiff(buf, 0);
	if (!tiff) throw new Error("Not a parseable TIFF.");
	if (tiff.complex) throw new Error("TIFF layout too complex to rewrite in place.");
	applyEditsToTiff(tiff, edits, dateStr);
	const out = serializeTiff(tiff);
	const reparsed = parseTiff(out, 0);
	if (!reparsed || reparsed.complex) throw new Error("Rewritten TIFF failed to re-parse.");
	if (!blocksIntact(tiff.ifd0, reparsed.ifd0)) throw new Error("Pixel data check failed.");
	if (!verifyTags(out, edits, dateStr)) throw new Error("EXIF verification failed.");
	return out;
}
async function writeBytes(handle, data) {
	const w = await handle.createWritable();
	await w.write(data);
	await w.close();
}
async function writeSidecar(photo, edits, dateStr) {
	const dir = photo.directoryHandle;
	if (!dir) throw new Error("No folder handle for this photo.");
	const name = `${photo.filename}.xmp`;
	let existing = null;
	try {
		existing = await (await (await dir.getFileHandle(name)).getFile()).text();
	} catch {
		existing = null;
	}
	const text = upsertXmp(existing, {
		meta: edits,
		date: dateStr ?? void 0
	});
	await writeBytes(await dir.getFileHandle(name, { create: true }), new TextEncoder().encode(text));
}
/** Reflect the edits into the catalog record so the grid/info update this
*  session and survive a reload of catalog.json. */
async function updateCatalog(photo, edits, dateStr) {
	const exif = { ...photo.exif };
	if (edits.artist !== void 0) exif.artist = edits.artist || void 0;
	if (edits.copyright !== void 0) exif.copyright = edits.copyright || void 0;
	if (edits.description !== void 0) exif.imageDescription = edits.description || void 0;
	if (dateStr) exif.dateTimeOriginal = dateStr;
	if (edits.gpsLat !== void 0 && edits.gpsLon !== void 0) {
		exif.gpsLatitude = edits.gpsLat;
		exif.gpsLongitude = edits.gpsLon;
	}
	const updated = {
		...photo,
		exif
	};
	if (edits.keywords !== void 0) updated.keywords = [...edits.keywords];
	await api.stores.useCatalogStore.getState().relocatePhotos([updated]);
}
/** Apply `edits` + `dateOp` to each photo, returning a per-photo result. */
async function applyMetadata(targets, edits, dateOp, onProgress) {
	const results = [];
	let done = 0;
	for (const photo of targets) {
		onProgress?.({
			done,
			total: targets.length,
			current: photo.filename
		});
		const dateStr = resolveDate(dateOp, photo);
		if (!hasAnyEdit(edits, dateStr)) {
			results.push({
				id: photo.id,
				name: photo.filename,
				ok: true,
				mode: "in-place",
				reason: "No change"
			});
			done++;
			continue;
		}
		if (!photo.fileHandle && !photo.directoryHandle) {
			results.push({
				id: photo.id,
				name: photo.filename,
				ok: false,
				mode: "sidecar",
				reason: "No file handle"
			});
			done++;
			continue;
		}
		const ext = extOf(photo.filename);
		const inPlace = ext === "jpg" || ext === "jpeg" || ext === "tif" || ext === "tiff";
		let mode = inPlace ? "in-place" : "sidecar";
		let reason;
		try {
			if (inPlace && photo.fileHandle) {
				const buf = new Uint8Array(await (await photo.fileHandle.getFile()).arrayBuffer());
				let out;
				try {
					out = ext === "jpg" || ext === "jpeg" ? editJpeg(buf, edits, dateStr) : editTiff(buf, edits, dateStr);
					await writeBytes(photo.fileHandle, out);
				} catch (e) {
					mode = "sidecar";
					reason = e instanceof Error ? `In-place unavailable: ${e.message} — wrote sidecar` : "Wrote sidecar";
					await writeSidecar(photo, edits, dateStr);
				}
			} else await writeSidecar(photo, edits, dateStr);
			await updateCatalog(photo, edits, dateStr);
			results.push({
				id: photo.id,
				name: photo.filename,
				ok: true,
				mode,
				reason
			});
		} catch (e) {
			results.push({
				id: photo.id,
				name: photo.filename,
				ok: false,
				mode,
				reason: e instanceof Error ? e.message : "Write failed"
			});
		}
		done++;
	}
	onProgress?.({
		done,
		total: targets.length,
		current: ""
	});
	return results;
}
/** onPhotoImport handler: fold any XMP sidecar we wrote back onto the record so
*  the app shows those edits after a rescan. */
async function readSidecarForImport(ctx) {
	try {
		const data = readXmp(await (await (await ctx.dir.getFileHandle(`${ctx.fileName}.xmp`)).getFile()).text());
		const exif = { ...ctx.photo.exif };
		if (data.meta.artist) exif.artist = data.meta.artist;
		if (data.meta.copyright) exif.copyright = data.meta.copyright;
		if (data.meta.description) exif.imageDescription = data.meta.description;
		if (data.date) exif.dateTimeOriginal = data.date;
		const patch = { exif };
		if (data.meta.keywords?.length) patch.keywords = [.../* @__PURE__ */ new Set([...ctx.photo.keywords ?? [], ...data.meta.keywords])];
		return patch;
	} catch {
		return;
	}
}

//#endregion
//#region src/metadata/exif-read.ts
/** Locate the TIFF header a format's EXIF lives in: byte 0 for TIFF/RAW-TIFF,
*  or just past "Exif\0\0" in a JPEG APP1. Returns -1 when there's no EXIF. */
function findExifBase(buf) {
	if (buf.length < 4) return -1;
	const head = buf[0] << 8 | buf[1];
	if (head === 18761 || head === 19789) return 0;
	if (head !== 65496) return -1;
	let off = 2;
	while (off + 4 <= buf.length) {
		if (buf[off] !== 255) break;
		const marker = buf[off + 1];
		if (marker === 218 || marker === 217) break;
		const len = buf[off + 2] << 8 | buf[off + 3];
		if (marker === 225 && off + 10 <= buf.length) {
			const sig = off + 4;
			if (buf[sig] === 69 && buf[sig + 1] === 120 && buf[sig + 2] === 105 && buf[sig + 3] === 102 && buf[sig + 4] === 0 && buf[sig + 5] === 0) return sig + 6;
		}
		off += 2 + len;
	}
	return -1;
}
const TYPE_NAME = {
	1: "BYTE",
	2: "ASCII",
	3: "SHORT",
	4: "LONG",
	5: "RATIONAL",
	6: "SBYTE",
	7: "UNDEFINED",
	8: "SSHORT",
	9: "SLONG",
	10: "SRATIONAL",
	11: "FLOAT",
	12: "DOUBLE"
};
const BASE_TAGS = {
	256: "ImageWidth",
	257: "ImageLength",
	258: "BitsPerSample",
	259: "Compression",
	262: "PhotometricInterpretation",
	270: "ImageDescription",
	271: "Make",
	272: "Model",
	273: "StripOffsets",
	274: "Orientation",
	277: "SamplesPerPixel",
	278: "RowsPerStrip",
	279: "StripByteCounts",
	282: "XResolution",
	283: "YResolution",
	296: "ResolutionUnit",
	305: "Software",
	306: "DateTime",
	315: "Artist",
	318: "WhitePoint",
	319: "PrimaryChromaticities",
	513: "ThumbnailOffset",
	514: "ThumbnailLength",
	529: "YCbCrCoefficients",
	531: "YCbCrPositioning",
	532: "ReferenceBlackWhite",
	33432: "Copyright",
	34665: "ExifIFD",
	34853: "GPSIFD",
	40965: "InteropIFD",
	50341: "PrintIM"
};
const EXIF_TAGS = {
	33434: "ExposureTime",
	33437: "FNumber",
	34850: "ExposureProgram",
	34855: "ISO",
	34864: "SensitivityType",
	34866: "RecommendedExposureIndex",
	36864: "ExifVersion",
	36867: "DateTimeOriginal",
	36868: "DateTimeDigitized",
	36880: "OffsetTime",
	36881: "OffsetTimeOriginal",
	37121: "ComponentsConfiguration",
	37377: "ShutterSpeedValue",
	37378: "ApertureValue",
	37380: "ExposureBias",
	37381: "MaxApertureValue",
	37382: "SubjectDistance",
	37383: "MeteringMode",
	37384: "LightSource",
	37385: "Flash",
	37386: "FocalLength",
	37500: "MakerNote",
	37510: "UserComment",
	40960: "FlashpixVersion",
	40961: "ColorSpace",
	40962: "PixelXDimension",
	40963: "PixelYDimension",
	40965: "InteropIFD",
	41986: "ExposureMode",
	41987: "WhiteBalance",
	41988: "DigitalZoomRatio",
	41989: "FocalLengthIn35mm",
	41990: "SceneCaptureType",
	41992: "Contrast",
	41993: "Saturation",
	41994: "Sharpness",
	42016: "ImageUniqueID",
	42033: "BodySerialNumber",
	42034: "LensInfo",
	42035: "LensMake",
	42036: "LensModel",
	42037: "LensSerialNumber"
};
const GPS_TAGS = {
	0: "GPSVersionID",
	1: "GPSLatitudeRef",
	2: "GPSLatitude",
	3: "GPSLongitudeRef",
	4: "GPSLongitude",
	5: "GPSAltitudeRef",
	6: "GPSAltitude",
	7: "GPSTimeStamp",
	18: "GPSMapDatum",
	29: "GPSDateStamp"
};
const INTEROP_TAGS = {
	1: "InteroperabilityIndex",
	2: "InteroperabilityVersion"
};
function nameFor(ifd, tag) {
	return (ifd === "Exif" ? EXIF_TAGS : ifd === "GPS" ? GPS_TAGS : ifd === "Interop" ? INTEROP_TAGS : BASE_TAGS)[tag] ?? `Tag 0x${tag.toString(16).padStart(4, "0")}`;
}
function formatValue(t, little) {
	const b = t.bytes;
	if (!b) return t.tag === 273 || t.tag === 513 ? "(image data)" : "";
	const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
	const cap = 16;
	switch (t.type) {
		case 2: {
			let end = b.length;
			while (end > 0 && b[end - 1] === 0) end--;
			return new TextDecoder("utf-8").decode(b.subarray(0, end)).trim();
		}
		case 1:
		case 7: {
			const n = Math.min(t.count, 64);
			return Array.from(b.subarray(0, n), (x) => x.toString(16).padStart(2, "0")).join(" ") + (t.count > n ? " …" : "");
		}
		case 3:
		case 8: {
			const n = Math.min(t.count, cap);
			const out = [];
			for (let i = 0; i < n; i++) out.push(t.type === 8 ? dv.getInt16(i * 2, little) : dv.getUint16(i * 2, little));
			return out.join(", ") + (t.count > n ? " …" : "");
		}
		case 4:
		case 9: {
			const n = Math.min(t.count, cap);
			const out = [];
			for (let i = 0; i < n; i++) out.push(t.type === 9 ? dv.getInt32(i * 4, little) : dv.getUint32(i * 4, little));
			return out.join(", ") + (t.count > n ? " …" : "");
		}
		case 5:
		case 10: {
			const n = Math.min(t.count, cap);
			const out = [];
			for (let i = 0; i < n; i++) {
				const num = t.type === 10 ? dv.getInt32(i * 8, little) : dv.getUint32(i * 8, little);
				const den = t.type === 10 ? dv.getInt32(i * 8 + 4, little) : dv.getUint32(i * 8 + 4, little);
				out.push(den === 0 ? `${num}/0` : Number.isInteger(num / den) ? `${num / den}` : `${num}/${den}`);
			}
			return out.join(", ") + (t.count > n ? " …" : "");
		}
		default: return `(${TYPE_NAME[t.type] ?? t.type} ×${t.count})`;
	}
}
function dumpIfd(node, ifd, little, out) {
	if (!node) return;
	const rows = node.tags.map((t) => ({
		tag: t.tag,
		name: nameFor(ifd, t.tag),
		value: formatValue(t, little)
	})).sort((a, b) => a.tag - b.tag);
	for (const r of rows) out.push({
		ifd,
		tag: r.tag,
		name: r.name,
		value: r.value
	});
}
/** Decode every kept tag from `buf` into a grouped, human-readable list. */
function readAllTags(buf) {
	const base = findExifBase(buf);
	if (base < 0) return [];
	const tiff = parseTiff(buf, base);
	if (!tiff) return [];
	const out = [];
	dumpIfd(tiff.ifd0, "IFD0", tiff.little, out);
	dumpIfd(tiff.ifd0.exif, "Exif", tiff.little, out);
	dumpIfd(tiff.ifd0.gps, "GPS", tiff.little, out);
	dumpIfd(tiff.ifd0.interop, "Interop", tiff.little, out);
	dumpIfd(tiff.ifd0.next, "IFD1", tiff.little, out);
	return out;
}

//#endregion
//#region src/metadata/MetadataTab.tsx
function parseKeywords(s) {
	const seen = /* @__PURE__ */ new Set();
	for (const raw of s.split(/[,\n]/)) {
		const k = raw.trim();
		if (k) seen.add(k);
	}
	return [...seen];
}
/** Accept EXIF, ISO, or datetime-local forms → EXIF "YYYY:MM:DD HH:MM:SS". */
function toExifDate(s) {
	const m = s.match(/(\d{4})\D(\d{1,2})\D(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
	if (!m) return null;
	const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
	return Number.isNaN(d.getTime()) ? null : formatExifDate(d);
}
const READ_LIMIT = 1 << 20;
function MetadataTab() {
	const { Button, TextInput, TextArea, NumberInput, SegmentedControl, Section, Field, Row, Stack, ProgressBar, Toggle, tokens } = ui;
	const targets = useSelectedPhotos();
	const single = targets.length === 1;
	const firstId = targets[0]?.id;
	const [artist, setArtist] = React.useState("");
	const [copyright, setCopyright] = React.useState("");
	const [description, setDescription] = React.useState("");
	const [keywords, setKeywords] = React.useState("");
	const [touched, setTouched] = React.useState({});
	const [dateMode, setDateMode] = React.useState("none");
	const [dateSet, setDateSet] = React.useState("");
	const [shiftH, setShiftH] = React.useState(0);
	const [shiftM, setShiftM] = React.useState(0);
	const [gpsOn, setGpsOn] = React.useState(false);
	const [lat, setLat] = React.useState(0);
	const [lon, setLon] = React.useState(0);
	const [applying, setApplying] = React.useState(false);
	const [prog, setProg] = React.useState(null);
	const [results, setResults] = React.useState(null);
	const mark = (k) => setTouched((t) => t[k] ? t : {
		...t,
		[k]: true
	});
	React.useEffect(() => {
		setTouched({});
		setResults(null);
		setDateMode("none");
		setGpsOn(false);
		const p = targets[0];
		if (single && p) {
			const m = currentMeta(p);
			setArtist(m.artist ?? "");
			setCopyright(m.copyright ?? "");
			setDescription(m.description ?? "");
			setKeywords((m.keywords ?? []).join(", "));
			setDateSet(p.exif.dateTimeOriginal ?? "");
			setLat(m.gpsLat ?? 0);
			setLon(m.gpsLon ?? 0);
		} else {
			setArtist("");
			setCopyright("");
			setDescription("");
			setKeywords("");
			setDateSet("");
			setLat(0);
			setLon(0);
		}
	}, [firstId, targets.length]);
	const [dump, setDump] = React.useState(null);
	const [dumpErr, setDumpErr] = React.useState(null);
	React.useEffect(() => {
		let cancelled = false;
		setDump(null);
		setDumpErr(null);
		const p = targets[0];
		if (!p?.fileHandle) return;
		(async () => {
			try {
				const file = await p.fileHandle.getFile();
				const rows = readAllTags(new Uint8Array(await file.slice(0, READ_LIMIT).arrayBuffer()));
				if (!cancelled) setDump(rows);
			} catch (e) {
				if (!cancelled) setDumpErr(e instanceof Error ? e.message : "Could not read metadata");
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [firstId]);
	const buildEdits = () => {
		const edits = {};
		if (touched.artist) edits.artist = artist;
		if (touched.copyright) edits.copyright = copyright;
		if (touched.description) edits.description = description;
		if (touched.keywords) edits.keywords = parseKeywords(keywords);
		if (gpsOn) {
			edits.gpsLat = lat;
			edits.gpsLon = lon;
		}
		return edits;
	};
	const buildDateOp = () => {
		if (dateMode === "set") {
			const v = toExifDate(dateSet);
			return v ? {
				kind: "set",
				value: v
			} : { kind: "none" };
		}
		if (dateMode === "shift") return {
			kind: "shift",
			seconds: (shiftH * 60 + shiftM) * 60
		};
		return { kind: "none" };
	};
	const edits = buildEdits();
	const dateOp = buildDateOp();
	const nothing = Object.keys(edits).length === 0 && dateOp.kind === "none";
	const dateInvalid = dateMode === "set" && dateSet.trim() !== "" && toExifDate(dateSet) === null;
	const canApply = targets.length > 0 && !nothing && !dateInvalid && !applying;
	const run = async () => {
		setApplying(true);
		setResults(null);
		try {
			setResults(await applyMetadata(targets, buildEdits(), buildDateOp(), (p) => setProg({
				done: p.done,
				total: p.total
			})));
		} finally {
			setApplying(false);
			setProg(null);
		}
	};
	const inPlace = results?.filter((r) => r.ok && r.mode === "in-place").length ?? 0;
	const sidecar = results?.filter((r) => r.ok && r.mode === "sidecar").length ?? 0;
	const failed = results?.filter((r) => !r.ok) ?? [];
	return /* @__PURE__ */ React.createElement(Stack, { gap: 12 }, /* @__PURE__ */ React.createElement(Section, { title: targets.length > 1 ? `Edit metadata (${targets.length} photos)` : "Edit metadata" }, /* @__PURE__ */ React.createElement(Stack, { gap: 8 }, targets.length === 0 && /* @__PURE__ */ React.createElement(Hint, null, "Select one or more photos in the grid."), targets.length > 1 && /* @__PURE__ */ React.createElement(Hint, null, "Only the fields you change are written. Empty a field to clear it."), /* @__PURE__ */ React.createElement(Field, { label: "Creator" }, /* @__PURE__ */ React.createElement(TextInput, {
		value: artist,
		onChange: (v) => {
			setArtist(v);
			mark("artist");
		},
		placeholder: single ? "" : "(leave unchanged)"
	})), /* @__PURE__ */ React.createElement(Field, { label: "Copyright" }, /* @__PURE__ */ React.createElement(TextInput, {
		value: copyright,
		onChange: (v) => {
			setCopyright(v);
			mark("copyright");
		},
		placeholder: single ? "" : "(leave unchanged)"
	})), /* @__PURE__ */ React.createElement(Field, { label: "Caption / description" }, /* @__PURE__ */ React.createElement(TextArea, {
		value: description,
		onChange: (v) => {
			setDescription(v);
			mark("description");
		},
		rows: 2,
		placeholder: single ? "" : "(leave unchanged)"
	})), /* @__PURE__ */ React.createElement(Field, {
		label: "Keywords",
		hint: "Comma-separated"
	}, /* @__PURE__ */ React.createElement(TextArea, {
		value: keywords,
		onChange: (v) => {
			setKeywords(v);
			mark("keywords");
		},
		rows: 2,
		placeholder: single ? "sunset, coast" : "(leave unchanged)"
	})), /* @__PURE__ */ React.createElement(Field, { label: "Capture time" }, /* @__PURE__ */ React.createElement(Stack, { gap: 6 }, /* @__PURE__ */ React.createElement(SegmentedControl, {
		value: dateMode,
		onChange: (v) => setDateMode(v),
		options: [
			{
				value: "none",
				label: "Leave"
			},
			{
				value: "set",
				label: "Set"
			},
			{
				value: "shift",
				label: "Shift"
			}
		]
	}), dateMode === "set" && /* @__PURE__ */ React.createElement(TextInput, {
		value: dateSet,
		onChange: setDateSet,
		style: { fontFamily: tokens.fontMono },
		placeholder: "YYYY:MM:DD HH:MM:SS"
	}), dateMode === "set" && dateInvalid && /* @__PURE__ */ React.createElement(Notice, { tone: "danger" }, "Use the form YYYY:MM:DD HH:MM:SS."), dateMode === "shift" && /* @__PURE__ */ React.createElement(Row, { gap: 10 }, /* @__PURE__ */ React.createElement(Field, { label: "Hours" }, /* @__PURE__ */ React.createElement(NumberInput, {
		value: shiftH,
		onChange: setShiftH,
		min: -72,
		max: 72,
		step: 1,
		width: 64
	})), /* @__PURE__ */ React.createElement(Field, { label: "Minutes" }, /* @__PURE__ */ React.createElement(NumberInput, {
		value: shiftM,
		onChange: setShiftM,
		min: -59,
		max: 59,
		step: 1,
		width: 64
	}))))), /* @__PURE__ */ React.createElement(Field, { label: "GPS" }, /* @__PURE__ */ React.createElement(Stack, { gap: 6 }, /* @__PURE__ */ React.createElement(Toggle, {
		checked: gpsOn,
		onChange: setGpsOn,
		label: "Set coordinates"
	}), gpsOn && /* @__PURE__ */ React.createElement(Row, { gap: 10 }, /* @__PURE__ */ React.createElement(Field, { label: "Latitude" }, /* @__PURE__ */ React.createElement(NumberInput, {
		value: lat,
		onChange: setLat,
		min: -90,
		max: 90,
		step: 1e-4,
		width: 100
	})), /* @__PURE__ */ React.createElement(Field, { label: "Longitude" }, /* @__PURE__ */ React.createElement(NumberInput, {
		value: lon,
		onChange: setLon,
		min: -180,
		max: 180,
		step: 1e-4,
		width: 100
	}))))), prog && /* @__PURE__ */ React.createElement(ProgressBar, { value: prog.total ? prog.done / prog.total : 0 }), results && /* @__PURE__ */ React.createElement(Notice, { tone: failed.length ? "warn" : "ok" }, "Wrote ", inPlace, " in place", sidecar ? `, ${sidecar} to sidecar` : "", failed.length ? `, ${failed.length} failed: ${failed.slice(0, 2).map((f) => f.reason).join("; ")}` : ".", results.some((r) => r.mode === "sidecar" && r.reason?.startsWith("In-place")) && /* @__PURE__ */ React.createElement("div", { style: {
		marginTop: 4,
		color: tokens.textMuted
	} }, "Some files couldn't be edited in place and got an .xmp sidecar.")), /* @__PURE__ */ React.createElement(Button, {
		variant: "primary",
		full: true,
		disabled: !canApply,
		onClick: run
	}, applying ? "Writing…" : `Apply to ${targets.length || ""} photo${targets.length === 1 ? "" : "s"}`))), /* @__PURE__ */ React.createElement(Section, { title: single ? "Inspector" : "Inspector (first selected)" }, targets.length === 0 && /* @__PURE__ */ React.createElement(Hint, null, "Nothing selected."), targets.length > 0 && dumpErr && /* @__PURE__ */ React.createElement(Notice, { tone: "warn" }, dumpErr), targets.length > 0 && !dumpErr && dump === null && /* @__PURE__ */ React.createElement(Hint, null, "Reading…"), dump !== null && dump.length === 0 && /* @__PURE__ */ React.createElement(Hint, null, "No EXIF metadata found in this file."), dump !== null && dump.length > 0 && /* @__PURE__ */ React.createElement(TagDump, { rows: dump })));
}
function TagDump({ rows }) {
	const { tokens } = ui;
	const groups = React.useMemo(() => {
		const byIfd = /* @__PURE__ */ new Map();
		for (const r of rows) {
			const arr = byIfd.get(r.ifd) ?? [];
			arr.push(r);
			byIfd.set(r.ifd, arr);
		}
		return [...byIfd.entries()];
	}, [rows]);
	return /* @__PURE__ */ React.createElement("div", { style: {
		maxHeight: 260,
		overflow: "auto",
		border: `1px solid ${tokens.borderSubtle}`,
		borderRadius: 6
	} }, groups.map(([ifd, entries]) => /* @__PURE__ */ React.createElement("div", { key: ifd }, /* @__PURE__ */ React.createElement("div", { style: {
		position: "sticky",
		top: 0,
		background: tokens.surface2,
		color: tokens.textSecondary,
		fontSize: 10,
		textTransform: "uppercase",
		letterSpacing: .5,
		padding: "3px 8px",
		borderBottom: `1px solid ${tokens.borderSubtle}`
	} }, ifd), entries.map((e) => /* @__PURE__ */ React.createElement("div", {
		key: `${ifd}-${e.tag}`,
		style: {
			display: "flex",
			gap: 8,
			padding: "2px 8px",
			fontSize: 11,
			borderBottom: `1px solid ${tokens.surface1}`
		}
	}, /* @__PURE__ */ React.createElement("span", { style: {
		color: tokens.textMuted,
		minWidth: 130,
		flexShrink: 0
	} }, e.name), /* @__PURE__ */ React.createElement("span", { style: {
		color: tokens.textPrimary,
		fontFamily: tokens.fontMono,
		wordBreak: "break-word"
	} }, e.value))))));
}

//#endregion
//#region src/Panel.tsx
let pendingTab = null;
const listeners = /* @__PURE__ */ new Set();
/** Ask the panel to show a particular tab (used by the grid context menu). */
function requestTab(tab) {
	pendingTab = tab;
	listeners.forEach((l) => l());
}
function ToolsPanel() {
	const { SegmentedControl, Stack } = ui;
	const [tab, setTab] = React.useState("rename");
	React.useEffect(() => {
		const apply = () => {
			if (pendingTab) {
				setTab(pendingTab);
				pendingTab = null;
			}
		};
		listeners.add(apply);
		apply();
		return () => {
			listeners.delete(apply);
		};
	}, []);
	return /* @__PURE__ */ React.createElement("div", { style: { padding: 10 } }, /* @__PURE__ */ React.createElement(Stack, { gap: 10 }, /* @__PURE__ */ React.createElement(SegmentedControl, {
		value: tab,
		onChange: (v) => setTab(v),
		options: [{
			value: "rename",
			label: "Rename"
		}, {
			value: "metadata",
			label: "Metadata"
		}]
	}), tab === "rename" ? /* @__PURE__ */ React.createElement(RenameTab, null) : /* @__PURE__ */ React.createElement(MetadataTab, null)));
}

//#endregion
//#region src/index.tsx
const ID = "anthonyreimche.advanced-exif-tools";
const PANEL_ID = `${ID}.panel`;
function activate(api) {
	initRuntime(api);
	api.registerPanel({
		id: PANEL_ID,
		title: "EXIF Tools",
		component: ToolsPanel,
		defaultDock: {
			module: "library",
			direction: "right",
			order: 20,
			width: 300
		}
	});
	const open = (ids, tab) => {
		if (ids.length) api.stores.useCatalogStore.setState({
			selectedIds: new Set(ids),
			activePhotoId: ids[0]
		});
		requestTab(tab);
		api.dock.togglePanel(PANEL_ID);
	};
	api.registerGridMenuItem({
		id: `${ID}.rename`,
		label: (ids) => ids.length > 1 ? `Batch rename… (${ids.length})` : "Rename with template…",
		order: 10,
		onClick: (ids) => open(ids, "rename")
	});
	api.registerGridMenuItem({
		id: `${ID}.metadata`,
		label: (ids) => ids.length > 1 ? `Edit metadata… (${ids.length})` : "Edit metadata…",
		order: 11,
		onClick: (ids) => open(ids, "metadata")
	});
	api.registerCatalogHooks({
		id: `${ID}.sidecar`,
		onPhotoImport: (ctx) => readSidecarForImport(ctx)
	});
}

//#endregion
export { activate };