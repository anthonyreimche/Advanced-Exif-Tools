// The editable metadata model — the fields the editor exposes, plus the helpers
// that convert between the app's display forms and the EXIF/XMP wire forms.

import type { CatalogPhoto } from "../safelight-api";

/** Descriptive / rights / authorship fields. A present key means "write this";
 *  an empty string means "clear the tag". Absent keys are left untouched, so a
 *  batch edit only changes what the user actually filled in. */
export interface EditableMeta {
  artist?: string;
  copyright?: string;
  description?: string;
  keywords?: string[];
  /** Decimal degrees; write both or neither. */
  gpsLat?: number;
  gpsLon?: number;
}

/** How to change the capture time. "set" writes one absolute time to all;
 *  "shift" moves each photo's own time by a signed number of seconds (fixing a
 *  camera clock / timezone across a batch). */
export type DateOp =
  | { kind: "none" }
  | { kind: "set"; value: string } // "YYYY:MM:DD HH:MM:SS"
  | { kind: "shift"; seconds: number };

const pad2 = (n: number) => (n < 10 ? "0" + n : String(n));

/** Format a Date as EXIF "YYYY:MM:DD HH:MM:SS" in local time. */
export function formatExifDate(d: Date): string {
  return (
    `${d.getFullYear()}:${pad2(d.getMonth() + 1)}:${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

/** Parse EXIF "YYYY:MM:DD HH:MM:SS" to a Date, or null. */
export function parseExifDate(s: string | undefined): Date | null {
  if (!s) return null;
  const m = s.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  const dt = new Date(+y, +mo - 1, +d, +h, +mi, +se);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/** Resolve the DateOp to a concrete "YYYY:MM:DD HH:MM:SS" for one photo, or
 *  null when there's nothing to write (no-op, or a shift with no base time). */
export function resolveDate(op: DateOp, photo: CatalogPhoto): string | null {
  if (op.kind === "none") return null;
  if (op.kind === "set") return op.value || null;
  const base = parseExifDate(photo.exif.dateTimeOriginal);
  if (!base) return null;
  return formatExifDate(new Date(base.getTime() + op.seconds * 1000));
}

/** Decimal degrees → [deg, min, sec] rationals + hemisphere ref char. */
export function decimalToDms(
  value: number,
  positive: string,
  negative: string,
): { pairs: [number, number][]; ref: string } {
  const ref = value < 0 ? negative : positive;
  const abs = Math.abs(value);
  const deg = Math.floor(abs);
  const minFloat = (abs - deg) * 60;
  const min = Math.floor(minFloat);
  const sec = (minFloat - min) * 60;
  // Seconds kept to 1/1000" precision — plenty for photo geotags.
  return {
    ref,
    pairs: [
      [deg, 1],
      [min, 1],
      [Math.round(sec * 1000), 1000],
    ],
  };
}

/** Current editable values for a photo, for prefill in the single-photo case. */
export function currentMeta(photo: CatalogPhoto): EditableMeta {
  const e = photo.exif;
  const meta: EditableMeta = {
    artist: e.artist ?? "",
    copyright: e.copyright ?? "",
    description: e.imageDescription ?? "",
    keywords: photo.keywords ?? [],
  };
  if (e.gpsLatitude != null) meta.gpsLat = e.gpsLatitude;
  if (e.gpsLongitude != null) meta.gpsLon = e.gpsLongitude;
  return meta;
}
