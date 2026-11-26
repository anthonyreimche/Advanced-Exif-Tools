// Export processor: embeds the photo's IPTC metadata into exported JPEGs as an
// XMP packet and IPTC-IIM, the two forms picture desks and wire services read.
// Off unless turned on in the Export panel, like core's own metadata option.

import type { CatalogPhoto, ExportProcessorField } from "../safelight";
import type { EditableMeta } from "./model";
import { readIptc } from "./apply";
import { buildIim } from "./iptc";
import { embedIptcInJpeg } from "./jpeg";
import { upsertXmp } from "./xmp";

export const EXPORT_SETTINGS: ExportProcessorField[] = [
  {
    key: "embed",
    label: "Embed IPTC metadata",
    hint: "JPEG only: creator, copyright, caption and the IPTC fields from the Metadata tab, as XMP and IPTC-IIM.",
    type: "boolean",
    default: false,
  },
  {
    key: "keywords",
    label: "Include keywords",
    type: "boolean",
    default: true,
  },
];

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

/** What the export carries: creator, copyright and caption as the catalogue
 *  holds them, keywords if asked, and the IPTC fields from the sidecar. */
async function exportMeta(photo: CatalogPhoto, keywords: boolean): Promise<EditableMeta> {
  const meta: EditableMeta = {};
  if (photo.exif.artist) meta.artist = photo.exif.artist;
  if (photo.exif.copyright) meta.copyright = photo.exif.copyright;
  if (photo.exif.imageDescription) meta.description = photo.exif.imageDescription;
  if (keywords && photo.keywords?.length) meta.keywords = [...photo.keywords];
  const iptc = await readIptc(photo);
  if (Object.keys(iptc).length) meta.iptc = iptc;
  return meta;
}

/** `blob` with the photo's IPTC metadata embedded, or `blob` itself when the
 *  option is off, the export isn't a JPEG, or there is nothing to embed. A
 *  failure keeps the export as it was rather than failing it. */
export async function embedForExport(
  blob: Blob,
  photo: CatalogPhoto,
  settings: Record<string, unknown>,
): Promise<Blob> {
  if (settings.embed !== true) return blob;
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!isJpeg(bytes)) return blob;
    const meta = await exportMeta(photo, settings.keywords !== false);
    if (Object.keys(meta).length === 0) return blob;
    const out = embedIptcInJpeg(bytes, upsertXmp(null, { meta }), buildIim(meta));
    return new Blob([out as BlobPart], { type: blob.type || "image/jpeg" });
  } catch (e) {
    console.warn(`[Advanced EXIF Tools] IPTC not embedded in ${photo.filename}:`, e);
    return blob;
  }
}
