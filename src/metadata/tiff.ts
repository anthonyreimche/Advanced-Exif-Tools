// A read/edit/re-serialize TIFF model, shared by the JPEG and TIFF writers.
//
// It parses the IFD tree into an editable form where every ordinary tag keeps
// its raw value bytes verbatim, then re-serializes a fresh, well-formed TIFF
// with recomputed offsets. Output endianness is kept identical to the input, so
// pass-through tag bytes copy without re-encoding — only edited tags and the
// structural offsets are rebuilt. Pixel/thumbnail data referenced by offset tags
// (strips, tiles, embedded JPEG thumbnail) is copied block-for-block and its
// offsets patched. Anything we can't rewrite with confidence sets `complex`, so
// callers can fall back to a sidecar instead of risking the file.

export type FieldType = number; // 1..12 per TIFF spec

const TYPE_SIZE: Record<number, number> = {
  1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8,
};

// Pointer tags: values are offsets to sub-IFDs, rebuilt on serialize.
const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_INTEROP_IFD = 0xa005;

// Offset/byte-count pairs pointing at external data blocks.
const TAG_STRIP_OFFSETS = 0x0111;
const TAG_STRIP_BYTECOUNTS = 0x0117;
const TAG_TILE_OFFSETS = 0x0144;
const TAG_TILE_BYTECOUNTS = 0x0145;
const TAG_JPEG_THUMB_OFFSET = 0x0201;
const TAG_JPEG_THUMB_LENGTH = 0x0202;

export interface TiffTag {
  tag: number;
  type: FieldType;
  count: number;
  /** Raw value bytes in the file's endianness, length = count * typeSize.
   *  Undefined for the offset tag whose values we recompute at serialize. */
  bytes?: Uint8Array;
}

export interface IfdNode {
  tags: TiffTag[];
  exif?: IfdNode;
  gps?: IfdNode;
  interop?: IfdNode;
  /** Next IFD in the chain (IFD1 = embedded thumbnail). */
  next?: IfdNode;
  /** External data blocks referenced by this IFD's offset tag, in order. */
  blocks?: Uint8Array[];
  /** Which tag id carries the offsets for `blocks` (strip/tile/thumb). */
  offsetTag?: number;
}

export interface Tiff {
  little: boolean;
  ifd0: IfdNode;
  /** Set when parsing hit something we won't safely re-serialize. */
  complex: boolean;
}

// ── reading ──────────────────────────────────────────────────────────────────

class Reader {
  constructor(
    readonly view: DataView,
    readonly base: number,
    readonly little: boolean,
  ) {}
  u16(off: number): number {
    return this.view.getUint16(this.base + off, this.little);
  }
  u32(off: number): number {
    return this.view.getUint32(this.base + off, this.little);
  }
}

/** Parse a TIFF starting at `base` inside `buf`. Returns null if not a TIFF. */
export function parseTiff(buf: Uint8Array, base = 0): Tiff | null {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (base + 8 > buf.byteLength) return null;
  const bomBE = view.getUint16(base, false);
  const little = bomBE === 0x4949;
  if (!little && bomBE !== 0x4d4d) return null;
  const r = new Reader(view, base, little);
  if (r.u16(2) !== 42) return null;
  const state = { complex: false };
  const ifd0 = readIfd(buf, r, r.u32(4), 0, state);
  if (!ifd0) return null;
  return { little, ifd0, complex: state.complex };
}

function readIfd(
  buf: Uint8Array,
  r: Reader,
  ifdOffset: number,
  depth: number,
  state: { complex: boolean },
): IfdNode | null {
  if (ifdOffset <= 0 || r.base + ifdOffset + 2 > buf.byteLength) return null;
  if (depth > 6) {
    state.complex = true;
    return null;
  }
  const count = r.u16(ifdOffset);
  const node: IfdNode = { tags: [] };
  let offsetTag: number | undefined;
  let byteCountsTag: number | undefined;

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
      if (sub) {
        if (tag === TAG_EXIF_IFD) node.exif = sub;
        else if (tag === TAG_GPS_IFD) node.gps = sub;
        else node.interop = sub;
      }
      continue; // pointer rebuilt on serialize; don't keep as a normal tag
    }

    if (size > 4 && (absData < 0 || absData + size > buf.byteLength)) {
      // A value pointer we can't trust — bail to sidecar rather than corrupt.
      state.complex = true;
      continue;
    }
    const bytes = buf.subarray(absData, absData + size);
    const t: TiffTag = { tag, type, count: cnt, bytes };
    node.tags.push(t);

    if (tag === TAG_STRIP_OFFSETS || tag === TAG_TILE_OFFSETS || tag === TAG_JPEG_THUMB_OFFSET) {
      offsetTag = tag;
    } else if (
      tag === TAG_STRIP_BYTECOUNTS ||
      tag === TAG_TILE_BYTECOUNTS ||
      tag === TAG_JPEG_THUMB_LENGTH
    ) {
      byteCountsTag = tag;
    }
  }

  // Resolve external blocks referenced by an offset tag using its byte counts.
  if (offsetTag !== undefined) {
    const offs = readIntTag(r, node, offsetTag);
    const counts =
      offsetTag === TAG_JPEG_THUMB_OFFSET
        ? readIntTag(r, node, TAG_JPEG_THUMB_LENGTH)
        : readIntTag(r, node, byteCountsTag ?? -1);
    if (!offs || !counts || offs.length !== counts.length) {
      state.complex = true;
    } else {
      const blocks: Uint8Array[] = [];
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
        // The offset tag's stored bytes are stale; recomputed on serialize.
        const ot = node.tags.find((x) => x.tag === offsetTag);
        if (ot) ot.bytes = undefined;
      }
    }
  }

  node.next = readIfd(buf, r, r.u32(ifdOffset + 2 + count * 12), depth + 1, state) ?? undefined;
  return node;
}

/** Decode an integer tag (BYTE/SHORT/LONG) already captured in `node.tags`. */
function readIntTag(r: Reader, node: IfdNode, tag: number): number[] | null {
  const t = node.tags.find((x) => x.tag === tag);
  if (!t || !t.bytes) return null;
  const dv = new DataView(t.bytes.buffer, t.bytes.byteOffset, t.bytes.byteLength);
  const out: number[] = [];
  for (let i = 0; i < t.count; i++) {
    if (t.type === 3) out.push(dv.getUint16(i * 2, r.little));
    else if (t.type === 4) out.push(dv.getUint32(i * 4, r.little));
    else if (t.type === 1) out.push(dv.getUint8(i));
    else return null;
  }
  return out;
}

// ── editing helpers ──────────────────────────────────────────────────────────

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8");

/** Read an ASCII/UTF-8 tag as a trimmed string, or undefined. */
export function getAscii(node: IfdNode | undefined, tag: number): string | undefined {
  const t = node?.tags.find((x) => x.tag === tag);
  if (!t || !t.bytes || t.type !== 2) return undefined;
  let end = t.bytes.length;
  while (end > 0 && t.bytes[end - 1] === 0) end--;
  const s = dec.decode(t.bytes.subarray(0, end)).trim();
  return s || undefined;
}

/** Set (or, with undefined/empty, remove) an ASCII tag. Written as UTF-8 + NUL;
 *  mainstream readers (exiftool, Lightroom, Explorer) accept UTF-8 here. */
export function setAscii(node: IfdNode, tag: number, value: string | undefined): void {
  const idx = node.tags.findIndex((x) => x.tag === tag);
  if (!value) {
    if (idx >= 0) node.tags.splice(idx, 1);
    return;
  }
  const body = enc.encode(value);
  const bytes = new Uint8Array(body.length + 1);
  bytes.set(body, 0); // trailing NUL already zero
  const t: TiffTag = { tag, type: 2, count: bytes.length, bytes };
  if (idx >= 0) node.tags[idx] = t;
  else node.tags.push(t);
}

/** Ensure an Exif sub-IFD exists (for DateTimeOriginal etc.). */
export function ensureExif(tiff: Tiff): IfdNode {
  if (!tiff.ifd0.exif) tiff.ifd0.exif = { tags: [] };
  return tiff.ifd0.exif;
}

/** Ensure a GPS sub-IFD exists. */
export function ensureGps(tiff: Tiff): IfdNode {
  if (!tiff.ifd0.gps) tiff.ifd0.gps = { tags: [] };
  return tiff.ifd0.gps;
}

/** Set a RATIONAL/ SRATIONAL array (each value a [num, den] pair). */
export function setRationals(
  node: IfdNode,
  tag: number,
  pairs: [number, number][],
  little: boolean,
  signed = false,
): void {
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
  const t: TiffTag = { tag, type: signed ? 10 : 5, count: pairs.length, bytes };
  const idx = node.tags.findIndex((x) => x.tag === tag);
  if (idx >= 0) node.tags[idx] = t;
  else node.tags.push(t);
}

/** Set a single BYTE tag (e.g. GPS refs are ASCII; altitude ref is BYTE). */
export function setByte(node: IfdNode, tag: number, value: number): void {
  const t: TiffTag = { tag, type: 1, count: 1, bytes: new Uint8Array([value & 0xff]) };
  const idx = node.tags.findIndex((x) => x.tag === tag);
  if (idx >= 0) node.tags[idx] = t;
  else node.tags.push(t);
}

// ── serialization ────────────────────────────────────────────────────────────

const align2 = (n: number) => (n & 1 ? n + 1 : n);

/** Flattened IFD ready to emit, with resolved child offsets filled in later. */
interface Planned {
  node: IfdNode;
  entries: PlannedEntry[];
  ifdOffset: number; // start of this IFD's entry block
  dataOffset: number; // start of this IFD's overflow value area
  dataSize: number;
}

interface PlannedEntry {
  tag: number;
  type: number;
  count: number;
  bytes?: Uint8Array; // resolved value bytes (>4 → into data area)
  /** For pointer entries: which child to resolve the offset from. */
  pointer?: "exif" | "gps" | "interop";
  /** For the offset tag: emit new block offsets instead of `bytes`. */
  offsetKind?: boolean;
}

function plannedEntriesFor(node: IfdNode, little: boolean): PlannedEntry[] {
  const entries: PlannedEntry[] = [];
  for (const t of node.tags) {
    if (t.tag === node.offsetTag) {
      entries.push({ tag: t.tag, type: t.type, count: t.count, offsetKind: true });
    } else if (t.bytes) {
      entries.push({ tag: t.tag, type: t.type, count: t.count, bytes: t.bytes });
    }
  }
  if (node.exif) entries.push({ tag: TAG_EXIF_IFD, type: 4, count: 1, pointer: "exif" });
  if (node.gps) entries.push({ tag: TAG_GPS_IFD, type: 4, count: 1, pointer: "gps" });
  if (node.interop) entries.push({ tag: TAG_INTEROP_IFD, type: 4, count: 1, pointer: "interop" });
  // TIFF requires entries sorted ascending by tag id.
  entries.sort((a, b) => a.tag - b.tag);
  void little;
  return entries;
}

/** Re-serialize `tiff` to a standalone TIFF byte buffer. */
export function serializeTiff(tiff: Tiff): Uint8Array {
  const little = tiff.little;

  // Depth-first order: an IFD, then its exif/gps/interop, then the next IFD.
  const order: IfdNode[] = [];
  const walk = (n: IfdNode) => {
    order.push(n);
    if (n.exif) walk(n.exif);
    if (n.gps) walk(n.gps);
    if (n.interop) walk(n.interop);
    if (n.next) walk(n.next);
  };
  walk(tiff.ifd0);

  // Pass 1: assign IFD + overflow-data offsets sequentially after the header.
  const planned: Planned[] = [];
  let cursor = 8; // after TIFF header
  for (const node of order) {
    const entries = plannedEntriesFor(node, little);
    const ifdOffset = cursor;
    const entriesSize = 2 + entries.length * 12 + 4;
    let dataSize = 0;
    for (const e of entries) {
      const len = e.offsetKind
        ? e.count * 4 // offsets emitted as LONG array
        : e.bytes
          ? e.bytes.length
          : 0;
      if (len > 4) dataSize += align2(len);
    }
    const dataOffset = ifdOffset + entriesSize;
    planned.push({ node, entries, ifdOffset, dataOffset, dataSize });
    cursor = dataOffset + dataSize;
  }

  // Pass 2: assign external block offsets (strips/tiles/thumbnail) after IFDs.
  const blockOffsets = new Map<IfdNode, number[]>();
  for (const node of order) {
    if (!node.blocks) continue;
    const offs: number[] = [];
    for (const b of node.blocks) {
      offs.push(cursor);
      cursor = align2(cursor + b.length);
    }
    blockOffsets.set(node, offs);
  }

  const total = cursor;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  const nodeToPlan = new Map(planned.map((p) => [p.node, p] as const));

  // Header.
  dv.setUint16(0, little ? 0x4949 : 0x4d4d, false);
  dv.setUint16(2, 42, little);
  dv.setUint32(4, tiff.ifd0 ? nodeToPlan.get(tiff.ifd0)!.ifdOffset : 0, little);

  // Write each IFD.
  for (let pi = 0; pi < planned.length; pi++) {
    const p = planned[pi];
    let dataPtr = p.dataOffset;
    dv.setUint16(p.ifdOffset, p.entries.length, little);

    p.entries.forEach((e, i) => {
      const entryOff = p.ifdOffset + 2 + i * 12;
      dv.setUint16(entryOff, e.tag, little);

      // Resolve the value bytes for this entry.
      let type = e.type;
      let count = e.count;
      let valueBytes: Uint8Array;
      if (e.pointer) {
        const child = e.pointer === "exif" ? p.node.exif : e.pointer === "gps" ? p.node.gps : p.node.interop;
        const childOff = child ? nodeToPlan.get(child)!.ifdOffset : 0;
        valueBytes = u32Bytes(childOff, little);
        type = 4;
        count = 1;
      } else if (e.offsetKind) {
        const offs = blockOffsets.get(p.node) ?? [];
        type = 4; // normalise to LONG
        count = offs.length;
        const b = new Uint8Array(offs.length * 4);
        const bd = new DataView(b.buffer);
        offs.forEach((o, k) => bd.setUint32(k * 4, o, little));
        valueBytes = b;
      } else {
        valueBytes = e.bytes ?? new Uint8Array(0);
      }

      dv.setUint16(entryOff + 2, type, little);
      dv.setUint32(entryOff + 4, count, little);
      if (valueBytes.length <= 4) {
        // Inline, left-justified; remaining bytes stay zero.
        out.set(valueBytes, entryOff + 8);
      } else {
        dv.setUint32(entryOff + 8, dataPtr, little);
        out.set(valueBytes, dataPtr);
        dataPtr = align2(dataPtr + valueBytes.length);
      }
    });

    // next-IFD pointer.
    const nextOff = p.ifdOffset + 2 + p.entries.length * 12;
    const nextNode = p.node.next;
    dv.setUint32(nextOff, nextNode ? nodeToPlan.get(nextNode)!.ifdOffset : 0, little);
  }

  // Write external blocks.
  for (const node of order) {
    if (!node.blocks) continue;
    const offs = blockOffsets.get(node)!;
    node.blocks.forEach((b, i) => out.set(b, offs[i]));
  }

  return out;
}

function u32Bytes(n: number, little: boolean): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, little);
  return b;
}
