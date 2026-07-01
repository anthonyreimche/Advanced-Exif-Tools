// XMP sidecar read/write for formats we won't edit in place (RAW, PNG, …). The
// writer upserts only the properties we manage into an existing packet, leaving
// any foreign properties (e.g. a Lightroom sidecar's develop settings) intact;
// with no existing packet it emits a fresh one. The reader pulls our fields back
// so the app shows sidecar edits after a rescan (via the onPhotoImport hook).

import type { EditableMeta } from "./model";

const NS = {
  dc: "http://purl.org/dc/elements/1.1/",
  exif: "http://ns.adobe.com/exif/1.0/",
  xmp: "http://ns.adobe.com/xap/1.0/",
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function unesc(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** EXIF "YYYY:MM:DD HH:MM:SS" → XMP ISO "YYYY-MM-DDTHH:MM:SS". */
function exifDateToIso(s: string): string {
  const m = s.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}` : s;
}

/** Decimal degrees → XMP "DDD,MM.mmmmH" form. */
function decimalToXmp(value: number, positive: string, negative: string): string {
  const ref = value < 0 ? negative : positive;
  const abs = Math.abs(value);
  const deg = Math.floor(abs);
  const min = (abs - deg) * 60;
  return `${deg},${min.toFixed(4)}${ref}`;
}

// ── which fields carry into the packet ───────────────────────────────────────

interface PacketFields {
  meta: EditableMeta;
  /** EXIF-form capture date to mirror into exif:DateTimeOriginal, if any. */
  date?: string;
}

/** Element serializations for each managed property that has a value. A key set
 *  to null means "explicitly clear" (remove the property, write nothing). */
function managedElements(fields: PacketFields): { tag: string; xml: string | null }[] {
  const { meta, date } = fields;
  const out: { tag: string; xml: string | null }[] = [];

  if (meta.artist !== undefined) {
    out.push({
      tag: "dc:creator",
      xml: meta.artist
        ? `<dc:creator><rdf:Seq><rdf:li>${esc(meta.artist)}</rdf:li></rdf:Seq></dc:creator>`
        : null,
    });
  }
  if (meta.copyright !== undefined) {
    out.push({
      tag: "dc:rights",
      xml: meta.copyright
        ? `<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">${esc(meta.copyright)}</rdf:li></rdf:Alt></dc:rights>`
        : null,
    });
  }
  if (meta.description !== undefined) {
    out.push({
      tag: "dc:description",
      xml: meta.description
        ? `<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${esc(meta.description)}</rdf:li></rdf:Alt></dc:description>`
        : null,
    });
  }
  if (meta.keywords !== undefined) {
    out.push({
      tag: "dc:subject",
      xml: meta.keywords.length
        ? `<dc:subject><rdf:Bag>${meta.keywords.map((k) => `<rdf:li>${esc(k)}</rdf:li>`).join("")}</rdf:Bag></dc:subject>`
        : null,
    });
  }
  if (date) {
    out.push({ tag: "exif:DateTimeOriginal", xml: `<exif:DateTimeOriginal>${esc(exifDateToIso(date))}</exif:DateTimeOriginal>` });
  }
  if (meta.gpsLat !== undefined && meta.gpsLon !== undefined) {
    out.push({ tag: "exif:GPSLatitude", xml: `<exif:GPSLatitude>${decimalToXmp(meta.gpsLat, "N", "S")}</exif:GPSLatitude>` });
    out.push({ tag: "exif:GPSLongitude", xml: `<exif:GPSLongitude>${decimalToXmp(meta.gpsLon, "E", "W")}</exif:GPSLongitude>` });
  }
  return out;
}

function freshPacket(inner: string): string {
  return (
    `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Advanced EXIF Tools">\n` +
    ` <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n` +
    `  <rdf:Description rdf:about=""\n` +
    `    xmlns:dc="${NS.dc}"\n    xmlns:exif="${NS.exif}"\n    xmlns:xmp="${NS.xmp}">\n` +
    `   ${inner}\n` +
    `  </rdf:Description>\n` +
    ` </rdf:RDF>\n` +
    `</x:xmpmeta>\n` +
    `<?xpacket end="w"?>`
  );
}

/** Produce updated XMP text carrying `fields`, preserving foreign properties in
 *  an existing packet. */
export function upsertXmp(existing: string | null, fields: PacketFields): string {
  const managed = managedElements(fields);
  const additions = managed.filter((m) => m.xml).map((m) => m.xml!) as string[];

  if (!existing || !/<rdf:Description[\s>]/.test(existing)) {
    return freshPacket(additions.join("\n   "));
  }

  let text = existing;
  // Remove any prior copies of the properties we manage (element form; these
  // fields aren't used in attribute form by mainstream writers).
  for (const m of managed) {
    const re = new RegExp(`\\s*<${m.tag}[\\s\\S]*?<\\/${m.tag}>`, "g");
    text = text.replace(re, "");
    // Also drop a self-closing / attribute form just in case.
    text = text.replace(new RegExp(`\\s*<${m.tag}\\b[^>]*/>`, "g"), "");
    text = text.replace(new RegExp(`\\s+${m.tag}="[^"]*"`, "g"), "");
  }

  // Make sure the namespaces we use are declared on the first Description tag.
  text = text.replace(/<rdf:Description\b([^>]*)>/, (_full, attrs: string) => {
    let a = attrs;
    if (!/xmlns:dc=/.test(a)) a += ` xmlns:dc="${NS.dc}"`;
    if (!/xmlns:exif=/.test(a) && additions.some((x) => x.includes("exif:"))) a += ` xmlns:exif="${NS.exif}"`;
    return `<rdf:Description${a}>`;
  });

  // Insert our fresh elements just before the closing Description tag.
  const insertion = additions.length ? `   ${additions.join("\n   ")}\n  ` : "";
  return text.replace(/<\/rdf:Description>/, `${insertion}</rdf:Description>`);
}

// ── reading ──────────────────────────────────────────────────────────────────

function firstAltOrSeq(xmp: string, tag: string): string | undefined {
  const block = new RegExp(`<${tag}[\\s\\S]*?>([\\s\\S]*?)</${tag}>`).exec(xmp);
  if (block) {
    const li = /<rdf:li(?:\s[^>]*)?>([\s\S]*?)<\/rdf:li>/.exec(block[1]);
    if (li) return unesc(li[1].trim());
  }
  const attr = new RegExp(`\\s${tag}="([^"]*)"`).exec(xmp);
  return attr ? unesc(attr[1].trim()) : undefined;
}

function bagItems(xmp: string, tag: string): string[] {
  const block = new RegExp(`<${tag}[\\s\\S]*?>([\\s\\S]*?)</${tag}>`).exec(xmp);
  if (!block) return [];
  const items: string[] = [];
  const re = /<rdf:li(?:\s[^>]*)?>([\s\S]*?)<\/rdf:li>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block[1]))) {
    const v = unesc(m[1].trim());
    if (v) items.push(v);
  }
  return items;
}

export interface SidecarData {
  meta: EditableMeta;
  /** EXIF-form capture date, if the sidecar carried exif:DateTimeOriginal. */
  date?: string;
}

/** Parse the fields we manage out of an XMP sidecar's text. */
export function readXmp(text: string): SidecarData {
  const meta: EditableMeta = {};
  const creator = firstAltOrSeq(text, "dc:creator");
  if (creator) meta.artist = creator;
  const rights = firstAltOrSeq(text, "dc:rights");
  if (rights) meta.copyright = rights;
  const desc = firstAltOrSeq(text, "dc:description");
  if (desc) meta.description = desc;
  const kws = bagItems(text, "dc:subject");
  if (kws.length) meta.keywords = kws;

  const out: SidecarData = { meta };
  const iso = /<exif:DateTimeOriginal>([\s\S]*?)<\/exif:DateTimeOriginal>/.exec(text)
    ?? new RegExp(`\\sexif:DateTimeOriginal="([^"]*)"`).exec(text);
  if (iso) {
    const v = unesc(iso[1].trim());
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})/);
    out.date = m ? `${m[1]}:${m[2]}:${m[3]} ${m[4]}` : v;
  }
  return out;
}
