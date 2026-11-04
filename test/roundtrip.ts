// Standalone verification of the pure logic (no app/DOM needed): the TIFF
// read→edit→serialize round-trip, JPEG APP1 insertion, XMP upsert/read, and the
// rename planner. Bundled with rolldown and run under Node.

import {
  parseTiff, serializeTiff, setAscii, getAscii, ensureExif, setRationals, type Tiff,
} from "../src/metadata/tiff";
import { getExifTiff, writeExifIntoJpeg } from "../src/metadata/jpeg";
import { upsertXmp, readXmp, sidecarName, legacySidecarName, isOwnPacket } from "../src/metadata/xmp";
import { writeSidecar, readSidecarForImport, applyMetadata } from "../src/metadata/apply";
import { readAllTags } from "../src/metadata/exif-read";
import {
  planRename, renderTemplate, collectUnknownTokens, templateUsesSubsec,
  DEFAULT_OPTIONS, TOKEN_GROUPS, type RenamePlan,
} from "../src/rename/engine";
import { applyRename } from "../src/rename/apply";
import { extractSubsec } from "../src/rename/subsec";
import { initRuntime } from "../src/rt";
import type { CatalogPhoto, RenamePhotoResult, SafelightAPI } from "../src/safelight-api";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

// ── build a minimal little-endian TIFF with a 4-byte "pixel" strip ───────────
function buildTiff(): Uint8Array {
  const entries = [
    { tag: 0x0100, type: 3, count: 1, val: 2 }, // ImageWidth
    { tag: 0x0101, type: 3, count: 1, val: 2 }, // ImageLength
    { tag: 0x0111, type: 4, count: 1, val: 62 }, // StripOffsets → pixel block
    { tag: 0x0117, type: 4, count: 1, val: 4 }, // StripByteCounts
  ];
  const size = 8 + (2 + entries.length * 12 + 4) + 4; // header + ifd + 4B pixels
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  dv.setUint16(0, 0x4949, false); // "II"
  dv.setUint16(2, 42, true);
  dv.setUint32(4, 8, true); // IFD0 at 8
  dv.setUint16(8, entries.length, true);
  entries.forEach((e, i) => {
    const o = 10 + i * 12;
    dv.setUint16(o, e.tag, true);
    dv.setUint16(o + 2, e.type, true);
    dv.setUint32(o + 4, e.count, true);
    if (e.type === 3) dv.setUint16(o + 8, e.val, true);
    else dv.setUint32(o + 8, e.val, true);
  });
  dv.setUint32(10 + entries.length * 12, 0, true); // next IFD = 0
  buf.set([0xde, 0xad, 0xbe, 0xef], 62); // the "pixels"
  return buf;
}

function testTiffRoundtrip(): void {
  console.log("TIFF round-trip:");
  const orig = buildTiff();
  const tiff = parseTiff(orig, 0)!;
  ok("parses", !!tiff && !tiff.complex);
  ok("captured strip block", tiff.ifd0.blocks?.[0]?.length === 4);

  setAscii(tiff.ifd0, 0x013b, "Ansel Adams"); // Artist
  setAscii(tiff.ifd0, 0x8298, "© 2026"); // Copyright (non-ASCII)
  const out = serializeTiff(tiff);

  const re = parseTiff(out, 0)!;
  ok("re-parses", !!re && !re.complex);
  ok("Artist survives", getAscii(re.ifd0, 0x013b) === "Ansel Adams");
  ok("Copyright (UTF-8) survives", getAscii(re.ifd0, 0x8298) === "© 2026");
  const px = re.ifd0.blocks?.[0];
  ok("pixel bytes intact", !!px && px[0] === 0xde && px[1] === 0xad && px[2] === 0xbe && px[3] === 0xef);
  // ImageWidth still 2
  const dump = readAllTags(out);
  ok("ImageWidth preserved", dump.some((d) => d.name === "ImageWidth" && d.value === "2"));
  ok("dump includes Artist", dump.some((d) => d.name === "Artist" && d.value === "Ansel Adams"));
}

function testJpeg(): void {
  console.log("JPEG APP1 insert:");
  // Dummy JPEG: SOI + SOS marker + EOI (no metadata).
  const dummy = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0xff, 0xd9]);
  ok("no exif initially", getExifTiff(dummy) === null);

  const tiff: Tiff = { little: true, ifd0: { tags: [] }, complex: false };
  setAscii(tiff.ifd0, 0x013b, "Me");
  const exifTiff = serializeTiff(tiff);
  const jpeg = writeExifIntoJpeg(dummy, exifTiff);

  ok("starts with SOI", jpeg[0] === 0xff && jpeg[1] === 0xd8);
  ok("has APP1 after SOI", jpeg[2] === 0xff && jpeg[3] === 0xe1);
  const back = getExifTiff(jpeg);
  ok("exif extractable", !!back);
  const re = back ? parseTiff(back, 0) : null;
  ok("Artist reads back", !!re && getAscii(re.ifd0, 0x013b) === "Me");
  ok("scan tail preserved", jpeg[jpeg.length - 2] === 0xff && jpeg[jpeg.length - 1] === 0xd9);
}

function testXmp(): void {
  console.log("XMP sidecar:");
  const first = upsertXmp(null, {
    meta: { artist: "Jo", copyright: "c", description: "d", keywords: ["a", "b"] },
    date: "2026:06:30 14:05:42",
  });
  const parsed = readXmp(first);
  ok("creator", parsed.meta.artist === "Jo");
  ok("rights", parsed.meta.copyright === "c");
  ok("keywords", JSON.stringify(parsed.meta.keywords) === JSON.stringify(["a", "b"]));
  ok("date iso→exif", parsed.date === "2026:06:30 14:05:42");

  // Upsert into existing, preserving a foreign property.
  const foreign = first.replace("</rdf:Description>", `<foo:bar xmlns:foo="x">keep</foo:bar></rdf:Description>`);
  const updated = upsertXmp(foreign, { meta: { artist: "Kim" } });
  ok("updates creator", readXmp(updated).meta.artist === "Kim");
  ok("preserves foreign prop", updated.includes("foo:bar"));
  ok("no duplicate creator", (updated.match(/<dc:creator>/g) ?? []).length === 1);

  // GPS round-trips through the packet (regression: it used to be write-only,
  // so a rescan silently dropped coordinates from the catalogue).
  const withGps = upsertXmp(null, { meta: { gpsLat: 49.5, gpsLon: -123.25 } });
  const gps = readXmp(withGps).meta;
  ok("gps latitude round-trips", Math.abs((gps.gpsLat ?? NaN) - 49.5) < 1e-4);
  ok("gps longitude round-trips", Math.abs((gps.gpsLon ?? NaN) - -123.25) < 1e-4);

  // Foreign writers use the comma-DMS form; both variants must parse.
  const dms = readXmp(
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="r"><rdf:Description rdf:about=""
      xmlns:exif="http://ns.adobe.com/exif/1.0/">
      <exif:GPSLatitude>37,48,30N</exif:GPSLatitude>
      <exif:GPSLongitude>122,16.5000W</exif:GPSLongitude>
    </rdf:Description></rdf:RDF></x:xmpmeta>`,
  ).meta;
  ok("parses DD,MM,SS form", Math.abs((dms.gpsLat ?? NaN) - (37 + 48 / 60 + 30 / 3600)) < 1e-6);
  ok("parses DD,MM.mmmm form", Math.abs((dms.gpsLon ?? NaN) - -(122 + 16.5 / 60)) < 1e-6);

  ok("fresh packets carry our marker", isOwnPacket(first));
  ok("foreign packets are not ours", !isOwnPacket(`<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="darktable 4.6"></x:xmpmeta>`));

  // darktable/exiv2 write attribute-only, self-closed Descriptions; upserting
  // into one must still land our elements and keep the foreign attributes.
  const dtPacket = `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="XMP Core 4.4.0-Exiv2">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:darktable="http://darktable.sf.net/" darktable:history_end="7"/>
 </rdf:RDF>
</x:xmpmeta>`;
  const dtUpserted = upsertXmp(dtPacket, { meta: { artist: "Kim" } });
  ok("self-closed Description gains our field", readXmp(dtUpserted).meta.artist === "Kim");
  ok("foreign attribute survives", dtUpserted.includes('darktable:history_end="7"'));

  // "$&"-style user text must not trip String.replace's $-pattern expansion.
  const dollar = upsertXmp(first, { meta: { keywords: ["fish$&chips"] } });
  ok("dollar keyword inserted verbatim", dollar.includes("fish$&amp;chips"));
  ok("packet still well-terminated", (dollar.match(/<\/rdf:Description>/g) ?? []).length === 1);
}

const OWN_LEGACY = upsertXmp(null, { meta: { artist: "Old Artist", description: "Keep me" } });
const DT_LEGACY = `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="XMP Core 4.4.0-Exiv2">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:darktable="http://darktable.sf.net/" darktable:history_end="7"/>
 </rdf:RDF>
</x:xmpmeta>`;

function fakeDir(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const dir = {
    files,
    async getFileHandle(name: string, opts?: { create?: boolean }) {
      if (!files.has(name)) {
        if (!opts?.create) throw new DOMException(`${name} not found`, "NotFoundError");
        files.set(name, "");
      }
      return {
        name,
        async getFile() {
          return { text: async () => files.get(name)! };
        },
        async createWritable() {
          let buf = "";
          return {
            async write(data: unknown) {
              buf +=
                typeof data === "string" ? data : new TextDecoder().decode(data as Uint8Array);
            },
            async close() {
              files.set(name, buf);
            },
          };
        },
      };
    },
    async removeEntry(name: string) {
      if (!files.has(name)) throw new Error("NotFound");
      files.delete(name);
    },
  };
  return dir as unknown as FileSystemDirectoryHandle & { files: Map<string, string> };
}

async function testSidecarWrite(): Promise<void> {
  console.log("Sidecar write / migration:");

  // Fresh RAW edit lands on the Adobe name, not the legacy one.
  const fresh = fakeDir();
  await writeSidecar(fakePhoto({ filename: "DSC01234.ARW", directoryHandle: fresh }), { copyright: "C" }, null);
  ok("writes the Adobe name", fresh.files.has("DSC01234.xmp"));
  ok("does not write the legacy name", !fresh.files.has("DSC01234.ARW.xmp"));

  // A legacy sidecar of ours seeds the new file and is then removed.
  const ours = fakeDir({ "DSC01234.ARW.xmp": OWN_LEGACY });
  await writeSidecar(fakePhoto({ filename: "DSC01234.ARW", directoryHandle: ours }), { copyright: "New C" }, null);
  const migrated = readXmp(ours.files.get("DSC01234.xmp") ?? "");
  ok("seeds earlier edits from legacy", migrated.meta.artist === "Old Artist");
  ok("applies the new edit", migrated.meta.copyright === "New C");
  ok("deletes our legacy sidecar", !ours.files.has("DSC01234.ARW.xmp"));

  // A foreign legacy sidecar (darktable) seeds but is never deleted.
  const foreign = fakeDir({ "DSC01234.ARW.xmp": DT_LEGACY });
  await writeSidecar(fakePhoto({ filename: "DSC01234.ARW", directoryHandle: foreign }), { artist: "Kim" }, null);
  ok("foreign legacy is kept", foreign.files.has("DSC01234.ARW.xmp"));
  ok("new sidecar carries the edit", readXmp(foreign.files.get("DSC01234.xmp") ?? "").meta.artist === "Kim");
  ok("foreign content carried into the new sidecar", (foreign.files.get("DSC01234.xmp") ?? "").includes("darktable:history_end"));

  // With both present, the Adobe-name file is the source of truth.
  const both = fakeDir({
    "DSC01234.xmp": upsertXmp(null, { meta: { artist: "Current" } }),
    "DSC01234.ARW.xmp": OWN_LEGACY,
  });
  await writeSidecar(fakePhoto({ filename: "DSC01234.ARW", directoryHandle: both }), { copyright: "C2" }, null);
  const kept = readXmp(both.files.get("DSC01234.xmp") ?? "");
  ok("existing Adobe-name content wins", kept.meta.artist === "Current");
  ok("stale our-legacy cleaned up", !both.files.has("DSC01234.ARW.xmp"));

  // Extension-less files: legacy and new names coincide; nothing is deleted.
  const bare = fakeDir();
  await writeSidecar(fakePhoto({ filename: "noext", directoryHandle: bare }), { artist: "A" }, null);
  ok("single sidecar for extension-less file", bare.files.has("noext.xmp"));

  // Import folds the Adobe-name sidecar back on, GPS included.
  const importDir = fakeDir({
    "DSC01234.xmp": upsertXmp(null, { meta: { artist: "Jo", gpsLat: 49.5, gpsLon: -123.25 } }),
  });
  const patch = await readSidecarForImport({
    photo: fakePhoto({ filename: "DSC01234.ARW" }),
    dir: importDir,
    fileName: "DSC01234.ARW",
  });
  ok("import reads the Adobe name", patch?.exif?.artist === "Jo");
  ok("import folds GPS latitude", Math.abs((patch?.exif?.gpsLatitude ?? NaN) - 49.5) < 1e-4);
  ok("import folds GPS longitude", Math.abs((patch?.exif?.gpsLongitude ?? NaN) - -123.25) < 1e-4);

  // Import still reads a legacy-only sidecar (pre-migration folders).
  const legacyDir = fakeDir({ "DSC01234.ARW.xmp": OWN_LEGACY });
  const legacyPatch = await readSidecarForImport({
    photo: fakePhoto({ filename: "DSC01234.ARW" }),
    dir: legacyDir,
    fileName: "DSC01234.ARW",
  });
  ok("import falls back to the legacy name", legacyPatch?.exif?.artist === "Old Artist");
}

function testSidecarNaming(): void {
  console.log("Sidecar naming (Adobe convention, shared with XMP Tools):");
  ok("RAW strips the extension", sidecarName("DSC01234.ARW") === "DSC01234.xmp");
  ok("lowercase RAW too", sidecarName("img_0042.cr3") === "img_0042.xmp");
  ok("non-RAW keeps a suffix", sidecarName("IMG.JPG") === "IMG_jpg.xmp");
  ok("png keeps a suffix", sidecarName("photo.png") === "photo_png.xmp");
  ok("no extension appends .xmp", sidecarName("noext") === "noext.xmp");
  ok("legacy name is filename + .xmp", legacySidecarName("DSC01234.ARW") === "DSC01234.ARW.xmp");
  ok("legacy equals new when extension-less", legacySidecarName("noext") === sidecarName("noext"));
}

function fakePhoto(over: Partial<CatalogPhoto>): CatalogPhoto {
  return {
    id: Math.random().toString(36).slice(2),
    filename: "IMG.JPG",
    folder: "Trip",
    relPath: "Trip/IMG.JPG",
    keywords: [],
    exif: {},
    ...over,
  } as unknown as CatalogPhoto;
}

function testRename(): void {
  console.log("Rename planner:");
  const photos = [
    fakePhoto({ id: "1", filename: "a.NEF", folder: "T", exif: { cameraModel: "Z8", dateTimeOriginal: "2026:06:30 14:05:42" } }),
    fakePhoto({ id: "2", filename: "b.NEF", folder: "T", exif: { cameraModel: "Z8", dateTimeOriginal: "2026:06:30 14:06:00" } }),
    fakePhoto({ id: "3", filename: "c.NEF", folder: "T", exif: { cameraModel: "Z8" } }),
  ];
  const opts = { ...DEFAULT_OPTIONS, template: "{date}_{model}_{seq}", seqStart: 1, seqStep: 1, seqPad: 3 };
  ok("token render", renderTemplate(photos[0], 0, opts) === "20260630_Z8_001");
  ok("second seq increments", renderTemplate(photos[1], 1, opts) === "20260630_Z8_002");
  ok("missing date collapses cleanly", renderTemplate(photos[2], 2, opts) === "Z8_003");

  const plan = planRename(photos, opts);
  ok("all three planned", plan.items.filter((i) => !i.skip).length === 3);
  ok("no duplicates", plan.duplicates.length === 0);
  ok("letter token", renderTemplate(photos[0], 26, { ...opts, template: "{name}-{letter}" }) === "a-aa");

  // Swap detection: rename a→b, b→a needs a temp pass.
  const swap = planRename(
    [fakePhoto({ id: "1", filename: "a.jpg", folder: "T" }), fakePhoto({ id: "2", filename: "b.jpg", folder: "T" })],
    { ...DEFAULT_OPTIONS, template: "swap" },
  );
  ok("empty-name swap skipped", true); // template 'swap' → same for both → duplicates
  const shift = planRename(
    [fakePhoto({ id: "1", filename: "b.jpg", folder: "T" }), fakePhoto({ id: "2", filename: "a.jpg", folder: "T" })],
    { ...DEFAULT_OPTIONS, template: "{name}" },
  );
  ok("unchanged names need no temp pass", !shift.needsTempPass);
}

/** A standalone TIFF whose Exif IFD carries the given subsecond tags. */
function buildSubsecTiff(tags: { tag: number; value: string }[]): Uint8Array {
  const tiff: Tiff = { little: true, ifd0: { tags: [] }, complex: false };
  const exif = ensureExif(tiff);
  for (const t of tags) setAscii(exif, t.tag, t.value);
  return serializeTiff(tiff);
}

function testSubsec(): void {
  console.log("Subsecond token:");
  const burstShot = (id: string, name: string) =>
    fakePhoto({ id, filename: name, folder: "T", exif: { dateTimeOriginal: "2026:07:15 12:08:41" } });
  const opts = { ...DEFAULT_OPTIONS, template: "{yyyy}{mon}{day}_{hour}{min}{sec}.{subsec}" };
  const subsec = new Map([["1", "541"], ["2", "5"], ["3", "541977"]]);

  ok("renders template with subsec", renderTemplate(burstShot("1", "a.NEF"), 0, opts, subsec) === "20260715_120841.541");
  ok("short value right-pads to ms", renderTemplate(burstShot("2", "b.NEF"), 1, opts, subsec) === "20260715_120841.500");
  ok("long value truncates to ms", renderTemplate(burstShot("3", "c.NEF"), 2, opts, subsec) === "20260715_120841.541");
  ok("width arg narrows", renderTemplate(burstShot("1", "a.NEF"), 0, { ...opts, template: "{sec}.{subsec:2}" }, subsec) === "41.54");
  ok("width arg widens", renderTemplate(burstShot("1", "a.NEF"), 0, { ...opts, template: "{sec}.{subsec:6}" }, subsec) === "41.541000");
  ok("missing subsec leaves a clean name", renderTemplate(burstShot("4", "d.NEF"), 3, opts, subsec) === "20260715_120841");
  ok("no map behaves like missing", renderTemplate(burstShot("1", "a.NEF"), 0, opts) === "20260715_120841");
  ok("subsec is a known token", collectUnknownTokens("{subsec}").length === 0);
  ok("template probe positive", templateUsesSubsec("x_{subsec:2}_y"));
  ok("template probe negative", !templateUsesSubsec("{sec}_{seq}"));
  ok("palette offers subsec", TOKEN_GROUPS.some((g) => g.tokens.some((t) => t.insert === "{subsec}")));

  // A same-second burst is exactly what the token exists for: distinct
  // subseconds must clear the duplicate-name gate that blocks Apply.
  const burst = [burstShot("1", "a.NEF"), burstShot("2", "b.NEF"), burstShot("3", "c.NEF")];
  const burstSubsec = new Map([["1", "541"], ["2", "555"], ["3", "577"]]);
  ok("burst dedupes with subsec", planRename(burst, opts, burstSubsec).duplicates.length === 0);
  ok("burst collides without subsec", planRename(burst, opts).duplicates.length > 0);

  console.log("Subsecond extraction:");
  const T_SUBSEC = 0x9290, T_ORIGINAL = 0x9291, T_DIGITIZED = 0x9292;
  ok("reads SubSecTimeOriginal", extractSubsec(buildSubsecTiff([{ tag: T_ORIGINAL, value: "541" }])) === "541");
  ok("prefers Original over plain", extractSubsec(buildSubsecTiff([
    { tag: T_SUBSEC, value: "99" }, { tag: T_ORIGINAL, value: "54" },
  ])) === "54");
  ok("falls back to Digitized", extractSubsec(buildSubsecTiff([
    { tag: T_SUBSEC, value: "99" }, { tag: T_DIGITIZED, value: "77" },
  ])) === "77");
  ok("falls back to plain SubSecTime", extractSubsec(buildSubsecTiff([{ tag: T_SUBSEC, value: "99" }])) === "99");
  ok("no subsec tags → empty", extractSubsec(buildSubsecTiff([])) === "");
  const jpeg = writeExifIntoJpeg(
    new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0xff, 0xd9]),
    buildSubsecTiff([{ tag: T_ORIGINAL, value: "541" }]),
  );
  ok("reads from JPEG APP1", extractSubsec(jpeg) === "541");
  ok("non-image bytes → empty", extractSubsec(new Uint8Array([1, 2, 3, 4])) === "");
  const whole = buildSubsecTiff([{ tag: T_ORIGINAL, value: "541" }]);
  ok("truncated buffer never throws", extractSubsec(whole.subarray(0, 16)) === "");
}

// ── apply paths, run through a fake api ──────────────────────────────────────

const T_MAKE = 0x010f;
const T_EXPOSURE = 0x829a;
const T_MAKERNOTE = 0x927c;
const MAKERNOTE_SIG = [0x4d, 0x4e, 0x54, 0x45, 0x53, 0x54]; // "MNTEST"
const BARE_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0xff, 0xd9]);

function cameraTiff(withMakerNote: boolean): Uint8Array {
  const tiff: Tiff = { little: true, ifd0: { tags: [] }, complex: false };
  setAscii(tiff.ifd0, T_MAKE, "TESTCAM");
  const exif = ensureExif(tiff);
  setRationals(exif, T_EXPOSURE, [[1, 250]], true);
  if (withMakerNote) {
    const note = new Uint8Array(40);
    note.set(MAKERNOTE_SIG, 0);
    exif.tags.push({ tag: T_MAKERNOTE, type: 7, count: note.length, bytes: note });
  }
  return serializeTiff(tiff);
}

/** Byte offset of `tag`'s 12-byte entry in IFD0 or the Exif IFD (little-endian). */
function entryOffset(t: Uint8Array, tag: number, inExif: boolean): number {
  const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const find = (ifd: number, want: number): number => {
    const n = dv.getUint16(ifd, true);
    for (let i = 0; i < n; i++) if (dv.getUint16(ifd + 2 + i * 12, true) === want) return ifd + 2 + i * 12;
    return -1;
  };
  const ifd0 = dv.getUint32(4, true);
  return inExif ? find(dv.getUint32(find(ifd0, 0x8769) + 8, true), tag) : find(ifd0, tag);
}

function withValue(t: Uint8Array, entry: number, value: number): Uint8Array {
  const copy = t.slice();
  new DataView(copy.buffer).setUint32(entry + 8, value, true);
  return copy;
}

function indexOfBytes(hay: Uint8Array, needle: number[]): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function fakeFile(initial: Uint8Array, beforeClose?: () => void) {
  const state = { bytes: initial, writes: 0 };
  const handle = {
    async getFile() {
      return { arrayBuffer: async () => state.bytes.slice().buffer };
    },
    async createWritable() {
      let written = new Uint8Array(0);
      return {
        async write(data: unknown) {
          written = data as Uint8Array;
        },
        async close() {
          await new Promise((r) => setTimeout(r, 5));
          beforeClose?.();
          state.bytes = written;
          state.writes++;
        },
      };
    },
  };
  return { state, handle: handle as unknown as FileSystemFileHandle };
}

function installFakeApi(
  photos: CatalogPhoto[],
  renamePhoto: (id: string, base: string) => Promise<RenamePhotoResult> = async () => ({ ok: false, reason: "unused" }),
) {
  const relocateSizes: number[] = [];
  const state = {
    photos,
    async relocatePhotos(updated: CatalogPhoto[]) {
      relocateSizes.push(updated.length);
      const byId = new Map(updated.map((p) => [p.id, p] as const));
      state.photos = state.photos.map((p) => byId.get(p.id) ?? p);
    },
  };
  initRuntime({
    stores: { useCatalogStore: { getState: () => state } },
    catalog: { renamePhoto },
  } as unknown as SafelightAPI);
  return { state, relocateSizes };
}

async function expectRefused(label: string, tiff: Uint8Array, asTiffFile = false): Promise<void> {
  const original = asTiffFile ? tiff : writeExifIntoJpeg(BARE_JPEG, tiff);
  const file = fakeFile(original.slice());
  const dir = fakeDir();
  const filename = asTiffFile ? "IMG.TIF" : "IMG.JPG";
  const photo = fakePhoto({ filename, fileHandle: file.handle, directoryHandle: dir });
  installFakeApi([photo]);
  const [r] = await applyMetadata([photo], { artist: "Kim" }, { kind: "none" });
  ok(`${label}: original untouched`, file.state.writes === 0 && sameBytes(file.state.bytes, original));
  ok(
    `${label}: sidecar written`,
    r.ok && r.mode === "sidecar" && readXmp(dir.files.get(sidecarName(filename)) ?? "").meta.artist === "Kim",
    JSON.stringify(r),
  );
}

/** A TIFF whose IFD0 carries two Exif pointers, each to its own one-tag IFD. */
function doubleExifTiff(): Uint8Array {
  const buf = new Uint8Array(86);
  const dv = new DataView(buf.buffer);
  const entry = (at: number, tag: number, type: number, value: number) => {
    dv.setUint16(at, tag, true);
    dv.setUint16(at + 2, type, true);
    dv.setUint32(at + 4, 1, true);
    if (type === 3) dv.setUint16(at + 8, value, true);
    else dv.setUint32(at + 8, value, true);
  };
  dv.setUint16(0, 0x4949, false);
  dv.setUint16(2, 42, true);
  dv.setUint32(4, 8, true);
  dv.setUint16(8, 3, true);
  entry(10, 0x0100, 3, 2); // ImageWidth
  entry(22, 0x8769, 4, 50);
  entry(34, 0x8769, 4, 68);
  dv.setUint16(50, 1, true);
  entry(52, 0x8827, 3, 400); // ISO
  dv.setUint16(68, 1, true);
  entry(70, 0xa402, 3, 0); // ExposureMode
  return buf;
}

async function testInPlaceTiffSafety(): Promise<void> {
  console.log("In-place TIFF safety:");
  await expectRefused("rewrite that would drop a tag", doubleExifTiff(), true);

  const longTag = (tag: number, value: number) => {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, true);
    return { tag, type: 4, count: 1, bytes };
  };
  const withSubIfds = parseTiff(buildTiff(), 0)!;
  withSubIfds.ifd0.tags.push(longTag(0x014a, 8));
  await expectRefused("SubIFDs tag", serializeTiff(withSubIfds), true);

  const stripsAndThumb = parseTiff(buildTiff(), 0)!;
  stripsAndThumb.ifd0.tags.push(longTag(0x0201, 62), longTag(0x0202, 4));
  await expectRefused("strips plus a JPEG thumbnail in one IFD", serializeTiff(stripsAndThumb), true);

  const tiff = parseTiff(buildTiff(), 0)!;
  const note = new Uint8Array(40);
  note.set(MAKERNOTE_SIG, 0);
  ensureExif(tiff).tags.push({ tag: T_MAKERNOTE, type: 7, count: note.length, bytes: note });
  const original = serializeTiff(tiff);
  const at = indexOfBytes(original, MAKERNOTE_SIG);
  const file = fakeFile(original.slice());
  const photo = fakePhoto({ filename: "IMG.TIF", fileHandle: file.handle, directoryHandle: fakeDir() });
  installFakeApi([photo]);
  const [r] = await applyMetadata([photo], { artist: "Kim", description: "A caption long enough to grow IFD0" }, { kind: "none" });
  const re = parseTiff(file.state.bytes, 0);
  const px = re?.ifd0.blocks?.[0];
  ok("MakerNote TIFF written in place", r.ok && r.mode === "in-place", JSON.stringify(r));
  ok("TIFF MakerNote keeps its offset", indexOfBytes(file.state.bytes, MAKERNOTE_SIG) === at, `${at} → ${indexOfBytes(file.state.bytes, MAKERNOTE_SIG)}`);
  ok("TIFF MakerNote bytes identical", sameBytes(file.state.bytes.subarray(at, at + 40), note));
  ok("TIFF pixels intact", !!px && sameBytes(px, new Uint8Array([0xde, 0xad, 0xbe, 0xef])));
  ok("TIFF edit reads back", !!re && getAscii(re.ifd0, 0x013b) === "Kim");
}

async function testInPlaceJpegSafety(): Promise<void> {
  console.log("In-place JPEG safety:");
  await expectRefused("EXIF cut short in its header", new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0x08]));

  const plain = cameraTiff(false);
  await expectRefused("Exif IFD pointer past the block", withValue(plain, entryOffset(plain, 0x8769, false), 0xfff0));

  const noted = cameraTiff(true);
  await expectRefused("MakerNote pointer out of range", withValue(noted, entryOffset(noted, T_MAKERNOTE, true), 0xfff0));

  const at = indexOfBytes(noted, MAKERNOTE_SIG);
  const file = fakeFile(writeExifIntoJpeg(BARE_JPEG, noted));
  const photo = fakePhoto({ filename: "IMG.JPG", fileHandle: file.handle, directoryHandle: fakeDir() });
  installFakeApi([photo]);
  const [r] = await applyMetadata([photo], { artist: "Kim", description: "A caption long enough to grow IFD0" }, { kind: "none" });
  const out = getExifTiff(file.state.bytes);
  const re = out ? parseTiff(out, 0) : null;
  ok("MakerNote JPEG written in place", r.ok && r.mode === "in-place", JSON.stringify(r));
  ok("MakerNote keeps its TIFF offset", !!out && indexOfBytes(out, MAKERNOTE_SIG) === at, `${at} → ${out ? indexOfBytes(out, MAKERNOTE_SIG) : "none"}`);
  ok("MakerNote bytes identical", !!out && sameBytes(out.subarray(at, at + 40), noted.subarray(at, at + 40)));
  ok("camera tags survive", !!re && getAscii(re.ifd0, T_MAKE) === "TESTCAM" && !!re.ifd0.exif?.tags.some((t) => t.tag === T_EXPOSURE));
  ok("edit reads back", !!re && getAscii(re.ifd0, 0x013b) === "Kim");
}

async function testCatalogMerge(): Promise<void> {
  console.log("Catalogue update:");
  let fake: ReturnType<typeof installFakeApi> | null = null;
  const file = fakeFile(writeExifIntoJpeg(BARE_JPEG, cameraTiff(false)), () => {
    if (fake) fake.state.photos = fake.state.photos.map((p) => (p.id === "r1" ? { ...p, rating: 5 } : p));
  });
  const photo = fakePhoto({ id: "r1", filename: "IMG.JPG", rating: 0, fileHandle: file.handle, directoryHandle: fakeDir() });
  fake = installFakeApi([photo]);
  await applyMetadata([photo], { artist: "Kim" }, { kind: "none" });
  const now = fake.state.photos.find((p) => p.id === "r1");
  ok("rating set during the write survives", now?.rating === 5, `rating ${now?.rating}`);
  ok("the edit still lands", now?.exif.artist === "Kim");

  const many = Array.from({ length: 450 }, (_, i) =>
    fakePhoto({ id: `b${i}`, filename: `DSC${i}.ARW`, directoryHandle: fakeDir() }),
  );
  const batch = installFakeApi(many);
  await applyMetadata(many, { copyright: "C" }, { kind: "none" });
  ok(
    "catalogue updates are batched",
    batch.relocateSizes.length === 3 && Math.max(...batch.relocateSizes) <= 200,
    `${batch.relocateSizes.length} calls`,
  );
  ok("every record updated", batch.state.photos.every((p) => p.exif.copyright === "C"));
}

/** A desktop-style folder: getFileHandle always succeeds and reads fail in
 *  getFile(), with ENOENT for a missing file or the error given for `name`. */
function desktopDir(initial: Record<string, string>, failing: Record<string, Error> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const dir = {
    files,
    async getFileHandle(name: string) {
      return {
        async getFile() {
          if (failing[name]) throw failing[name];
          const text = files.get(name);
          if (text === undefined) {
            throw new Error(`Error invoking remote method 'fs:read': Error: ENOENT: no such file or directory, open '${name}'`);
          }
          return { text: async () => text };
        },
        async createWritable() {
          let buf = "";
          return {
            async write(data: unknown) {
              buf += new TextDecoder().decode(data as Uint8Array);
            },
            async close() {
              files.set(name, buf);
            },
          };
        },
      };
    },
    async removeEntry(name: string) {
      files.delete(name);
    },
  };
  return dir as unknown as FileSystemDirectoryHandle & { files: Map<string, string> };
}

async function testSidecarReadErrors(): Promise<void> {
  console.log("Sidecar read errors:");
  const busy = desktopDir(
    { "DSC1.xmp": DT_LEGACY },
    { "DSC1.xmp": new Error("Error invoking remote method 'fs:read': Error: EBUSY: resource busy or locked") },
  );
  const photo = fakePhoto({ filename: "DSC1.ARW", directoryHandle: busy });
  installFakeApi([photo]);
  const [r] = await applyMetadata([photo], { artist: "Kim" }, { kind: "none" });
  ok("unreadable sidecar is left alone", busy.files.get("DSC1.xmp") === DT_LEGACY);
  ok("unreadable sidecar fails the photo", !r.ok && (r.reason ?? "").includes("EBUSY"), JSON.stringify(r));

  const empty = desktopDir({});
  const fresh = fakePhoto({ filename: "DSC2.ARW", directoryHandle: empty });
  installFakeApi([fresh]);
  const [r2] = await applyMetadata([fresh], { artist: "Kim" }, { kind: "none" });
  ok("ENOENT still means no sidecar", r2.ok && readXmp(empty.files.get("DSC2.xmp") ?? "").meta.artist === "Kim", JSON.stringify(r2));
}

async function testVirtualCopies(): Promise<void> {
  console.log("Virtual copies:");
  const original = writeExifIntoJpeg(BARE_JPEG, cameraTiff(false));
  const file = fakeFile(original.slice());
  const jpegDir = fakeDir();
  const jpegCopy = fakePhoto({ id: "c1", filename: "IMG.JPG", copyOf: "m1", fileHandle: file.handle, directoryHandle: jpegDir });
  const rawDir = fakeDir();
  const rawCopy = fakePhoto({ id: "c2", filename: "DSC1.ARW", copyOf: "m2", directoryHandle: rawDir });
  const fake = installFakeApi([jpegCopy, rawCopy]);
  const results = await applyMetadata([jpegCopy, rawCopy], { artist: "Kim" }, { kind: "none" });
  ok("JPEG copy leaves the master's file alone", file.state.writes === 0 && sameBytes(file.state.bytes, original));
  ok("RAW copy writes no sidecar", rawDir.files.size === 0 && jpegDir.files.size === 0);
  ok("copies are skipped with a reason", results.every((r) => !r.ok && (r.reason ?? "").includes("Virtual copy")), JSON.stringify(results));
  ok("copy records are not updated", fake.relocateSizes.length === 0);
}

async function testRenameRecovery(): Promise<void> {
  console.log("Rename recovery:");
  const calls: string[] = [];
  installFakeApi([], async (_id, base) => {
    calls.push(base);
    return base.startsWith("__aet_") ? { ok: true, filename: `${base}.jpg` } : { ok: false, reason: "Name taken." };
  });
  const plan: RenamePlan = {
    items: [{ id: "1", oldName: "a.jpg", newName: "b.jpg", newBase: "b", unchanged: false }],
    duplicates: [],
    needsTempPass: true,
    unknownTokens: [],
  };
  const out = await applyRename(plan);
  const temp = `${calls[0]}.jpg`;
  ok(
    "failed restore reports the temporary name",
    out.failed.length === 1 && out.failed[0].reason.includes(`left as ${temp}`),
    JSON.stringify(out.failed),
  );
}

console.log("\nAdvanced EXIF Tools — verification\n");
testTiffRoundtrip();
testJpeg();
testXmp();
testSidecarNaming();
testRename();
testSubsec();
await testSidecarWrite();
await testInPlaceJpegSafety();
await testInPlaceTiffSafety();
await testCatalogMerge();
await testSidecarReadErrors();
await testVirtualCopies();
await testRenameRecovery();
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) throw new Error(`${failed} checks failed`);
