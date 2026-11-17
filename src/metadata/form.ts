// The metadata editor's text fields as one flat form, plus metadata templates:
// named sets of filled-in fields applied to a selection. Pure, so the panel and
// the tests share it.

import type { EditableMeta } from "./model";
import { IPTC_FIELDS, type IptcKey, type IptcValues } from "./iptc";

export type FormKey = "artist" | "copyright" | "description" | "keywords" | IptcKey;

export type FormValues = Record<FormKey, string>;

/** Fields the user changed in this edit: only these are written. */
export type FormTouched = Partial<Record<FormKey, boolean>>;

export interface MetadataTemplate {
  name: string;
  values: Partial<FormValues>;
}

const BASE_KEYS = ["artist", "copyright", "description", "keywords"] as const;

export const FORM_KEYS: readonly FormKey[] = [...BASE_KEYS, ...IPTC_FIELDS.map((f) => f.key)];

export function emptyForm(): FormValues {
  return Object.fromEntries(FORM_KEYS.map((k) => [k, ""])) as FormValues;
}

export function parseKeywords(s: string): string[] {
  const seen = new Set<string>();
  for (const raw of s.split(/[,\n]/)) {
    const k = raw.trim();
    if (k) seen.add(k);
  }
  return [...seen];
}

/** The touched fields as edits; a touched empty field clears its tag. */
export function formToEdits(values: FormValues, touched: FormTouched): EditableMeta {
  const edits: EditableMeta = {};
  if (touched.artist) edits.artist = values.artist;
  if (touched.copyright) edits.copyright = values.copyright;
  if (touched.description) edits.description = values.description;
  if (touched.keywords) edits.keywords = parseKeywords(values.keywords);
  const iptc: IptcValues = {};
  for (const f of IPTC_FIELDS) {
    if (touched[f.key]) iptc[f.key] = values[f.key];
  }
  if (Object.keys(iptc).length) edits.iptc = iptc;
  return edits;
}

/** A template of every field that has a value. */
export function templateFromForm(name: string, values: Partial<FormValues>): MetadataTemplate {
  const kept: Partial<FormValues> = {};
  for (const k of FORM_KEYS) {
    const v = values[k];
    if (v && v.trim()) kept[k] = v;
  }
  return { name: name.trim(), values: kept };
}

/** The form with the template's fields filled in and marked touched; the
 *  fields it doesn't carry keep their value and state. */
export function applyTemplate(
  values: FormValues,
  touched: FormTouched,
  template: MetadataTemplate,
): { values: FormValues; touched: FormTouched } {
  const nextValues = { ...values };
  const nextTouched = { ...touched };
  for (const k of FORM_KEYS) {
    const v = template.values[k];
    if (v === undefined) continue;
    nextValues[k] = v;
    nextTouched[k] = true;
  }
  return { values: nextValues, touched: nextTouched };
}

const sameName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;

/** `list` with `template` added, replacing one of the same name in any case,
 *  sorted by name. */
export function upsertTemplate(list: MetadataTemplate[], template: MetadataTemplate): MetadataTemplate[] {
  return [...list.filter((t) => !sameName(t.name, template.name)), template].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

export function removeTemplate(list: MetadataTemplate[], name: string): MetadataTemplate[] {
  return list.filter((t) => !sameName(t.name, name));
}
