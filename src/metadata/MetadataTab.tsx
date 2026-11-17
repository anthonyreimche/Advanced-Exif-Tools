// The Metadata tab: a batch-capable editor for the high-value writable fields
// (creator, copyright, caption, keywords, capture time, GPS) and the IPTC Core
// fields, with metadata templates, over a full-tag EXIF inspector for the
// active photo.

import { React, api, ui } from "../rt";
import { useSelectedPhotos, Hint, Notice } from "../ui";
import { type EditableMeta, type DateOp, formatExifDate, currentMeta } from "./model";
import { applyMetadata, readIptc, type WriteResult } from "./apply";
import { readAllTags, type DumpEntry } from "./exif-read";
import { IPTC_FIELDS, IPTC_GROUPS, COPYRIGHT_STATUS_OPTIONS, type IptcGroup, type IptcFieldDef } from "./iptc";
import {
  type FormKey, type FormValues, type FormTouched, type MetadataTemplate,
  emptyForm, formToEdits, templateFromForm, applyTemplate, upsertTemplate, removeTemplate,
} from "./form";

type DateMode = "none" | "set" | "shift";

const TEMPLATES_KEY = "metadata.templates";

/** Accept EXIF, ISO, or datetime-local forms → EXIF "YYYY:MM:DD HH:MM:SS". */
function toExifDate(s: string): string | null {
  const m = s.match(/(\d{4})\D(\d{1,2})\D(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
  return Number.isNaN(d.getTime()) ? null : formatExifDate(d);
}

const READ_LIMIT = 1 << 20; // EXIF/IFD0 sit near the file start

export function MetadataTab(): React.ReactElement {
  const { Button, TextInput, TextArea, NumberInput, SegmentedControl, Select, Section, Field, Row, Stack, ProgressBar, Toggle, tokens } = ui;
  const targets = useSelectedPhotos();
  const single = targets.length === 1;
  const firstId = targets[0]?.id;

  // ── editor state ──
  const [values, setValues] = React.useState<FormValues>(emptyForm);
  const [touched, setTouched] = React.useState<FormTouched>({});
  const touchedRef = React.useRef(touched);
  touchedRef.current = touched;
  const [group, setGroup] = React.useState<IptcGroup>("content");
  const [iptcErr, setIptcErr] = React.useState<string | null>(null);
  const [dateMode, setDateMode] = React.useState<DateMode>("none");
  const [dateSet, setDateSet] = React.useState("");
  const [shiftH, setShiftH] = React.useState(0);
  const [shiftM, setShiftM] = React.useState(0);
  const [gpsOn, setGpsOn] = React.useState(false);
  const [lat, setLat] = React.useState(0);
  const [lon, setLon] = React.useState(0);

  const [templates, setTemplates] = React.useState<MetadataTemplate[]>(() =>
    api.settings.get<MetadataTemplate[]>(TEMPLATES_KEY, []),
  );
  const [templateName, setTemplateName] = React.useState("");

  const [applying, setApplying] = React.useState(false);
  const [prog, setProg] = React.useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = React.useState<WriteResult[] | null>(null);

  const setField = (k: FormKey, v: string) => {
    setValues((prev) => ({ ...prev, [k]: v }));
    setTouched((t) => (t[k] ? t : { ...t, [k]: true }));
  };

  // Prefill from the single active photo; clear for a multi-selection so a batch
  // edit only writes fields the user deliberately fills in. IPTC fields arrive
  // from the sidecar a moment later and never overwrite what was typed since.
  React.useEffect(() => {
    let cancelled = false;
    setTouched({});
    setResults(null);
    setIptcErr(null);
    setDateMode("none");
    setGpsOn(false);
    const p = targets[0];
    if (single && p) {
      const m = currentMeta(p);
      setValues({
        ...emptyForm(),
        artist: m.artist ?? "",
        copyright: m.copyright ?? "",
        description: m.description ?? "",
        keywords: (m.keywords ?? []).join(", "),
      });
      setDateSet(p.exif.dateTimeOriginal ?? "");
      setLat(m.gpsLat ?? 0);
      setLon(m.gpsLon ?? 0);
      readIptc(p).then(
        (iptc) => {
          if (cancelled) return;
          setValues((prev) => {
            const next = { ...prev };
            for (const f of IPTC_FIELDS) {
              if (!touchedRef.current[f.key]) next[f.key] = iptc[f.key] ?? "";
            }
            return next;
          });
        },
        (e: unknown) => {
          if (!cancelled) setIptcErr(e instanceof Error ? e.message : String(e));
        },
      );
    } else {
      setValues(emptyForm());
      setDateSet("");
      setLat(0);
      setLon(0);
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstId, targets.length]);

  // ── inspector state ──
  const [dump, setDump] = React.useState<DumpEntry[] | null>(null);
  const [dumpErr, setDumpErr] = React.useState<string | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    setDump(null);
    setDumpErr(null);
    const p = targets[0];
    if (!p?.fileHandle) return;
    (async () => {
      try {
        const file = await p.fileHandle!.getFile();
        const buf = new Uint8Array(await file.slice(0, READ_LIMIT).arrayBuffer());
        const rows = readAllTags(buf);
        if (!cancelled) setDump(rows);
      } catch (e) {
        if (!cancelled) setDumpErr(e instanceof Error ? e.message : "Could not read metadata");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [firstId]);

  // ── templates ──
  const storeTemplates = (next: MetadataTemplate[]) => {
    setTemplates(next);
    api.settings.set(TEMPLATES_KEY, next);
  };
  const savedTemplate = templates.find((t) => t.name.toLowerCase() === templateName.trim().toLowerCase());
  const saveTemplate = () => {
    const tpl = templateFromForm(templateName, values);
    if (tpl.name) storeTemplates(upsertTemplate(templates, tpl));
  };
  const deleteTemplate = () => {
    storeTemplates(removeTemplate(templates, templateName.trim()));
    setTemplateName("");
  };
  const loadTemplate = (name: string) => {
    const tpl = templates.find((t) => t.name === name);
    if (!tpl) return;
    const next = applyTemplate(values, touched, tpl);
    setValues(next.values);
    setTouched(next.touched);
    setTemplateName(name);
  };

  const buildEdits = (): EditableMeta => {
    const edits = formToEdits(values, touched);
    if (gpsOn) {
      edits.gpsLat = lat;
      edits.gpsLon = lon;
    }
    return edits;
  };

  const buildDateOp = (): DateOp => {
    if (dateMode === "set") {
      const v = toExifDate(dateSet);
      return v ? { kind: "set", value: v } : { kind: "none" };
    }
    if (dateMode === "shift") return { kind: "shift", seconds: (shiftH * 60 + shiftM) * 60 };
    return { kind: "none" };
  };

  const edits = buildEdits();
  const dateOp = buildDateOp();
  const nothing = Object.keys(edits).length === 0 && dateOp.kind === "none";
  const dateInvalid = dateMode === "set" && dateSet.trim() !== "" && toExifDate(dateSet) === null;
  const canApply = targets.length > 0 && !nothing && !dateInvalid && !applying;

  const run = async () => {
    setApplying(true);
    setResults(null);
    try {
      const r = await applyMetadata(targets, buildEdits(), buildDateOp(), (p) =>
        setProg({ done: p.done, total: p.total }),
      );
      setResults(r);
    } finally {
      setApplying(false);
      setProg(null);
    }
  };

  const inPlace = results?.filter((r) => r.ok && r.mode === "in-place").length ?? 0;
  const sidecar = results?.filter((r) => r.ok && r.mode === "sidecar").length ?? 0;
  const failed = results?.filter((r) => !r.ok) ?? [];
  const keep = single ? "" : "(leave unchanged)";

  const iptcInput = (f: IptcFieldDef) => {
    if (f.form === "marked") {
      const options = keep && !touched[f.key]
        ? COPYRIGHT_STATUS_OPTIONS.map((o) => (o.value ? o : { ...o, label: keep }))
        : COPYRIGHT_STATUS_OPTIONS;
      return <Select value={values[f.key]} onChange={(v) => setField(f.key, v)} options={options} />;
    }
    return f.multiline ? (
      <TextArea value={values[f.key]} onChange={(v) => setField(f.key, v)} rows={2} placeholder={keep} />
    ) : (
      <TextInput value={values[f.key]} onChange={(v) => setField(f.key, v)} placeholder={keep} />
    );
  };
  const groupTouched = (g: IptcGroup) => IPTC_FIELDS.some((f) => f.group === g && touched[f.key]);

  return (
    <Stack gap={12}>
      <Section title={targets.length > 1 ? `Edit metadata (${targets.length} photos)` : "Edit metadata"}>
        <Stack gap={8}>
          {targets.length === 0 && <Hint>Select one or more photos in the grid.</Hint>}
          {targets.length > 1 && <Hint>Only the fields you change are written. Empty a field to clear it.</Hint>}

          <Field label="Creator">
            <TextInput value={values.artist} onChange={(v) => setField("artist", v)} placeholder={keep} />
          </Field>
          <Field label="Copyright">
            <TextInput value={values.copyright} onChange={(v) => setField("copyright", v)} placeholder={keep} />
          </Field>
          <Field label="Caption / description">
            <TextArea value={values.description} onChange={(v) => setField("description", v)} rows={2} placeholder={keep} />
          </Field>
          <Field label="Keywords" hint="Comma-separated. Kept in the catalogue and .xmp sidecars, not written into JPEG or TIFF files.">
            <TextArea value={values.keywords} onChange={(v) => setField("keywords", v)} rows={2} placeholder={single ? "sunset, coast" : keep} />
          </Field>

          <Field label="IPTC" hint="Kept in the .xmp sidecar for every format; the original file is never changed for these.">
            <Stack gap={8}>
              <SegmentedControl
                value={group}
                onChange={(v) => setGroup(v as IptcGroup)}
                options={IPTC_GROUPS.map((g) => ({ value: g.value, label: groupTouched(g.value) ? `${g.label} •` : g.label }))}
              />
              {IPTC_FIELDS.filter((f) => f.group === group).map((f) => (
                <Field key={f.key} label={f.label}>{iptcInput(f)}</Field>
              ))}
              {iptcErr && <Notice tone="warn">{iptcErr}</Notice>}
            </Stack>
          </Field>
          <Hint>
            Text fields take the rename tokens, filled in for each photo: {"{date}"}, {"{yyyy}"}, {"{mon}"}, {"{day}"}, {"{name}"},
            {" {seq}"}, {"{folder}"}, {"{make}"}, {"{model}"}, {"{lens}"}…
          </Hint>

          <Field label="Capture time">
            <Stack gap={6}>
              <SegmentedControl
                value={dateMode}
                onChange={(v) => setDateMode(v as DateMode)}
                options={[
                  { value: "none", label: "Leave" },
                  { value: "set", label: "Set" },
                  { value: "shift", label: "Shift" },
                ]}
              />
              {dateMode === "set" && (
                <TextInput value={dateSet} onChange={setDateSet} style={{ fontFamily: tokens.fontMono }} placeholder="YYYY:MM:DD HH:MM:SS" />
              )}
              {dateMode === "set" && dateInvalid && <Notice tone="danger">Use the form YYYY:MM:DD HH:MM:SS.</Notice>}
              {dateMode === "shift" && (
                <Row gap={10}>
                  <Field label="Hours"><NumberInput value={shiftH} onChange={setShiftH} min={-72} max={72} step={1} width={64} /></Field>
                  <Field label="Minutes"><NumberInput value={shiftM} onChange={setShiftM} min={-59} max={59} step={1} width={64} /></Field>
                </Row>
              )}
            </Stack>
          </Field>

          <Field label="GPS">
            <Stack gap={6}>
              <Toggle checked={gpsOn} onChange={setGpsOn} label="Set coordinates" />
              {gpsOn && (
                <Row gap={10}>
                  <Field label="Latitude"><NumberInput value={lat} onChange={setLat} min={-90} max={90} step={0.0001} width={100} /></Field>
                  <Field label="Longitude"><NumberInput value={lon} onChange={setLon} min={-180} max={180} step={0.0001} width={100} /></Field>
                </Row>
              )}
            </Stack>
          </Field>

          {prog && <ProgressBar value={prog.total ? prog.done / prog.total : 0} />}
          {results && (
            <Notice tone={failed.length ? "warn" : "ok"}>
              Wrote {inPlace} in place{sidecar ? `, ${sidecar} to sidecar` : ""}
              {failed.length ? `, ${failed.length} failed: ${failed.slice(0, 2).map((f) => f.reason).join("; ")}` : "."}
              {results.some((r) => r.mode === "sidecar" && r.reason?.startsWith("In-place")) && (
                <div style={{ marginTop: 4, color: tokens.textMuted }}>Some files couldn't be edited in place and got an .xmp sidecar.</div>
              )}
            </Notice>
          )}

          <Button variant="primary" full disabled={!canApply} onClick={run}>
            {applying ? "Writing…" : `Apply to ${targets.length || ""} photo${targets.length === 1 ? "" : "s"}`}
          </Button>
        </Stack>
      </Section>

      <Section title="Templates">
        <Stack gap={6}>
          <Select
            value=""
            onChange={loadTemplate}
            placeholder={templates.length ? "Fill in from a template…" : "No templates yet"}
            disabled={templates.length === 0}
            options={templates.map((t) => ({ value: t.name, label: t.name }))}
          />
          <Row gap={6}>
            <div style={{ flex: 1 }}>
              <TextInput value={templateName} onChange={setTemplateName} placeholder="Save filled-in fields as…" />
            </div>
            <Button size="sm" onClick={saveTemplate} disabled={!templateName.trim()}>
              {savedTemplate ? "Update" : "Save"}
            </Button>
            {savedTemplate && (
              <Button size="sm" variant="danger" onClick={deleteTemplate}>Delete</Button>
            )}
          </Row>
          <Hint>A template fills in its fields; Apply writes them. Tokens such as {"{date}"} stay tokens until then.</Hint>
        </Stack>
      </Section>

      <Section title={single ? "Inspector" : "Inspector (first selected)"}>
        {targets.length === 0 && <Hint>Nothing selected.</Hint>}
        {targets.length > 0 && dumpErr && <Notice tone="warn">{dumpErr}</Notice>}
        {targets.length > 0 && !dumpErr && dump === null && <Hint>Reading…</Hint>}
        {dump !== null && dump.length === 0 && <Hint>No EXIF metadata found in this file.</Hint>}
        {dump !== null && dump.length > 0 && <TagDump rows={dump} />}
      </Section>
    </Stack>
  );
}

function TagDump({ rows }: { rows: DumpEntry[] }): React.ReactElement {
  const { tokens } = ui;
  const groups = React.useMemo(() => {
    const byIfd = new Map<string, DumpEntry[]>();
    for (const r of rows) {
      const arr = byIfd.get(r.ifd) ?? [];
      arr.push(r);
      byIfd.set(r.ifd, arr);
    }
    return [...byIfd.entries()];
  }, [rows]);

  return (
    <div style={{ maxHeight: 260, overflow: "auto", border: `1px solid ${tokens.borderSubtle}`, borderRadius: 6 }}>
      {groups.map(([ifd, entries]) => (
        <div key={ifd}>
          <div style={{ position: "sticky", top: 0, background: tokens.surface2, color: tokens.textSecondary, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, padding: "3px 8px", borderBottom: `1px solid ${tokens.borderSubtle}` }}>
            {ifd}
          </div>
          {entries.map((e) => (
            <div key={`${ifd}-${e.tag}`} style={{ display: "flex", gap: 8, padding: "2px 8px", fontSize: 11, borderBottom: `1px solid ${tokens.surface1}` }}>
              <span style={{ color: tokens.textMuted, minWidth: 130, flexShrink: 0 }}>{e.name}</span>
              <span style={{ color: tokens.textPrimary, fontFamily: tokens.fontMono, wordBreak: "break-word" }}>{e.value}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
