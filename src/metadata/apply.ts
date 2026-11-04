// Metadata write dispatch. JPEG and TIFF are edited in place (native EXIF);
// everything else gets an XMP sidecar. Every in-place buffer is re-parsed and
// validated *before* it touches disk — for TIFF we also confirm the pixel/
// thumbnail blocks survived byte-for-byte — so a serializer edge case degrades
// to a safe sidecar rather than a damaged original.

import { api } from "../rt";
import type { CatalogPhoto } from "../safelight-api";
import { type EditableMeta, type DateOp, resolveDate, decimalToDms } from "./model";
import {
  parseTiff, serializeTiff, setAscii, getAscii, ensureExif, ensureGps, setRationals,
  type Tiff, type IfdNode,
} from "./tiff";
import { getExifTiff, writeExifIntoJpeg } from "./jpeg";
import { upsertXmp, readXmp, sidecarName, legacySidecarName, isOwnPacket } from "./xmp";

const IFD0_DESC = 0x010e;
const IFD0_ARTIST = 0x013b;
const IFD0_COPYRIGHT = 0x8298;
const IFD0_DATETIME = 0x0132;
const EXIF_DTO = 0x9003;
const EXIF_DTD = 0x9004;
const GPS_LATREF = 0x0001;
const GPS_LAT = 0x0002;
const GPS_LONREF = 0x0003;
const GPS_LON = 0x0004;
const EXIF_MAKERNOTE = 0x927c;

/** Catalogue records stored per relocatePhotos call. */
const CATALOG_BATCH = 200;

export type WriteMode = "in-place" | "sidecar";

export interface WriteResult {
  id: string;
  name: string;
  ok: boolean;
  mode: WriteMode;
  reason?: string;
}

function extOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i >= 0 ? filename.slice(i + 1).toLowerCase() : "";
}

function hasAnyEdit(edits: EditableMeta, dateStr: string | null): boolean {
  return (
    dateStr != null ||
    edits.artist !== undefined ||
    edits.copyright !== undefined ||
    edits.description !== undefined ||
    edits.keywords !== undefined ||
    (edits.gpsLat !== undefined && edits.gpsLon !== undefined)
  );
}

/** Mutate a parsed TIFF with the requested edits (excluding keywords, which
 *  have no native EXIF tag and ride along in the catalogue / sidecar). */
function applyEditsToTiff(tiff: Tiff, edits: EditableMeta, dateStr: string | null): void {
  if (edits.artist !== undefined) setAscii(tiff.ifd0, IFD0_ARTIST, edits.artist || undefined);
  if (edits.copyright !== undefined) setAscii(tiff.ifd0, IFD0_COPYRIGHT, edits.copyright || undefined);
  if (edits.description !== undefined) setAscii(tiff.ifd0, IFD0_DESC, edits.description || undefined);
  if (dateStr) {
    setAscii(tiff.ifd0, IFD0_DATETIME, dateStr);
    const exif = ensureExif(tiff);
    setAscii(exif, EXIF_DTO, dateStr);
    setAscii(exif, EXIF_DTD, dateStr);
  }
  if (edits.gpsLat !== undefined && edits.gpsLon !== undefined) {
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
function verifyTags(tiffBytes: Uint8Array, edits: EditableMeta, dateStr: string | null): boolean {
  const t = parseTiff(tiffBytes, 0);
  if (!t) return false;
  const check = (node: IfdNode | undefined, tag: number, want: string | undefined): boolean =>
    !want || getAscii(node, tag) === want;
  if (edits.artist && !check(t.ifd0, IFD0_ARTIST, edits.artist)) return false;
  if (edits.copyright && !check(t.ifd0, IFD0_COPYRIGHT, edits.copyright)) return false;
  if (edits.description && !check(t.ifd0, IFD0_DESC, edits.description)) return false;
  if (dateStr && getAscii(t.ifd0.exif, EXIF_DTO) !== dateStr) return false;
  return true;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Deep-compare the external data blocks (strips/tiles/thumbnail) of two IFD
 *  trees, in the same walk order the serializer used. */
function blocksIntact(a: IfdNode, b: IfdNode): boolean {
  const collect = (n: IfdNode, out: Uint8Array[]) => {
    if (n.blocks) out.push(...n.blocks);
    if (n.exif) collect(n.exif, out);
    if (n.gps) collect(n.gps, out);
    if (n.interop) collect(n.interop, out);
    if (n.next) collect(n.next, out);
  };
  const ba: Uint8Array[] = [];
  const bb: Uint8Array[] = [];
  collect(a, ba);
  collect(b, bb);
  return ba.length === bb.length && ba.every((block, i) => sameBytes(block, bb[i]));
}

/** Every tag id in an IFD tree, keyed by the IFD it sits in, as one string. */
function tagCensus(root: IfdNode): string {
  const ids: string[] = [];
  const walk = (n: IfdNode, path: string) => {
    for (const t of n.tags) ids.push(`${path}:${t.tag}`);
    if (n.exif) walk(n.exif, `${path}.exif`);
    if (n.gps) walk(n.gps, `${path}.gps`);
    if (n.interop) walk(n.interop, `${path}.interop`);
    if (n.next) walk(n.next, `${path}.next`);
  };
  walk(root, "ifd0");
  return ids.sort().join(",");
}

/** Apply the edits to a parsed, non-complex TIFF and re-serialize it, throwing
 *  (→ sidecar fallback) unless the rewrite re-parses, carries every tag across,
 *  keeps any maker note at its offset and reads the edits back. */
function rewriteChecked(tiff: Tiff, edits: EditableMeta, dateStr: string | null): { out: Uint8Array; reparsed: Tiff } {
  const makerNote = tiff.ifd0.exif?.tags.find((t) => t.tag === EXIF_MAKERNOTE && t.at !== undefined);
  applyEditsToTiff(tiff, edits, dateStr);
  const out = serializeTiff(tiff, makerNote);
  const reparsed = parseTiff(out, 0);
  if (!reparsed || reparsed.complex) throw new Error("Rewritten EXIF failed to re-parse.");
  if (tagCensus(reparsed.ifd0) !== tagCensus(tiff.ifd0)) throw new Error("Rewritten EXIF lost tags.");
  if (makerNote) {
    const kept = reparsed.ifd0.exif?.tags.find((t) => t.tag === EXIF_MAKERNOTE);
    const same = !!kept?.bytes && !!makerNote.bytes && kept.at === makerNote.at && sameBytes(kept.bytes, makerNote.bytes);
    if (!same) throw new Error("Maker note couldn't keep its position.");
  }
  if (!verifyTags(out, edits, dateStr)) throw new Error("EXIF verification failed.");
  return { out, reparsed };
}

/** In-place JPEG EXIF. Throws (→ sidecar fallback) if it can't be done safely,
 *  including when an EXIF block is present but can't be read in full. */
function editJpeg(buf: Uint8Array, edits: EditableMeta, dateStr: string | null): Uint8Array {
  const existing = getExifTiff(buf);
  const parsed = existing ? parseTiff(existing, 0) : null;
  if (existing && !parsed) throw new Error("Existing EXIF couldn't be read.");
  if (parsed?.complex) throw new Error("EXIF layout too complex to rewrite in place.");
  const tiff: Tiff = parsed ?? { little: true, ifd0: { tags: [] }, complex: false };
  return writeExifIntoJpeg(buf, rewriteChecked(tiff, edits, dateStr).out);
}

/** In-place TIFF EXIF. Throws (→ sidecar fallback) for complex layouts or if the
 *  round-trip validation (tags + untouched pixel blocks) doesn't hold. */
function editTiff(buf: Uint8Array, edits: EditableMeta, dateStr: string | null): Uint8Array {
  const tiff = parseTiff(buf, 0);
  if (!tiff) throw new Error("Not a parseable TIFF.");
  if (tiff.complex) throw new Error("TIFF layout too complex to rewrite in place.");
  const { out, reparsed } = rewriteChecked(tiff, edits, dateStr);
  if (!blocksIntact(tiff.ifd0, reparsed.ifd0)) throw new Error("Pixel data check failed.");
  return out;
}

async function writeBytes(handle: FileSystemFileHandle, data: Uint8Array): Promise<void> {
  const w = await handle.createWritable();
  await w.write(data as BlobPart);
  await w.close();
}

/** A missing file: the browser file API's NotFoundError, or ENOENT from the
 *  desktop bridge, which keeps the errno only in the message. */
function isNotFound(e: unknown): boolean {
  return e instanceof Error && (e.name === "NotFoundError" || /\bENOENT\b/.test(e.message));
}

/** The sidecar's text, or null when there is none. Any other read failure (a
 *  locked file, a dropped share) throws: writing a fresh packet over a sidecar
 *  we couldn't read would wipe another app's settings. On desktop a missing file
 *  only fails in getFile(), so both steps sit in the one try. */
async function sidecarText(dir: FileSystemDirectoryHandle, name: string): Promise<string | null> {
  try {
    const fh = await dir.getFileHandle(name);
    return await (await fh.getFile()).text();
  } catch (e) {
    if (isNotFound(e)) return null;
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(`Couldn't read the existing ${name}, so it was left as it is (${why})`);
  }
}

/** Write the sidecar under the Adobe naming shared with the XMP Tools
 *  extension (DSC.ARW → DSC.xmp), seeding from — and migrating away — the
 *  pre-1.2 `<filename>.xmp` name. The legacy file is deleted only when its
 *  packet is provably ours: darktable uses the same legacy naming, and its
 *  sidecars are not ours to remove. Exported for the node test harness. */
export async function writeSidecar(photo: CatalogPhoto, edits: EditableMeta, dateStr: string | null): Promise<void> {
  const dir = photo.directoryHandle;
  if (!dir) throw new Error("No folder handle for this photo.");
  const name = sidecarName(photo.filename);
  const legacyName = legacySidecarName(photo.filename);

  const existing = await sidecarText(dir, name);
  const legacy = name === legacyName ? null : await sidecarText(dir, legacyName);

  const text = upsertXmp(existing ?? legacy, { meta: edits, date: dateStr ?? undefined });
  const fh = await dir.getFileHandle(name, { create: true });
  await writeBytes(fh, new TextEncoder().encode(text));

  if (legacy !== null && isOwnPacket(legacy)) {
    try {
      await dir.removeEntry(legacyName);
    } catch {
      // Losing the cleanup is harmless; the new sidecar is already in place.
    }
  }
}

/** `current` with only the fields this tool edits changed on it. */
function withEdits(current: CatalogPhoto, edits: EditableMeta, dateStr: string | null): CatalogPhoto {
  const exif = { ...current.exif };
  if (edits.artist !== undefined) exif.artist = edits.artist || undefined;
  if (edits.copyright !== undefined) exif.copyright = edits.copyright || undefined;
  if (edits.description !== undefined) exif.imageDescription = edits.description || undefined;
  if (dateStr) exif.dateTimeOriginal = dateStr;
  if (edits.gpsLat !== undefined && edits.gpsLon !== undefined) {
    exif.gpsLatitude = edits.gpsLat;
    exif.gpsLongitude = edits.gpsLon;
  }
  const updated: CatalogPhoto = { ...current, exif };
  if (edits.keywords !== undefined) updated.keywords = [...edits.keywords];
  return updated;
}

interface Written {
  id: string;
  dateStr: string | null;
  result: WriteResult;
}

/** Reflect written edits into the catalogue so the grid/info update this session
 *  and survive a reload. Each record is rebuilt from the store as it is now, so
 *  a rating, flag or keyword changed while the files were written stays. */
async function updateCatalog(written: Written[], edits: EditableMeta): Promise<void> {
  if (written.length === 0) return;
  const store = api.stores.useCatalogStore.getState();
  const byId = new Map(written.map((w) => [w.id, w] as const));
  const updated: CatalogPhoto[] = [];
  for (const p of store.photos) {
    const w = byId.get(p.id);
    if (w) updated.push(withEdits(p, edits, w.dateStr));
  }
  try {
    await store.relocatePhotos(updated);
  } catch (e) {
    for (const w of written) {
      w.result.ok = false;
      w.result.reason = e instanceof Error ? e.message : "Catalogue update failed";
    }
  }
}

export interface ApplyProgress {
  done: number;
  total: number;
  current: string;
}

/** Apply `edits` + `dateOp` to each photo, returning a per-photo result. */
export async function applyMetadata(
  targets: CatalogPhoto[],
  edits: EditableMeta,
  dateOp: DateOp,
  onProgress?: (p: ApplyProgress) => void,
): Promise<WriteResult[]> {
  const results: WriteResult[] = [];
  let pending: Written[] = [];
  let done = 0;

  for (const photo of targets) {
    onProgress?.({ done, total: targets.length, current: photo.filename });
    const dateStr = resolveDate(dateOp, photo);

    if (photo.copyOf) {
      // A copy shares its master's file and sidecar; writing would change the master.
      results.push({ id: photo.id, name: photo.filename, ok: false, mode: "sidecar", reason: "Virtual copy (edit the original)" });
      done++;
      continue;
    }
    if (!hasAnyEdit(edits, dateStr)) {
      results.push({ id: photo.id, name: photo.filename, ok: true, mode: "in-place", reason: "No change" });
      done++;
      continue;
    }
    if (!photo.fileHandle && !photo.directoryHandle) {
      results.push({ id: photo.id, name: photo.filename, ok: false, mode: "sidecar", reason: "No file handle" });
      done++;
      continue;
    }

    const ext = extOf(photo.filename);
    const inPlace = ext === "jpg" || ext === "jpeg" || ext === "tif" || ext === "tiff";
    let mode: WriteMode = inPlace ? "in-place" : "sidecar";
    let reason: string | undefined;

    try {
      if (inPlace && photo.fileHandle) {
        const buf = new Uint8Array(await (await photo.fileHandle.getFile()).arrayBuffer());
        let out: Uint8Array;
        try {
          out = ext === "jpg" || ext === "jpeg" ? editJpeg(buf, edits, dateStr) : editTiff(buf, edits, dateStr);
          await writeBytes(photo.fileHandle, out);
        } catch (e) {
          // In-place refused (unsupported layout / verification) — degrade to a
          // sidecar so the edit is never lost and the original is never risked.
          mode = "sidecar";
          reason = e instanceof Error ? `In-place unavailable: ${e.message} — wrote sidecar` : "Wrote sidecar";
          await writeSidecar(photo, edits, dateStr);
        }
      } else {
        await writeSidecar(photo, edits, dateStr);
      }
      const result: WriteResult = { id: photo.id, name: photo.filename, ok: true, mode, reason };
      results.push(result);
      pending.push({ id: photo.id, dateStr, result });
      if (pending.length >= CATALOG_BATCH) {
        await updateCatalog(pending, edits);
        pending = [];
      }
    } catch (e) {
      results.push({
        id: photo.id,
        name: photo.filename,
        ok: false,
        mode,
        reason: e instanceof Error ? e.message : "Write failed",
      });
    }
    done++;
  }
  await updateCatalog(pending, edits);

  onProgress?.({ done, total: targets.length, current: "" });
  return results;
}

/** onPhotoImport handler: fold any XMP sidecar we wrote back onto the record so
 *  the app shows those edits after a rescan. */
export async function readSidecarForImport(ctx: {
  photo: CatalogPhoto;
  dir: FileSystemDirectoryHandle;
  fileName: string;
}): Promise<Partial<CatalogPhoto> | void> {
  try {
    const text =
      (await sidecarText(ctx.dir, sidecarName(ctx.fileName))) ??
      (await sidecarText(ctx.dir, legacySidecarName(ctx.fileName)));
    if (text === null) return; // no sidecar — nothing to merge
    const data = readXmp(text);
    const exif = { ...ctx.photo.exif };
    if (data.meta.artist) exif.artist = data.meta.artist;
    if (data.meta.copyright) exif.copyright = data.meta.copyright;
    if (data.meta.description) exif.imageDescription = data.meta.description;
    if (data.date) exif.dateTimeOriginal = data.date;
    if (data.meta.gpsLat !== undefined && data.meta.gpsLon !== undefined) {
      exif.gpsLatitude = data.meta.gpsLat;
      exif.gpsLongitude = data.meta.gpsLon;
    }
    const patch: Partial<CatalogPhoto> = { exif };
    if (data.meta.keywords?.length) {
      const merged = new Set([...(ctx.photo.keywords ?? []), ...data.meta.keywords]);
      patch.keywords = [...merged];
    }
    return patch;
  } catch {
    return; // unreadable sidecar — nothing to merge
  }
}
