// Execute a rename plan through core's atomic api.catalog.renamePhoto. When the
// plan involves a target↔target name swap (e.g. shifting a numbering range by
// one), core's collision guard would reject the direct rename, so we route the
// whole batch through unique temporary names first, then to their finals.

import { api } from "../rt";
import type { RenamePlan, PlanItem } from "./engine";

export interface ApplyProgress {
  done: number;
  total: number;
  current: string;
}

export interface ApplyOutcome {
  renamed: number;
  skipped: { name: string; reason: string }[];
  failed: { name: string; reason: string }[];
}

async function rename(id: string, base: string): Promise<{ ok: boolean; reason?: string }> {
  const r = await api.catalog.renamePhoto(id, base);
  return r.ok ? { ok: true } : { ok: false, reason: r.reason };
}

export async function applyRename(
  plan: RenamePlan,
  onProgress?: (p: ApplyProgress) => void,
): Promise<ApplyOutcome> {
  const active: PlanItem[] = plan.items.filter((it) => !it.skip && !it.unchanged);
  const outcome: ApplyOutcome = {
    renamed: 0,
    skipped: plan.items
      .filter((it) => it.skip)
      .map((it) => ({ name: it.oldName, reason: it.skip! })),
    failed: [],
  };

  const total = active.length;
  let done = 0;
  const report = (current: string) => onProgress?.({ done, total, current });

  // A short nonce keeps phase-1 temp names unique and unlikely to collide with
  // anything already on disk. This runs in the app (not a workflow), so
  // Date.now() is available.
  const nonce = Date.now().toString(36);

  if (plan.needsTempPass) {
    const staged = new Set<string>();
    for (let i = 0; i < active.length; i++) {
      const it = active[i];
      const r = await rename(it.id, `__aet_${nonce}_${i}`);
      if (r.ok) staged.add(it.id);
      else outcome.failed.push({ name: it.oldName, reason: r.reason ?? "Rename failed." });
    }
    for (const it of active) {
      if (!staged.has(it.id)) continue;
      report(it.newName);
      const r = await rename(it.id, it.newBase);
      if (r.ok) {
        outcome.renamed++;
      } else {
        // Final leg failed (e.g. the target name collides with an unselected
        // file). Restore the original name so nothing is left stranded at its
        // temporary name.
        const origBase = it.oldName.replace(/\.[^.]+$/, "");
        await rename(it.id, origBase);
        outcome.failed.push({ name: it.oldName, reason: r.reason ?? "Rename failed." });
      }
      done++;
    }
  } else {
    for (const it of active) {
      report(it.newName);
      const r = await rename(it.id, it.newBase);
      if (r.ok) outcome.renamed++;
      else outcome.failed.push({ name: it.oldName, reason: r.reason ?? "Rename failed." });
      done++;
    }
  }

  report("");
  return outcome;
}
