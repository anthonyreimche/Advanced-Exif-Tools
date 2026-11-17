// IPTC Core fields beyond creator/copyright/caption: one table drives the XMP
// properties, the IPTC-IIM datasets embedded in exported JPEGs, and the editor.
// The IIM codec here works on raw dataset bytes (0x1C record dataset length
// value…); wrapping them in a Photoshop resource block is jpeg.ts's job.

import type { EditableMeta } from "./model";

export type IptcKey =
  | "title"
  | "headline"
  | "captionWriter"
  | "authorsPosition"
  | "copyrightStatus"
  | "usageTerms"
  | "webStatement"
  | "credit"
  | "source"
  | "sublocation"
  | "city"
  | "state"
  | "country"
  | "countryCode"
  | "jobId"
  | "instructions";

/** IPTC values by field. A present key means "write this"; an empty string
 *  means "clear it". copyrightStatus is "copyrighted", "public" or "". */
export type IptcValues = Partial<Record<IptcKey, string>>;

export type IptcGroup = "content" | "rights" | "location" | "workflow";

/** How the property is serialized in XMP: a plain text value, a language
 *  alternative (rdf:Alt, x-default), or xmpRights:Marked's True/False. */
export type XmpForm = "text" | "alt" | "marked";

export interface IptcFieldDef {
  key: IptcKey;
  label: string;
  group: IptcGroup;
  /** Qualified XMP property name. */
  xmp: string;
  form: XmpForm;
  /** IIM record-2 dataset and its byte limit; absent for XMP-only fields. */
  iim?: { dataset: number; max: number };
  multiline?: boolean;
}

export const IPTC_FIELDS: readonly IptcFieldDef[] = [
  { key: "title", label: "Title", group: "content", xmp: "dc:title", form: "alt", iim: { dataset: 5, max: 64 } },
  { key: "headline", label: "Headline", group: "content", xmp: "photoshop:Headline", form: "text", iim: { dataset: 105, max: 256 } },
  { key: "captionWriter", label: "Caption writer", group: "content", xmp: "photoshop:CaptionWriter", form: "text", iim: { dataset: 122, max: 32 } },
  { key: "copyrightStatus", label: "Copyright status", group: "rights", xmp: "xmpRights:Marked", form: "marked" },
  { key: "usageTerms", label: "Rights usage terms", group: "rights", xmp: "xmpRights:UsageTerms", form: "alt", multiline: true },
  { key: "webStatement", label: "Copyright info URL", group: "rights", xmp: "xmpRights:WebStatement", form: "text" },
  { key: "credit", label: "Credit line", group: "rights", xmp: "photoshop:Credit", form: "text", iim: { dataset: 110, max: 32 } },
  { key: "source", label: "Source", group: "rights", xmp: "photoshop:Source", form: "text", iim: { dataset: 115, max: 32 } },
  { key: "authorsPosition", label: "Creator's job title", group: "rights", xmp: "photoshop:AuthorsPosition", form: "text", iim: { dataset: 85, max: 32 } },
  { key: "sublocation", label: "Sublocation", group: "location", xmp: "Iptc4xmpCore:Location", form: "text", iim: { dataset: 92, max: 32 } },
  { key: "city", label: "City", group: "location", xmp: "photoshop:City", form: "text", iim: { dataset: 90, max: 32 } },
  { key: "state", label: "Province / state", group: "location", xmp: "photoshop:State", form: "text", iim: { dataset: 95, max: 32 } },
  { key: "country", label: "Country", group: "location", xmp: "photoshop:Country", form: "text", iim: { dataset: 101, max: 64 } },
  { key: "countryCode", label: "Country code", group: "location", xmp: "Iptc4xmpCore:CountryCode", form: "text", iim: { dataset: 100, max: 3 } },
  { key: "jobId", label: "Job ID", group: "workflow", xmp: "photoshop:TransmissionReference", form: "text", iim: { dataset: 103, max: 32 } },
  { key: "instructions", label: "Instructions", group: "workflow", xmp: "photoshop:Instructions", form: "text", iim: { dataset: 40, max: 256 }, multiline: true },
];

export const IPTC_GROUPS: { value: IptcGroup; label: string }[] = [
  { value: "content", label: "Content" },
  { value: "rights", label: "Rights" },
  { value: "location", label: "Location" },
  { value: "workflow", label: "Workflow" },
];

export const COPYRIGHT_STATUS_OPTIONS = [
  { value: "", label: "Unknown" },
  { value: "copyrighted", label: "Copyrighted" },
  { value: "public", label: "Public domain" },
];

// ── IPTC-IIM ─────────────────────────────────────────────────────────────────

const TAG_MARKER = 0x1c;
const DS_BYLINE = 80;
const DS_COPYRIGHT = 116;
const DS_CAPTION = 120;
const DS_KEYWORDS = 25;
const DS_CHARSET = 90; // record 1
const DS_RECORD_VERSION = 0; // record 2
const UTF8_ESCAPE = [0x1b, 0x25, 0x47]; // ESC % G

/** UTF-8 bytes of `s`, cut to at most `max` bytes without splitting a character. */
function utf8Limited(s: string, max: number): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length <= max) return bytes;
  let end = max;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end);
}

function dataset(record: number, ds: number, value: Uint8Array): number[] {
  return [TAG_MARKER, record, ds, (value.length >> 8) & 0xff, value.length & 0xff, ...value];
}

/** IIM datasets for `meta`, UTF-8 declared, values cut to the IIM byte limits
 *  (the XMP packet keeps the full text). Empty when nothing has a value. */
export function buildIim(meta: EditableMeta): Uint8Array {
  const out: number[] = [];
  const add = (ds: number, value: string | undefined, max: number) => {
    if (value) out.push(...dataset(2, ds, utf8Limited(value, max)));
  };
  add(DS_BYLINE, meta.artist, 32);
  add(DS_COPYRIGHT, meta.copyright, 128);
  add(DS_CAPTION, meta.description, 2000);
  for (const k of meta.keywords ?? []) add(DS_KEYWORDS, k, 64);
  for (const f of IPTC_FIELDS) {
    if (f.iim) add(f.iim.dataset, meta.iptc?.[f.key], f.iim.max);
  }
  if (out.length === 0) return new Uint8Array(0);
  const header = [
    ...dataset(1, DS_CHARSET, new Uint8Array(UTF8_ESCAPE)),
    ...dataset(2, DS_RECORD_VERSION, new Uint8Array([0x00, 0x04])),
  ];
  return new Uint8Array([...header, ...out]);
}

/** The fields buildIim writes, read back from raw IIM datasets. Values are
 *  UTF-8 when record 1 declares it, else Windows-1252 (legacy writers). */
export function parseIim(bytes: Uint8Array): EditableMeta {
  const raw: { record: number; ds: number; value: Uint8Array }[] = [];
  let off = 0;
  while (off + 5 <= bytes.length && bytes[off] === TAG_MARKER) {
    const len = (bytes[off + 3] << 8) | bytes[off + 4];
    if (len & 0x8000) break; // extended-length datasets aren't used for text
    const start = off + 5;
    if (start + len > bytes.length) break;
    raw.push({ record: bytes[off + 1], ds: bytes[off + 2], value: bytes.subarray(start, start + len) });
    off = start + len;
  }

  const charset = raw.find((d) => d.record === 1 && d.ds === DS_CHARSET)?.value;
  const utf8 = !!charset && UTF8_ESCAPE.every((b, i) => charset[i] === b);
  const decoder = new TextDecoder(utf8 ? "utf-8" : "windows-1252");
  const text = (ds: number) => {
    const d = raw.find((r) => r.record === 2 && r.ds === ds);
    return d ? decoder.decode(d.value).trim() || undefined : undefined;
  };

  const meta: EditableMeta = {};
  const artist = text(DS_BYLINE);
  if (artist) meta.artist = artist;
  const copyright = text(DS_COPYRIGHT);
  if (copyright) meta.copyright = copyright;
  const description = text(DS_CAPTION);
  if (description) meta.description = description;
  const keywords = raw
    .filter((r) => r.record === 2 && r.ds === DS_KEYWORDS)
    .map((r) => decoder.decode(r.value).trim())
    .filter(Boolean);
  if (keywords.length) meta.keywords = keywords;

  const iptc: IptcValues = {};
  for (const f of IPTC_FIELDS) {
    const v = f.iim ? text(f.iim.dataset) : undefined;
    if (v) iptc[f.key] = v;
  }
  if (Object.keys(iptc).length) meta.iptc = iptc;
  return meta;
}
