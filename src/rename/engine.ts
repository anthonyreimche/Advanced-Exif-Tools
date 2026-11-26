// Rename engine. Turns a filename template plus per-batch numbering options into
// concrete new base names (the tokens themselves are Safelight's shared naming
// seam, api.naming) and plans a collision-safe application order. The actual
// on-disk rename runs through core's atomic api.catalog.renamePhoto (see
// apply.ts); this module never touches files.

import { api } from "../rt";
import type { CatalogPhoto, NameOptions, NameSubject } from "../safelight";

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

const TOKEN_RE = /\{([A-Za-z]+)(?::([^}]*))?\}/g;

function splitExt(filename: string): { base: string; ext: string } {
  const i = filename.lastIndexOf(".");
  return i > 0
    ? { base: filename.slice(0, i), ext: filename.slice(i + 1) }
    : { base: filename, ext: "" };
}

/** What core's naming reads from a photo. `subsecById` holds the EXIF
 *  subsecond digits harvested from the files (see rename/subsec.ts); the
 *  catalogue's own value is the fallback. */
function subjectOf(photo: CatalogPhoto, subsecById?: ReadonlyMap<string, string>): NameSubject {
  const subsec = subsecById?.get(photo.id) || photo.exif.subSecTimeOriginal;
  return {
    filename: photo.filename,
    exif: subsec ? { ...photo.exif, subSecTimeOriginal: subsec } : photo.exif,
    dateCreated: photo.dateCreated,
    folderName: photo.directoryHandle?.name || (photo.folder ? photo.folder.split("/").pop() ?? "" : ""),
  };
}

function nameOptions(index: number, opts: RenameOptions): NameOptions {
  return {
    index,
    seqStart: opts.seqStart,
    seqStep: opts.seqStep,
    seqPad: opts.seqPad,
    caseMode: opts.caseMode,
  };
}

/** Render a template for one photo into a sanitized base name (no extension). */
export function renderTemplate(
  photo: CatalogPhoto,
  index: number,
  opts: RenameOptions,
  subsecById?: ReadonlyMap<string, string>,
): string {
  return api.naming.render(opts.template, subjectOf(photo, subsecById), nameOptions(index, opts));
}

/** Resolve the rename tokens in free text (a caption, a headline) for one photo
 *  of a batch. Values are not made filename-safe and an unknown {token} is kept
 *  as typed, so ordinary braces survive. */
export function expandTokens(text: string, photo: CatalogPhoto, index: number): string {
  return api.naming.expand(text, subjectOf(photo), { index });
}

/** Whether the template resolves {subsec} — the tab only harvests EXIF
 *  subseconds from files when it does. */
export function templateUsesSubsec(template: string): boolean {
  for (const m of template.matchAll(TOKEN_RE)) {
    if (m[1].toLowerCase() === "subsec") return true;
  }
  return false;
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
    unknownTokens: api.naming.unknownTokens(opts.template),
  };
}
