// EXIF subseconds for the {subsec} token. Core's catalog EXIF doesn't carry
// SubSecTime, so the value is read from the file itself with the shared TIFF
// parser and cached per photo for the session (capture subseconds never change
// once shot; our own metadata writers don't touch these tags).

import { parseTiff, getAscii } from "../metadata/tiff";
import { findExifBase } from "../metadata/exif-read";
import type { CatalogPhoto } from "../safelight-api";

const TAG_SUBSEC = 0x9290;
const TAG_SUBSEC_ORIGINAL = 0x9291;
const TAG_SUBSEC_DIGITIZED = 0x9292;

// EXIF IFDs sit near the file start in every TIFF-based RAW and JPEG; capping
// the read keeps a burst-sized batch from streaming whole RAW files.
const SCAN_BYTES = 1 << 20;

/** The subsecond digit string for the capture moment, preferring the tag that
 *  pairs with DateTimeOriginal (which the date tokens render). "" when the
 *  buffer has none — including truncated or non-EXIF bytes. */
export function extractSubsec(buf: Uint8Array): string {
  try {
    const base = findExifBase(buf);
    if (base < 0) return "";
    const exif = parseTiff(buf, base)?.ifd0.exif;
    if (!exif) return "";
    return (
      getAscii(exif, TAG_SUBSEC_ORIGINAL) ??
      getAscii(exif, TAG_SUBSEC_DIGITIZED) ??
      getAscii(exif, TAG_SUBSEC) ??
      ""
    );
  } catch {
    return ""; // a truncated SCAN_BYTES window can cut an IFD mid-structure
  }
}

const cache = new Map<string, string>();

/** Read-only view of everything harvested so far, keyed by photo id — pass it
 *  to planRename/renderTemplate. */
export function subsecMap(): ReadonlyMap<string, string> {
  return cache;
}

/** The photos still needing a harvest before their {subsec} can resolve.
 *  Virtual copies are excluded: the planner skips them anyway. */
export function missingSubsec(photos: CatalogPhoto[]): CatalogPhoto[] {
  return photos.filter((p) => !p.copyOf && !cache.has(p.id));
}

async function readSubsec(photo: CatalogPhoto): Promise<string> {
  try {
    const handle =
      photo.fileHandle ?? (await photo.directoryHandle?.getFileHandle(photo.filename));
    if (!handle) return "";
    const file = await handle.getFile();
    const head = new Uint8Array(await file.slice(0, SCAN_BYTES).arrayBuffer());
    return extractSubsec(head);
  } catch {
    return ""; // unreadable file → the token resolves to nothing, like no EXIF
  }
}

const HARVEST_CONCURRENCY = 8;

/** Fill the cache for `photos`. Files without subsecond EXIF cache "" so they
 *  are only ever read once. */
export async function harvestSubsec(photos: CatalogPhoto[]): Promise<void> {
  const queue = [...photos];
  const worker = async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      cache.set(p.id, await readSubsec(p));
    }
  };
  await Promise.all(Array.from({ length: HARVEST_CONCURRENCY }, worker));
}
