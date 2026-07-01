// JPEG APP-segment surgery for in-place EXIF. We walk the marker segments up to
// the start-of-scan, swap the "Exif\0\0" APP1 payload for a freshly serialized
// TIFF, and leave every other segment (JFIF, XMP, ICC) and the entropy-coded
// image data untouched.

const EXIF_SIG = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"

interface Segment {
  marker: number; // second byte of the FFxx marker
  /** Full segment bytes including the FFxx marker and 2-byte length. */
  raw: Uint8Array;
  isExif: boolean;
}

interface JpegParts {
  segments: Segment[];
  /** Entropy-coded scan + trailing data, from the SOS marker to EOF. */
  rest: Uint8Array;
}

function isExifApp1(buf: Uint8Array, payloadStart: number): boolean {
  if (payloadStart + EXIF_SIG.length > buf.length) return false;
  return EXIF_SIG.every((b, i) => buf[payloadStart + i] === b);
}

function parse(buf: Uint8Array): JpegParts | null {
  if (buf.length < 2 || buf[0] !== 0xff || buf[1] !== 0xd8) return null; // SOI
  const segments: Segment[] = [{ marker: 0xd8, raw: buf.subarray(0, 2), isExif: false }];
  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) return null; // desync — refuse rather than guess
    const marker = buf[off + 1];
    if (marker === 0xda || marker === 0xd9) break; // SOS / EOI → rest starts here
    const len = (buf[off + 2] << 8) | buf[off + 3];
    const end = off + 2 + len;
    if (end > buf.length) return null;
    const payloadStart = off + 4;
    segments.push({
      marker,
      raw: buf.subarray(off, end),
      isExif: marker === 0xe1 && isExifApp1(buf, payloadStart),
    });
    off = end;
  }
  return { segments, rest: buf.subarray(off) };
}

/** The embedded Exif TIFF bytes (past "Exif\0\0"), or null if there's none. */
export function getExifTiff(buf: Uint8Array): Uint8Array | null {
  const parts = parse(buf);
  if (!parts) return null;
  const seg = parts.segments.find((s) => s.isExif);
  if (!seg) return null;
  // raw = FF E1 len_hi len_lo "Exif\0\0" <tiff…>
  return seg.raw.subarray(4 + EXIF_SIG.length);
}

const MAX_APP1 = 0xffff; // segment length field is 16-bit

/** Rebuild `buf` with its Exif APP1 replaced (or inserted) carrying `tiff`.
 *  Throws if the TIFF is too large for a single APP1 segment (caller falls back
 *  to a sidecar) or if the JPEG can't be parsed. */
export function writeExifIntoJpeg(buf: Uint8Array, tiff: Uint8Array): Uint8Array {
  const parts = parse(buf);
  if (!parts) throw new Error("Not a parseable JPEG.");

  const payloadLen = EXIF_SIG.length + tiff.length;
  const segLen = payloadLen + 2; // + the length field itself
  if (segLen > MAX_APP1) throw new Error("EXIF block exceeds the 64 KB JPEG segment limit.");

  const app1 = new Uint8Array(2 + segLen);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1[2] = (segLen >> 8) & 0xff;
  app1[3] = segLen & 0xff;
  app1.set(EXIF_SIG, 4);
  app1.set(tiff, 4 + EXIF_SIG.length);

  // SOI first, then our Exif APP1, then every other segment (minus old Exif),
  // then the scan. Placing Exif right after SOI is spec-compliant.
  const kept = parts.segments.filter((s) => !s.isExif);
  const soi = kept[0].raw; // the SOI we seeded first
  const others = kept.slice(1).map((s) => s.raw);

  const chunks = [soi, app1, ...others, parts.rest];
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}
