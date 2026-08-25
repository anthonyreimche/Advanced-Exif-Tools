// Rename engine — pure, API-free. Turns a filename template plus per-batch
// numbering options into concrete new base names, and plans a collision-safe
// application order. The actual on-disk rename runs through core's atomic
// api.catalog.renamePhoto (see apply.ts); this module never touches files.

import type { CatalogPhoto } from "../safelight-api";

export type CaseMode = "asis" | "lower" | "upper";

export interface RenameOptions {
  /** Template with {tokens}; literal text is kept verbatim. */
  template: string;
  /** First sequence number (for {seq}). */
  seqStart: number;
  /** Added per photo (for {seq}). */
  seqStep: number;
  /** Zero-pad width for {seq} when no inline {seq:N} width is given. */
  seqPad: number;
  /** Case transform applied to the whole assembled base name. */
  caseMode: CaseMode;
}

export const DEFAULT_OPTIONS: RenameOptions = {
  template: "{name}",
  seqStart: 1,
  seqStep: 1,
  seqPad: 3,
  caseMode: "asis",
};

/** Palette entries for the "insert token" UI. `insert` is the exact text
 *  dropped into the template; `sample` is shown as a hint. */
export interface TokenInfo {
  insert: string;
  label: string;
  sample: string;
}

export const TOKEN_GROUPS: { group: string; tokens: TokenInfo[] }[] = [
  {
    group: "Naming",
    tokens: [
      { insert: "{name}", label: "Original name", sample: "IMG_1234" },
      { insert: "{seq}", label: "Sequence number", sample: "001" },
      { insert: "{seq:4}", label: "Sequence (width 4)", sample: "0001" },
      { insert: "{letter}", label: "Sequence letter", sample: "a" },
      { insert: "{LETTER}", label: "Sequence letter (caps)", sample: "A" },
      { insert: "{folder}", label: "Folder name", sample: "Trip" },
      { insert: "{ext}", label: "Extension", sample: "nef" },
    ],
  },
  {
    group: "Capture date",
    tokens: [
      { insert: "{yyyy}", label: "Year (4)", sample: "2026" },
      { insert: "{yy}", label: "Year (2)", sample: "26" },
      { insert: "{mon}", label: "Month", sample: "06" },
      { insert: "{day}", label: "Day", sample: "30" },
      { insert: "{hour}", label: "Hour (24h)", sample: "14" },
      { insert: "{min}", label: "Minute", sample: "05" },
      { insert: "{sec}", label: "Second", sample: "42" },
      { insert: "{subsec}", label: "Subseconds (ms)", sample: "541" },
      { insert: "{date}", label: "Date (yyyymmdd)", sample: "20260630" },
      { insert: "{time}", label: "Time (hhmmss)", sample: "140542" },
    ],
  },
  {
    group: "Camera & EXIF",
    tokens: [
      { insert: "{make}", label: "Camera make", sample: "NIKON" },
      { insert: "{model}", label: "Camera model", sample: "Z8" },
      { insert: "{lens}", label: "Lens", sample: "24-70mm" },
      { insert: "{iso}", label: "ISO", sample: "400" },
      { insert: "{fnum}", label: "Aperture", sample: "f2.8" },
      { insert: "{shutter}", label: "Shutter", sample: "1_250" },
      { insert: "{focal}", label: "Focal length", sample: "35mm" },
    ],
  },
];

/** Every recognised bare token id (without args), for validation. */
const KNOWN_TOKENS = new Set<string>([
  "name", "seq", "letter", "folder", "ext",
  "yyyy", "yy", "mon", "day", "hour", "min", "sec", "subsec", "date", "time",
  "make", "model", "lens", "iso", "fnum", "shutter", "focal",
]);

// ── helpers ──────────────────────────────────────────────────────────────────

/** Characters no mainstream filesystem accepts. Replaced with "_" inside a
 *  resolved token value so e.g. a "1/250" shutter is safe. Legal-but-cosmetic
 *  chars (space, hyphen, dot) are deliberately preserved so a user's literal
 *  separators survive; core's rename also strips any stray "/" or "\". */
const ILLEGAL = /[<>:"/\\|?*]/g;

function sanitizeValue(v: string): string {
  return v.replace(ILLEGAL, "_").trim();
}

function splitExt(filename: string): { base: string; ext: string } {
  const i = filename.lastIndexOf(".");
  return i > 0
    ? { base: filename.slice(0, i), ext: filename.slice(i + 1) }
    : { base: filename, ext: "" };
}

function pad(n: number, width: number): string {
  const s = Math.trunc(Math.abs(n)).toString();
  const signed = n < 0 ? "-" : "";
  return signed + (s.length >= width ? s : "0".repeat(width - s.length) + s);
}

/** Spreadsheet-style base-26 lettering: 0→a, 25→z, 26→aa, 27→ab … */
function seqLetter(index: number): string {
  let n = Math.max(0, Math.trunc(index));
  let out = "";
  do {
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** Capture moment for date tokens: EXIF DateTimeOriginal, else the catalog's
 *  dateCreated. Returns null when neither is usable (date tokens → ""). */
function captureDate(photo: CatalogPhoto): Date | null {
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

// ── token resolution ─────────────────────────────────────────────────────────

interface Ctx {
  photo: CatalogPhoto;
  index: number;
  opts: RenameOptions;
  /** EXIF subsecond digit strings by photo id (see rename/subsec.ts). */
  subsec?: ReadonlyMap<string, string>;
}

/** Resolve one token (already split into name + optional arg). Returns the raw
 *  (un-sanitized) replacement, or null for an unknown token. */
function resolveToken(name: string, arg: string | undefined, ctx: Ctx): string | null {
  const { photo, index, opts } = ctx;
  const exif = photo.exif;
  const date = captureDate(photo);
  const two = (n: number) => pad(n, 2);

  switch (name) {
    case "name":
      return splitExt(photo.filename).base;
    case "ext":
      return splitExt(photo.filename).ext;
    case "folder":
      // The containing folder's own name. For a photo at the project root
      // photo.folder is "" — fall back to the directory handle, whose name is
      // the project folder itself, so top-level images still get a value.
      return photo.directoryHandle?.name || (photo.folder ? photo.folder.split("/").pop() ?? "" : "");
    case "seq": {
      const width = arg && /^\d+$/.test(arg) ? +arg : opts.seqPad;
      return pad(opts.seqStart + index * opts.seqStep, width);
    }
    case "letter":
      return seqLetter(index);
    case "LETTER":
      return seqLetter(index).toUpperCase();
    case "yyyy":
      return date ? String(date.getFullYear()) : "";
    case "yy":
      return date ? two(date.getFullYear() % 100) : "";
    case "mon":
      return date ? two(date.getMonth() + 1) : "";
    case "day":
      return date ? two(date.getDate()) : "";
    case "hour":
      return date ? two(date.getHours()) : "";
    case "min":
      return date ? two(date.getMinutes()) : "";
    case "sec":
      return date ? two(date.getSeconds()) : "";
    case "subsec": {
      // EXIF SubSecTime* is the decimal fraction as a digit string ("5" = .5s),
      // so a fixed width needs right-padding, not left: default 3 = milliseconds.
      const digits = (ctx.subsec?.get(photo.id) ?? "").replace(/\D/g, "");
      if (!digits) return "";
      const width = arg && /^\d+$/.test(arg) ? Math.max(1, +arg) : 3;
      return digits.slice(0, width).padEnd(width, "0");
    }
    case "date":
      return date
        ? `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}`
        : "";
    case "time":
      return date
        ? `${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`
        : "";
    case "make":
      return exif.cameraMake ?? "";
    case "model":
      return exif.cameraModel ?? "";
    case "lens":
      return exif.lens ?? "";
    case "iso":
      return exif.iso != null ? String(exif.iso) : "";
    case "fnum":
      return exif.aperture != null ? `f${exif.aperture}` : "";
    case "shutter":
      return exif.shutterSpeed ?? "";
    case "focal":
      return exif.focalLength != null ? `${exif.focalLength}mm` : "";
    default:
      return null;
  }
}

const TOKEN_RE = /\{([A-Za-z]+)(?::([^}]*))?\}/g;

/** Render a template for one photo into a sanitized base name (no extension).
 *  `letter`/`LETTER` are case-sensitive; all other token names are matched
 *  case-insensitively. Unknown tokens resolve to "" (and are surfaced by
 *  collectUnknownTokens for a warning). */
export function renderTemplate(
  photo: CatalogPhoto,
  index: number,
  opts: RenameOptions,
  subsecById?: ReadonlyMap<string, string>,
): string {
  const ctx: Ctx = { photo, index, opts, subsec: subsecById };
  const out = opts.template.replace(TOKEN_RE, (_all, rawName: string, arg?: string) => {
    const name = rawName === "LETTER" ? "LETTER" : rawName === "letter" ? "letter" : rawName.toLowerCase();
    const val = resolveToken(name, arg, ctx);
    return val == null ? "" : sanitizeValue(val);
  });
  // Sanitize the whole assembly too (literal text may carry illegal chars) and
  // collapse any runs of separators the empty tokens left behind.
  let base = sanitizeValue(out)
    .replace(/[ _-]{2,}/g, (m) => m[0]) // an empty token often leaves a doubled separator
    .replace(/^[-_. ]+|[-_. ]+$/g, ""); // no leading/trailing separators or dots
  if (opts.caseMode === "lower") base = base.toLowerCase();
  else if (opts.caseMode === "upper") base = base.toUpperCase();
  return base;
}

/** Whether the template resolves {subsec} — the tab only harvests EXIF
 *  subseconds from files when it does. */
export function templateUsesSubsec(template: string): boolean {
  for (const m of template.matchAll(TOKEN_RE)) {
    if (m[1].toLowerCase() === "subsec") return true;
  }
  return false;
}

/** Token ids present in the template that aren't recognised — for a live
 *  "unknown token" hint. `letter`/`LETTER` both fold to the known "letter". */
export function collectUnknownTokens(template: string): string[] {
  const seen = new Set<string>();
  for (const m of template.matchAll(TOKEN_RE)) {
    const id = m[1].toLowerCase();
    if (!KNOWN_TOKENS.has(id)) seen.add(m[1]);
  }
  return [...seen];
}

// ── planning ─────────────────────────────────────────────────────────────────

export interface PlanItem {
  id: string;
  oldName: string;
  newName: string;
  /** Base name (no extension) passed to core's renamePhoto. */
  newBase: string;
  /** True when the resolved name equals the current one (nothing to do). */
  unchanged: boolean;
  /** Non-empty when this item can't be renamed (skipped, with a reason). */
  skip?: string;
}

export interface RenamePlan {
  items: PlanItem[];
  /** New names that would collide with another item in the same batch. */
  duplicates: string[];
  /** True when a temporary two-pass rename is needed to reorder safely. */
  needsTempPass: boolean;
  unknownTokens: string[];
}

/** Build a rename plan for `targets` (already in the intended order). Detects
 *  in-batch duplicate names and whether a temp pass is required to dodge
 *  target↔target name swaps. Virtual copies are marked skipped — they share the
 *  master's file, so core refuses to rename them. */
export function planRename(
  targets: CatalogPhoto[],
  opts: RenameOptions,
  subsecById?: ReadonlyMap<string, string>,
): RenamePlan {
  const items: PlanItem[] = targets.map((photo, i) => {
    const ext = splitExt(photo.filename).ext;
    const newBase = renderTemplate(photo, i, opts, subsecById);
    const newName = ext ? `${newBase}.${ext}` : newBase;
    const item: PlanItem = {
      id: photo.id,
      oldName: photo.filename,
      newName,
      newBase,
      unchanged: newName === photo.filename,
    };
    if (photo.copyOf) item.skip = "Virtual copy (rename the original)";
    else if (!newBase) item.skip = "Template produced an empty name";
    return item;
  });

  // Duplicate detection: same target folder + same new filename. Group by
  // folder so identical names in different folders don't false-positive.
  const folderById = new Map(targets.map((p) => [p.id, p.folder] as const));
  const nameCount = new Map<string, number>();
  for (const it of items) {
    if (it.skip || it.unchanged) continue;
    const key = `${folderById.get(it.id) ?? ""}/${it.newName.toLowerCase()}`;
    nameCount.set(key, (nameCount.get(key) ?? 0) + 1);
  }
  const duplicates = items
    .filter((it) => !it.skip && !it.unchanged &&
      (nameCount.get(`${folderById.get(it.id) ?? ""}/${it.newName.toLowerCase()}`) ?? 0) > 1)
    .map((it) => it.newName);

  // Temp pass needed when any item's new name is the *current* name of a
  // different active item in the same folder (a swap/shift core would refuse).
  const currentByFolder = new Map<string, Set<string>>();
  for (const p of targets) {
    const set = currentByFolder.get(p.folder) ?? new Set<string>();
    set.add(p.filename.toLowerCase());
    currentByFolder.set(p.folder, set);
  }
  const needsTempPass = items.some((it) => {
    if (it.skip || it.unchanged) return false;
    const folder = folderById.get(it.id) ?? "";
    const current = currentByFolder.get(folder);
    return !!current && current.has(it.newName.toLowerCase()) &&
      it.newName.toLowerCase() !== it.oldName.toLowerCase();
  });

  return {
    items,
    duplicates: [...new Set(duplicates)],
    needsTempPass,
    unknownTokens: collectUnknownTokens(opts.template),
  };
}
