// Panel root: a two-tab shell (Rename / Metadata). A grid-menu action can nudge
// the visible tab via requestTab(); the panel picks it up on its next render.

import { React, ui } from "./rt";
import { RenameTab } from "./rename/RenameTab";
import { MetadataTab } from "./metadata/MetadataTab";

export type PanelTab = "rename" | "metadata";

let pendingTab: PanelTab | null = null;
const listeners = new Set<() => void>();

/** Ask the panel to show a particular tab (used by the grid context menu). */
export function requestTab(tab: PanelTab): void {
  pendingTab = tab;
  listeners.forEach((l) => l());
}

export function ToolsPanel(): React.ReactElement {
  const { SegmentedControl, Stack } = ui;
  const [tab, setTab] = React.useState<PanelTab>("rename");

  React.useEffect(() => {
    const apply = () => {
      if (pendingTab) {
        setTab(pendingTab);
        pendingTab = null;
      }
    };
    listeners.add(apply);
    apply(); // consume a request that arrived before mount
    return () => {
      listeners.delete(apply);
    };
  }, []);

  return (
    <div style={{ padding: 10 }}>
      <Stack gap={10}>
        <SegmentedControl
          value={tab}
          onChange={(v) => setTab(v as PanelTab)}
          options={[
            { value: "rename", label: "Rename" },
            { value: "metadata", label: "Metadata" },
          ]}
        />
        {tab === "rename" ? <RenameTab /> : <MetadataTab />}
      </Stack>
    </div>
  );
}
