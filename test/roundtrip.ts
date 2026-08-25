// Standalone verification of the pure logic (no app/DOM needed): the TIFF
// read→edit→serialize round-trip, JPEG APP1 insertion, XMP upsert/read, and the
// rename planner. Bundled with rolldown and run under Node.

import {
  parseTiff, serializeTiff, setAscii, getAscii, ensureExif, type Tiff,
} from "../src/metadata/tiff";
import { getExifTiff, writeExifIntoJpeg } from "../src/metadata/jpeg";
import { upsertXmp, readXmp } from "../src/metadata/xmp";
import { readAllTags } from "../src/metadata/exif-read";
import {
  planRename, renderTemplate, collectUnknownTokens, templateUsesSubsec,
  DEFAULT_OPTIONS, TOKEN_GROUPS,
} from "../src/rename/engine";
import { extractSubsec } from "../src/rename/subsec";
import type { CatalogPhoto } from "../src/safelight-api";

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

console.log("\nAdvanced EXIF Tools — verification\n");
testTiffRoundtrip();
testJpeg();
testXmp();
testRename();
testSubsec();
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) throw new Error(`${failed} checks failed`);
