// The Rename tab: build a filename template from tokens + numbering, preview the
// result across the selection, and apply it through core's atomic rename.

import { React, api, ui } from "../rt";
import { useSelectedPhotos, Hint, Notice } from "../ui";
import {
  planRename, TOKEN_GROUPS, DEFAULT_OPTIONS, type RenameOptions, type CaseMode,
} from "./engine";
import { applyRename, type ApplyOutcome } from "./apply";

interface Preset {
  name: string;
  opts: RenameOptions;
}

const BUILTIN_PRESETS: Preset[] = [
  { name: "Original name", opts: { ...DEFAULT_OPTIONS, template: "{name}" } },
  { name: "Name + number", opts: { ...DEFAULT_OPTIONS, template: "{name}_{seq}" } },
  { name: "Date + number", opts: { ...DEFAULT_OPTIONS, template: "{date}_{seq}" } },
  { name: "Year-month + number", opts: { ...DEFAULT_OPTIONS, template: "{yyyy}-{mon}_{seq}" } },
  { name: "Camera + number", opts: { ...DEFAULT_OPTIONS, template: "{model}_{seq}" } },
];

const OPTS_KEY = "rename.options";
const PRESETS_KEY = "rename.presets";
const PREVIEW_LIMIT = 8;

export function RenameTab(): React.ReactElement {
  const { Button, TextInput, NumberInput, SegmentedControl, Select, Section, Field, Row, Stack, ProgressBar, tokens } = ui;
  const targets = useSelectedPhotos();

  const [opts, setOpts] = React.useState<RenameOptions>(() =>
    api.settings.get<RenameOptions>(OPTS_KEY, DEFAULT_OPTIONS),
  );
  const [userPresets, setUserPresets] = React.useState<Preset[]>(() =>
    api.settings.get<Preset[]>(PRESETS_KEY, []),
  );
  const [applying, setApplying] = React.useState(false);
  const [prog, setProg] = React.useState<{ done: number; total: number } | null>(null);
  const [summary, setSummary] = React.useState<ApplyOutcome | null>(null);
  const [presetName, setPresetName] = React.useState("");

  const set = (patch: Partial<RenameOptions>) => {
    setOpts((prev) => {
      const next = { ...prev, ...patch };
      api.settings.set(OPTS_KEY, next);
      return next;
    });
    setSummary(null);
  };

  const plan = React.useMemo(() => planRename(targets, opts), [targets, opts]);
  const active = plan.items.filter((it) => !it.skip && !it.unchanged);
  const skipped = plan.items.filter((it) => it.skip);
  const canApply =
    targets.length > 0 && active.length > 0 && plan.duplicates.length === 0 && !applying;

  const insertToken = (t: string) => set({ template: opts.template + t });

  // Electron blocks window.prompt(), so the name comes from an inline field.
  const savePreset = () => {
    const name = presetName.trim();
    if (!name) return;
    const next = [...userPresets.filter((p) => p.name !== name), { name, opts }];
    setUserPresets(next);
    api.settings.set(PRESETS_KEY, next);
  };

  const deletePreset = () => {
    const name = presetName.trim();
    const next = userPresets.filter((p) => p.name !== name);
    setUserPresets(next);
    api.settings.set(PRESETS_KEY, next);
    setPresetName("");
  };

  const applyPreset = (name: string) => {
    const p = [...BUILTIN_PRESETS, ...userPresets].find((x) => x.name === name);
    if (p) {
      set({ ...p.opts });
      setPresetName(name); // so it can be re-saved / deleted
    }
  };

  const savedMatch = userPresets.some((p) => p.name === presetName.trim());

  const run = async () => {
    setApplying(true);
    setSummary(null);
    try {
      const outcome = await applyRename(plan, (p) => setProg({ done: p.done, total: p.total }));
      setSummary(outcome);
    } finally {
      setApplying(false);
      setProg(null);
    }
  };

  return (
    <Stack gap={12}>
      <Section title="Template">
        <Stack gap={8}>
          <TextInput
            value={opts.template}
            onChange={(v) => set({ template: v })}
            style={{ fontFamily: tokens.fontMono }}
            placeholder="{name}_{seq}"
          />
          <Hint>Click to add a token. Anything else is kept as typed.</Hint>
          {TOKEN_GROUPS.map((g) => (
            <div key={g.group}>
              <div style={{ color: tokens.textMuted, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>
                {g.group}
              </div>
              <Row gap={4} wrap>
                {g.tokens.map((t) => (
                  <button
                    key={t.insert}
                    onClick={() => insertToken(t.insert)}
                    title={`${t.label} — e.g. ${t.sample}`}
                    style={{
                      font: "inherit",
                      fontSize: 11,
                      fontFamily: tokens.fontMono,
                      padding: "2px 6px",
                      borderRadius: 4,
                      border: `1px solid ${tokens.border}`,
                      background: tokens.surface2,
                      color: tokens.textSecondary,
                      cursor: "pointer",
                    }}
                  >
                    {t.insert}
                  </button>
                ))}
              </Row>
            </div>
          ))}
        </Stack>
      </Section>

      <Section title="Numbering">
        <Row gap={10} wrap>
          <Field label="Start">
            <NumberInput value={opts.seqStart} onChange={(v) => set({ seqStart: Math.trunc(v) })} min={0} step={1} width={64} />
          </Field>
          <Field label="Step">
            <NumberInput value={opts.seqStep} onChange={(v) => set({ seqStep: Math.trunc(v) || 1 })} min={1} step={1} width={64} />
          </Field>
          <Field label="Digits">
            <NumberInput value={opts.seqPad} onChange={(v) => set({ seqPad: Math.max(1, Math.trunc(v)) })} min={1} max={8} step={1} width={64} />
          </Field>
          <Field label="Case">
            <SegmentedControl
              value={opts.caseMode}
              onChange={(v) => set({ caseMode: v as CaseMode })}
              options={[
                { value: "asis", label: "Aa" },
                { value: "lower", label: "aa" },
                { value: "upper", label: "AA" },
              ]}
            />
          </Field>
        </Row>
      </Section>

      <Section title="Presets">
        <Stack gap={6}>
          <Select
            value=""
            onChange={applyPreset}
            placeholder="Load a preset…"
            groups={[
              { title: "Built-in", items: BUILTIN_PRESETS.map((p) => ({ value: p.name, label: p.name })) },
              ...(userPresets.length ? [{ title: "Saved", items: userPresets.map((p) => ({ value: p.name, label: p.name })) }] : []),
            ]}
          />
          <Row gap={6}>
            <div style={{ flex: 1 }}>
              <TextInput value={presetName} onChange={setPresetName} placeholder="Save current as…" />
            </div>
            <Button size="sm" onClick={savePreset} disabled={!presetName.trim()}>
              {savedMatch ? "Update" : "Save"}
            </Button>
            {savedMatch && (
              <Button size="sm" variant="danger" onClick={deletePreset}>Delete</Button>
            )}
          </Row>
        </Stack>
      </Section>

      <Section title={`Preview (${active.length} to rename)`}>
        <Stack gap={8}>
          {targets.length === 0 && <Hint>Select one or more photos in the grid.</Hint>}

          {plan.unknownTokens.length > 0 && (
            <Notice tone="warn">Unknown token{plan.unknownTokens.length > 1 ? "s" : ""}: {plan.unknownTokens.map((t) => `{${t}}`).join(", ")} — resolved to nothing.</Notice>
          )}
          {plan.duplicates.length > 0 && (
            <Notice tone="danger">Template produces duplicate names (add {"{seq}"} or {"{letter}"}): {plan.duplicates.slice(0, 3).join(", ")}{plan.duplicates.length > 3 ? "…" : ""}</Notice>
          )}
          {plan.needsTempPass && active.length > 0 && (
            <Notice tone="info">Names overlap the current set — a safe two-pass rename will be used.</Notice>
          )}

          {active.length > 0 && (
            <div style={{ fontFamily: tokens.fontMono, fontSize: 11, lineHeight: 1.7 }}>
              {active.slice(0, PREVIEW_LIMIT).map((it) => (
                <div key={it.id} style={{ display: "flex", gap: 6, alignItems: "center", whiteSpace: "nowrap", overflow: "hidden" }}>
                  <span style={{ color: tokens.textMuted, overflow: "hidden", textOverflow: "ellipsis" }}>{it.oldName}</span>
                  <span style={{ color: tokens.textMuted }}>→</span>
                  <span style={{ color: tokens.textPrimary, overflow: "hidden", textOverflow: "ellipsis" }}>{it.newName}</span>
                </div>
              ))}
              {active.length > PREVIEW_LIMIT && <div style={{ color: tokens.textMuted }}>…and {active.length - PREVIEW_LIMIT} more</div>}
            </div>
          )}

          {skipped.length > 0 && (
            <Hint>{skipped.length} skipped: {skipped.slice(0, 3).map((s) => `${s.oldName} (${s.skip})`).join("; ")}{skipped.length > 3 ? "…" : ""}</Hint>
          )}
        </Stack>
      </Section>

      {prog && <ProgressBar value={prog.total ? prog.done / prog.total : 0} />}

      {summary && (
        <Notice tone={summary.failed.length ? "warn" : "ok"}>
          Renamed {summary.renamed}
          {summary.skipped.length ? `, skipped ${summary.skipped.length}` : ""}
          {summary.failed.length ? `, failed ${summary.failed.length}: ${summary.failed.slice(0, 2).map((f) => f.reason).join("; ")}` : "."}
        </Notice>
      )}

      <Button variant="primary" full disabled={!canApply} onClick={run}>
        {applying ? "Renaming…" : `Rename ${active.length || ""} file${active.length === 1 ? "" : "s"}`}
      </Button>
    </Stack>
  );
}
