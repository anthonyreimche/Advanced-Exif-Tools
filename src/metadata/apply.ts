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
import { upsertXmp, readXmp } from "./xmp";

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
 *  have no native EXIF tag and ride along in the catalog / sidecar). */
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
  if (ba.length !== bb.length) return false;
  for (let i = 0; i < ba.length; i++) {
    if (ba[i].length !== bb[i].length) return false;
    for (let j = 0; j < ba[i].length; j++) if (ba[i][j] !== bb[i][j]) return false;
  }
  return true;
}

/** In-place JPEG EXIF. Throws (→ sidecar fallback) if it can't be done safely. */
function editJpeg(buf: Uint8Array, edits: EditableMeta, dateStr: string | null): Uint8Array {
  const existing = getExifTiff(buf);
  const tiff: Tiff = existing
    ? parseTiff(existing, 0) ?? { little: true, ifd0: { tags: [] }, complex: false }
    : { little: true, ifd0: { tags: [] }, complex: false };
  applyEditsToTiff(tiff, edits, dateStr);
  const out = serializeTiff(tiff);
  if (!verifyTags(out, edits, dateStr)) throw new Error("EXIF verification failed.");
  return writeExifIntoJpeg(buf, out);
}

/** In-place TIFF EXIF. Throws (→ sidecar fallback) for complex layouts or if the
 *  round-trip validation (tags + untouched pixel blocks) doesn't hold. */
function editTiff(buf: Uint8Array, edits: EditableMeta, dateStr: string | null): Uint8Array {
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

async function writeBytes(handle: FileSystemFileHandle, data: Uint8Array): Promise<void> {
  const w = await handle.createWritable();
  await w.write(data as BlobPart);
  await w.close();
}

async function writeSidecar(photo: CatalogPhoto, edits: EditableMeta, dateStr: string | null): Promise<void> {
  const dir = photo.directoryHandle;
  if (!dir) throw new Error("No folder handle for this photo.");
  const name = `${photo.filename}.xmp`;
  let existing: string | null = null;
  try {
    const fh = await dir.getFileHandle(name);
    existing = await (await fh.getFile()).text();
  } catch {
    existing = null; // no sidecar yet
  }
  const text = upsertXmp(existing, { meta: edits, date: dateStr ?? undefined });
  const fh = await dir.getFileHandle(name, { create: true });
  await writeBytes(fh, new TextEncoder().encode(text));
}

/** Reflect the edits into the catalog record so the grid/info update this
 *  session and survive a reload of catalog.json. */
async function updateCatalog(photo: CatalogPhoto, edits: EditableMeta, dateStr: string | null): Promise<void> {
  const exif = { ...photo.exif };
  if (edits.artist !== undefined) exif.artist = edits.artist || undefined;
  if (edits.copyright !== undefined) exif.copyright = edits.copyright || undefined;
  if (edits.description !== undefined) exif.imageDescription = edits.description || undefined;
  if (dateStr) exif.dateTimeOriginal = dateStr;
  if (edits.gpsLat !== undefined && edits.gpsLon !== undefined) {
    exif.gpsLatitude = edits.gpsLat;
    exif.gpsLongitude = edits.gpsLon;
  }
  const updated: CatalogPhoto = { ...photo, exif };
  if (edits.keywords !== undefined) updated.keywords = [...edits.keywords];
  await api.stores.useCatalogStore.getState().relocatePhotos([updated]);
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
  let done = 0;

  for (const photo of targets) {
    onProgress?.({ done, total: targets.length, current: photo.filename });
    const dateStr = resolveDate(dateOp, photo);

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
      await updateCatalog(photo, edits, dateStr);
      results.push({ id: photo.id, name: photo.filename, ok: true, mode, reason });
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
    const fh = await ctx.dir.getFileHandle(`${ctx.fileName}.xmp`);
    const text = await (await fh.getFile()).text();
    const data = readXmp(text);
    const exif = { ...ctx.photo.exif };
    if (data.meta.artist) exif.artist = data.meta.artist;
    if (data.meta.copyright) exif.copyright = data.meta.copyright;
    if (data.meta.description) exif.imageDescription = data.meta.description;
    if (data.date) exif.dateTimeOriginal = data.date;
    const patch: Partial<CatalogPhoto> = { exif };
    if (data.meta.keywords?.length) {
      const merged = new Set([...(ctx.photo.keywords ?? []), ...data.meta.keywords]);
      patch.keywords = [...merged];
    }
    return patch;
  } catch {
    return; // no sidecar / unreadable — nothing to merge
  }
}
