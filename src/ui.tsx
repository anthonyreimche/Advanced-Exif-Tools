// Shared UI helpers: the selection hook every tab reads from, plus a couple of
// tiny presentational bits that aren't worth a kit primitive.

import { React, api, ui } from "./rt";
import type { CatalogPhoto } from "./safelight-api";

/** The photos a batch action targets: the current multi-selection, or the
 *  single active photo when nothing is multi-selected. Grid order is preserved
 *  (we filter `photos`, not the id set). Re-renders on any selection change. */
export function useSelectedPhotos(): CatalogPhoto[] {
  const photos = api.stores.useCatalogStore((s) => s.photos);
  const selectedIds = api.stores.useCatalogStore((s) => s.selectedIds);
  const activeId = api.stores.useCatalogStore((s) => s.activePhotoId);
  return React.useMemo(() => {
    if (selectedIds.size > 0) return photos.filter((p) => selectedIds.has(p.id));
    if (activeId) {
      const a = photos.find((p) => p.id === activeId);
      return a ? [a] : [];
    }
    return [];
  }, [photos, selectedIds, activeId]);
}

/** A muted line of helper text. */
export function Hint({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div style={{ color: ui.tokens.textMuted, fontSize: 11, lineHeight: 1.4 }}>{children}</div>
  );
}

/** A small inline notice used for warnings and result summaries. `tone` picks
 *  the accent colour without inventing new tokens. */
export function Notice({
  tone = "info",
  children,
}: {
  tone?: "info" | "warn" | "danger" | "ok";
  children: React.ReactNode;
}): React.ReactElement {
  const color =
    tone === "warn"
      ? "var(--color-rating)"
      : tone === "danger"
        ? "#e5484d"
        : tone === "ok"
          ? "#46a758"
          : ui.tokens.textSecondary;
  return (
    <div
      style={{
        borderLeft: `2px solid ${color}`,
        paddingLeft: 8,
        color: ui.tokens.textSecondary,
        fontSize: 12,
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}
