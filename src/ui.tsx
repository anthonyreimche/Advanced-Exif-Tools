// Two tiny presentational bits that aren't worth a kit primitive.

import { React, ui } from "./rt";

/** A muted status line: what the panel is waiting for or what it skipped. */
export function Status({ children }: { children: React.ReactNode }): React.ReactElement {
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
      ? ui.tokens.rating
      : tone === "danger"
        ? ui.tokens.labelRed
        : tone === "ok"
          ? ui.tokens.labelGreen
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
