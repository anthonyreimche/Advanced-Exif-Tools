// Full metadata dump for the inspector — richer than the app's curated Info
// panel. Reuses the shared TIFF parser and decodes every tag it kept, grouped
// by IFD, with a human name and formatted value. Read-only; the writers own
// mutation.

import { parseTiff, type IfdNode, type TiffTag } from "./tiff";

export interface DumpEntry {
  ifd: string;
  tag: number;
  name: string;
  value: string;
}

/** Locate the TIFF header a format's EXIF lives in: byte 0 for TIFF/RAW-TIFF,
 *  or just past "Exif\0\0" in a JPEG APP1. Returns -1 when there's no EXIF. */
export function findExifBase(buf: Uint8Array): number {
  if (buf.length < 4) return -1;
  const head = (buf[0] << 8) | buf[1];
  if (head === 0x4949 || head === 0x4d4d) return 0; // TIFF / TIFF-based RAW
  if (head !== 0xffd8) return -1; // not JPEG either
  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) break;
    const marker = buf[off + 1];
    if (marker === 0xda || marker === 0xd9) break; // SOS / EOI
    const len = (buf[off + 2] << 8) | buf[off + 3];
    if (marker === 0xe1 && off + 10 <= buf.length) {
      const sig = off + 4;
      if (
        buf[sig] === 0x45 && buf[sig + 1] === 0x78 && buf[sig + 2] === 0x69 &&
        buf[sig + 3] === 0x66 && buf[sig + 4] === 0 && buf[sig + 5] === 0
      ) {
        return sig + 6;
      }
    }
    off += 2 + len;
  }
  return -1;
}

const TYPE_NAME: Record<number, string> = {
  1: "BYTE", 2: "ASCII", 3: "SHORT", 4: "LONG", 5: "RATIONAL",
  6: "SBYTE", 7: "UNDEFINED", 8: "SSHORT", 9: "SLONG", 10: "SRATIONAL",
  11: "FLOAT", 12: "DOUBLE",
};

// Common tag names by IFD context. Not exhaustive — unknown tags fall back to a
// "Tag 0x…" label, which is still useful in an inspector.
const BASE_TAGS: Record<number, string> = {
  0x0100: "ImageWidth", 0x0101: "ImageLength", 0x0102: "BitsPerSample",
  0x0103: "Compression", 0x0106: "PhotometricInterpretation",
  0x010e: "ImageDescription", 0x010f: "Make", 0x0110: "Model",
  0x0111: "StripOffsets", 0x0112: "Orientation", 0x0115: "SamplesPerPixel",
  0x0116: "RowsPerStrip", 0x0117: "StripByteCounts", 0x011a: "XResolution",
  0x011b: "YResolution", 0x0128: "ResolutionUnit", 0x0131: "Software",
  0x0132: "DateTime", 0x013b: "Artist", 0x013e: "WhitePoint",
  0x013f: "PrimaryChromaticities", 0x0201: "ThumbnailOffset",
  0x0202: "ThumbnailLength", 0x0211: "YCbCrCoefficients",
  0x0213: "YCbCrPositioning", 0x0214: "ReferenceBlackWhite",
  0x8298: "Copyright", 0x8769: "ExifIFD", 0x8825: "GPSIFD",
  0xa005: "InteropIFD", 0xc4a5: "PrintIM",
};

const EXIF_TAGS: Record<number, string> = {
  0x829a: "ExposureTime", 0x829d: "FNumber", 0x8822: "ExposureProgram",
  0x8827: "ISO", 0x8830: "SensitivityType", 0x8832: "RecommendedExposureIndex",
  0x9000: "ExifVersion", 0x9003: "DateTimeOriginal", 0x9004: "DateTimeDigitized",
  0x9010: "OffsetTime", 0x9011: "OffsetTimeOriginal", 0x9101: "ComponentsConfiguration",
  0x9290: "SubSecTime", 0x9291: "SubSecTimeOriginal", 0x9292: "SubSecTimeDigitized",
  0x9201: "ShutterSpeedValue", 0x9202: "ApertureValue", 0x9204: "ExposureBias",
  0x9205: "MaxApertureValue", 0x9206: "SubjectDistance", 0x9207: "MeteringMode",
  0x9208: "LightSource", 0x9209: "Flash", 0x920a: "FocalLength",
  0x927c: "MakerNote", 0x9286: "UserComment", 0xa000: "FlashpixVersion",
  0xa001: "ColorSpace", 0xa002: "PixelXDimension", 0xa003: "PixelYDimension",
  0xa005: "InteropIFD", 0xa402: "ExposureMode", 0xa403: "WhiteBalance",
  0xa404: "DigitalZoomRatio", 0xa405: "FocalLengthIn35mm", 0xa406: "SceneCaptureType",
  0xa408: "Contrast", 0xa409: "Saturation", 0xa40a: "Sharpness",
  0xa420: "ImageUniqueID", 0xa431: "BodySerialNumber", 0xa432: "LensInfo",
  0xa433: "LensMake", 0xa434: "LensModel", 0xa435: "LensSerialNumber",
};

const GPS_TAGS: Record<number, string> = {
  0x0000: "GPSVersionID", 0x0001: "GPSLatitudeRef", 0x0002: "GPSLatitude",
  0x0003: "GPSLongitudeRef", 0x0004: "GPSLongitude", 0x0005: "GPSAltitudeRef",
  0x0006: "GPSAltitude", 0x0007: "GPSTimeStamp", 0x0012: "GPSMapDatum",
  0x001d: "GPSDateStamp",
};

const INTEROP_TAGS: Record<number, string> = {
  0x0001: "InteroperabilityIndex", 0x0002: "InteroperabilityVersion",
};

function nameFor(ifd: string, tag: number): string {
  const dict =
    ifd === "Exif" ? EXIF_TAGS : ifd === "GPS" ? GPS_TAGS : ifd === "Interop" ? INTEROP_TAGS : BASE_TAGS;
  return dict[tag] ?? `Tag 0x${tag.toString(16).padStart(4, "0")}`;
}

function formatValue(t: TiffTag, little: boolean): string {
  const b = t.bytes;
  if (!b) return t.tag === 0x0111 || t.tag === 0x0201 ? "(image data)" : "";
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const cap = 16; // don't dump huge arrays into the inspector
  switch (t.type) {
    case 2: {
      let end = b.length;
      while (end > 0 && b[end - 1] === 0) end--;
      return new TextDecoder("utf-8").decode(b.subarray(0, end)).trim();
    }
    case 1:
    case 7: {
      const n = Math.min(t.count, 64);
      const vals = Array.from(b.subarray(0, n), (x) => x.toString(16).padStart(2, "0"));
      return vals.join(" ") + (t.count > n ? " …" : "");
    }
    case 3:
    case 8: {
      const n = Math.min(t.count, cap);
      const out: number[] = [];
      for (let i = 0; i < n; i++) out.push(t.type === 8 ? dv.getInt16(i * 2, little) : dv.getUint16(i * 2, little));
      return out.join(", ") + (t.count > n ? " …" : "");
    }
    case 4:
    case 9: {
      const n = Math.min(t.count, cap);
      const out: number[] = [];
      for (let i = 0; i < n; i++) out.push(t.type === 9 ? dv.getInt32(i * 4, little) : dv.getUint32(i * 4, little));
      return out.join(", ") + (t.count > n ? " …" : "");
    }
    case 5:
    case 10: {
      const n = Math.min(t.count, cap);
      const out: string[] = [];
      for (let i = 0; i < n; i++) {
        const num = t.type === 10 ? dv.getInt32(i * 8, little) : dv.getUint32(i * 8, little);
        const den = t.type === 10 ? dv.getInt32(i * 8 + 4, little) : dv.getUint32(i * 8 + 4, little);
        out.push(den === 0 ? `${num}/0` : Number.isInteger(num / den) ? `${num / den}` : `${num}/${den}`);
      }
      return out.join(", ") + (t.count > n ? " …" : "");
    }
    default:
      return `(${TYPE_NAME[t.type] ?? t.type} ×${t.count})`;
  }
}

function dumpIfd(node: IfdNode | undefined, ifd: string, little: boolean, out: DumpEntry[]): void {
  if (!node) return;
  const rows = node.tags
    .map((t) => ({ tag: t.tag, name: nameFor(ifd, t.tag), value: formatValue(t, little) }))
    .sort((a, b) => a.tag - b.tag);
  for (const r of rows) out.push({ ifd, tag: r.tag, name: r.name, value: r.value });
}

/** Decode every kept tag from `buf` into a grouped, human-readable list. */
export function readAllTags(buf: Uint8Array): DumpEntry[] {
  const base = findExifBase(buf);
  if (base < 0) return [];
  const tiff = parseTiff(buf, base);
  if (!tiff) return [];
  const out: DumpEntry[] = [];
  dumpIfd(tiff.ifd0, "IFD0", tiff.little, out);
  dumpIfd(tiff.ifd0.exif, "Exif", tiff.little, out);
  dumpIfd(tiff.ifd0.gps, "GPS", tiff.little, out);
  dumpIfd(tiff.ifd0.interop, "Interop", tiff.little, out);
  dumpIfd(tiff.ifd0.next, "IFD1", tiff.little, out);
  return out;
}
