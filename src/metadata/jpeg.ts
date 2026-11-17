// JPEG APP-segment surgery for in-place EXIF. We walk the marker segments up to
// the start-of-scan, swap the "Exif\0\0" APP1 payload for a freshly serialized
// TIFF, and leave every other segment (JFIF, XMP, ICC) and the entropy-coded
// image data untouched. Exports also get an XMP APP1 and a Photoshop APP13
// carrying IPTC-IIM; reading those back prefills the editor for JPEGs captioned
// elsewhere.

const EXIF_SIG = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
const XMP_SIG = ascii("http://ns.adobe.com/xap/1.0/\0");
const PHOTOSHOP_SIG = ascii("Photoshop 3.0\0");
const IRB_SIG = ascii("8BIM");
const IRB_IPTC = 0x0404;

function ascii(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

interface Segment {
  marker: number; // second byte of the FFxx marker
  /** Full segment bytes including the FFxx marker and 2-byte length. */
  raw: Uint8Array;
  isExif: boolean;
  isXmp: boolean;
  isPhotoshop: boolean;
}

interface JpegParts {
  segments: Segment[];
  /** Entropy-coded scan + trailing data, from the SOS marker to EOF. */
  rest: Uint8Array;
}

function startsWith(buf: Uint8Array, at: number, sig: number[]): boolean {
  if (at + sig.length > buf.length) return false;
  return sig.every((b, i) => buf[at + i] === b);
}

/** The segments before the scan. With `lenient`, a segment running past the
 *  end of `buf` (a head-of-file read) ends the walk instead of failing it. */
function parse(buf: Uint8Array, lenient = false): JpegParts | null {
  if (buf.length < 2 || buf[0] !== 0xff || buf[1] !== 0xd8) return null; // SOI
  const segments: Segment[] = [
    { marker: 0xd8, raw: buf.subarray(0, 2), isExif: false, isXmp: false, isPhotoshop: false },
  ];
  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) return null; // desync — refuse rather than guess
    const marker = buf[off + 1];
    if (marker === 0xda || marker === 0xd9) break; // SOS / EOI → rest starts here
    const len = (buf[off + 2] << 8) | buf[off + 3];
    const end = off + 2 + len;
    if (end > buf.length) {
      if (lenient) break;
      return null;
    }
    const payloadStart = off + 4;
    segments.push({
      marker,
      raw: buf.subarray(off, end),
      isExif: marker === 0xe1 && startsWith(buf, payloadStart, EXIF_SIG),
      isXmp: marker === 0xe1 && startsWith(buf, payloadStart, XMP_SIG),
      isPhotoshop: marker === 0xed && startsWith(buf, payloadStart, PHOTOSHOP_SIG),
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

function segment(marker: number, payload: Uint8Array): Uint8Array {
  const segLen = payload.length + 2;
  if (segLen > MAX_APP1) throw new Error("Metadata exceeds the 64 KB JPEG segment limit.");
  const out = new Uint8Array(2 + segLen);
  out[0] = 0xff;
  out[1] = marker;
  out[2] = (segLen >> 8) & 0xff;
  out[3] = segLen & 0xff;
  out.set(payload, 4);
  return out;
}

function concat(chunks: (Uint8Array | number[])[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

/** A Photoshop image resource block holding `iim` as its IPTC resource: the
 *  signature, the resource id, an empty Pascal name padded to even length, the
 *  size, then the data padded to even length. */
function iptcResource(iim: Uint8Array): Uint8Array {
  const size = [(iim.length >>> 24) & 0xff, (iim.length >>> 16) & 0xff, (iim.length >>> 8) & 0xff, iim.length & 0xff];
  return concat([IRB_SIG, [IRB_IPTC >> 8, IRB_IPTC & 0xff, 0, 0], size, iim, iim.length & 1 ? [0] : []]);
}

/** `buf` with its XMP and Photoshop segments replaced by `xmp` and `iim`
 *  (either may be empty, for none), placed after the JFIF/EXIF segments. Every
 *  other segment and the scan are kept byte for byte. Throws when the JPEG
 *  can't be parsed or a block is too big for one segment. */
export function embedIptcInJpeg(buf: Uint8Array, xmp: string, iim: Uint8Array): Uint8Array {
  const parts = parse(buf);
  if (!parts) throw new Error("Not a parseable JPEG.");
  const added: Uint8Array[] = [];
  if (xmp) added.push(segment(0xe1, concat([XMP_SIG, new TextEncoder().encode(xmp)])));
  if (iim.length) added.push(segment(0xed, concat([PHOTOSHOP_SIG, iptcResource(iim)])));

  const kept = parts.segments.filter((s) => !s.isXmp && !s.isPhotoshop);
  let at = 1; // after SOI
  while (at < kept.length && (kept[at].marker === 0xe0 || kept[at].isExif)) at++;
  return concat([
    ...kept.slice(0, at).map((s) => s.raw),
    ...added,
    ...kept.slice(at).map((s) => s.raw),
    parts.rest,
  ]);
}

/** The IPTC resource's bytes inside a Photoshop APP13 payload, or null. */
function iimFromPhotoshop(payload: Uint8Array): Uint8Array | null {
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let off = PHOTOSHOP_SIG.length;
  while (off + 12 <= payload.length && startsWith(payload, off, IRB_SIG)) {
    const id = dv.getUint16(off + 4, false);
    const nameLen = payload[off + 6];
    const sizeAt = off + 6 + ((nameLen + 2) & ~1);
    if (sizeAt + 4 > payload.length) return null;
    const size = dv.getUint32(sizeAt, false);
    const dataAt = sizeAt + 4;
    if (dataAt + size > payload.length) return null;
    if (id === IRB_IPTC) return payload.subarray(dataAt, dataAt + size);
    off = dataAt + size + (size & 1);
  }
  return null;
}

/** The XMP packet and IPTC-IIM bytes embedded in a JPEG (or the head of one),
 *  each null when absent. */
export function readEmbeddedMeta(buf: Uint8Array): { xmp: string | null; iim: Uint8Array | null } {
  const parts = parse(buf, true);
  if (!parts) return { xmp: null, iim: null };
  const xmpSeg = parts.segments.find((s) => s.isXmp);
  const psSeg = parts.segments.find((s) => s.isPhotoshop);
  return {
    xmp: xmpSeg ? new TextDecoder().decode(xmpSeg.raw.subarray(4 + XMP_SIG.length)) : null,
    iim: psSeg ? iimFromPhotoshop(psSeg.raw.subarray(4)) : null,
  };
}
