// Advanced EXIF Tools — entry point. Wires the panel, the Library grid-menu
// shortcuts, and the XMP-sidecar import hook onto the scoped Safelight API.

import { initRuntime } from "./rt";
import type { SafelightAPI } from "./safelight-api";
import { ToolsPanel, requestTab, type PanelTab } from "./Panel";
import { readSidecarForImport } from "./metadata/apply";

const ID = "anthonyreimche.advanced-exif-tools";
const PANEL_ID = `${ID}.panel`;

export function activate(api: SafelightAPI): void {
  initRuntime(api);

  api.registerPanel({
    id: PANEL_ID,
    title: "EXIF Tools",
    component: ToolsPanel,
    defaultDock: { module: "library", direction: "right", order: 20, width: 300 },
  });

  // Target exactly the right-clicked photos (or the selection they belong to),
  // then surface the panel on the matching tab.
  const open = (ids: string[], tab: PanelTab) => {
    if (ids.length) {
      api.stores.useCatalogStore.setState({ selectedIds: new Set(ids), activePhotoId: ids[0] });
    }
    requestTab(tab);
    api.dock.togglePanel(PANEL_ID);
  };

  api.registerGridMenuItem({
    id: `${ID}.rename`,
    label: (ids) => (ids.length > 1 ? `Batch rename… (${ids.length})` : "Rename with template…"),
    order: 10,
    onClick: (ids) => open(ids, "rename"),
  });

  api.registerGridMenuItem({
    id: `${ID}.metadata`,
    label: (ids) => (ids.length > 1 ? `Edit metadata… (${ids.length})` : "Edit metadata…"),
    order: 11,
    onClick: (ids) => open(ids, "metadata"),
  });

  // Fold any XMP sidecar we wrote (for RAW/other) back onto the record on scan.
  api.registerCatalogHooks({
    id: `${ID}.sidecar`,
    onPhotoImport: (ctx) => readSidecarForImport(ctx),
  });
}
