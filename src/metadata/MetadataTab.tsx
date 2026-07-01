// The Metadata tab: a batch-capable editor for the high-value writable fields
// (creator, copyright, caption, keywords, capture time, GPS) over a full-tag
// EXIF inspector for the active photo.

import { React, ui } from "../rt";
import { useSelectedPhotos, Hint, Notice } from "../ui";
import { type EditableMeta, type DateOp, formatExifDate, currentMeta } from "./model";
import { applyMetadata, type WriteResult } from "./apply";
import { readAllTags, type DumpEntry } from "./exif-read";

type DateMode = "none" | "set" | "shift";

function parseKeywords(s: string): string[] {
  const seen = new Set<string>();
  for (const raw of s.split(/[,\n]/)) {
    const k = raw.trim();
    if (k) seen.add(k);
  }
  return [...seen];
}

/** Accept EXIF, ISO, or datetime-local forms → EXIF "YYYY:MM:DD HH:MM:SS". */
function toExifDate(s: string): string | null {
  const m = s.match(/(\d{4})\D(\d{1,2})\D(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
  return Number.isNaN(d.getTime()) ? null : formatExifDate(d);
}

const READ_LIMIT = 1 << 20; // EXIF/IFD0 sit near the file start

export function MetadataTab(): React.ReactElement {
  const { Button, TextInput, TextArea, NumberInput, SegmentedControl, Section, Field, Row, Stack, ProgressBar, Toggle, tokens } = ui;
  const targets = useSelectedPhotos();
  const single = targets.length === 1;
  const firstId = targets[0]?.id;

  // ── editor state ──
  const [artist, setArtist] = React.useState("");
  const [copyright, setCopyright] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [keywords, setKeywords] = React.useState("");
  const [touched, setTouched] = React.useState<Record<string, boolean>>({});
  const [dateMode, setDateMode] = React.useState<DateMode>("none");
  const [dateSet, setDateSet] = React.useState("");
  const [shiftH, setShiftH] = React.useState(0);
  const [shiftM, setShiftM] = React.useState(0);
  const [gpsOn, setGpsOn] = React.useState(false);
  const [lat, setLat] = React.useState(0);
  const [lon, setLon] = React.useState(0);

  const [applying, setApplying] = React.useState(false);
  const [prog, setProg] = React.useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = React.useState<WriteResult[] | null>(null);

  const mark = (k: string) => setTouched((t) => (t[k] ? t : { ...t, [k]: true }));

  // Prefill from the single active photo; clear for a multi-selection so a batch
  // edit only writes fields the user deliberately fills in.
  React.useEffect(() => {
    setTouched({});
    setResults(null);
    setDateMode("none");
    setGpsOn(false);
    const p = targets[0];
    if (single && p) {
      const m = currentMeta(p);
      setArtist(m.artist ?? "");
      setCopyright(m.copyright ?? "");
      setDescription(m.description ?? "");
      setKeywords((m.keywords ?? []).join(", "));
      setDateSet(p.exif.dateTimeOriginal ?? "");
      setLat(m.gpsLat ?? 0);
      setLon(m.gpsLon ?? 0);
    } else {
      setArtist(""); setCopyright(""); setDescription(""); setKeywords(""); setDateSet("");
      setLat(0); setLon(0);
    }
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

  const buildEdits = (): EditableMeta => {
    const edits: EditableMeta = {};
    if (touched.artist) edits.artist = artist;
    if (touched.copyright) edits.copyright = copyright;
    if (touched.description) edits.description = description;
    if (touched.keywords) edits.keywords = parseKeywords(keywords);
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
  const nothing =
    Object.keys(edits).length === 0 && dateOp.kind === "none";
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

  return (
    <Stack gap={12}>
      <Section title={targets.length > 1 ? `Edit metadata (${targets.length} photos)` : "Edit metadata"}>
        <Stack gap={8}>
          {targets.length === 0 && <Hint>Select one or more photos in the grid.</Hint>}
          {targets.length > 1 && <Hint>Only the fields you change are written. Empty a field to clear it.</Hint>}

          <Field label="Creator">
            <TextInput value={artist} onChange={(v) => { setArtist(v); mark("artist"); }} placeholder={single ? "" : "(leave unchanged)"} />
          </Field>
          <Field label="Copyright">
            <TextInput value={copyright} onChange={(v) => { setCopyright(v); mark("copyright"); }} placeholder={single ? "" : "(leave unchanged)"} />
          </Field>
          <Field label="Caption / description">
            <TextArea value={description} onChange={(v) => { setDescription(v); mark("description"); }} rows={2} placeholder={single ? "" : "(leave unchanged)"} />
          </Field>
          <Field label="Keywords" hint="Comma-separated">
            <TextArea value={keywords} onChange={(v) => { setKeywords(v); mark("keywords"); }} rows={2} placeholder={single ? "sunset, coast" : "(leave unchanged)"} />
          </Field>

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
