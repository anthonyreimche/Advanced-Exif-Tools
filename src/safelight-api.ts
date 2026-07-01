// Local, focused type stubs for the slice of the Safelight extension API this
// extension uses. The app's real, exhaustive definitions live in the core repo
// (src/extensions/types.ts, src/catalog/types.ts); this file mirrors only what
// we touch so the bundle type-checks standalone without depending on core.

import type { ComponentType, CSSProperties, ReactNode } from "react";

// ── catalog model ────────────────────────────────────────────────────────────

export type ColorLabel = "none" | "red" | "yellow" | "green" | "blue" | "purple";
export type FlagStatus = "none" | "pick" | "reject";

export interface ExifData {
  cameraMake?: string;
  cameraModel?: string;
  bodySerial?: string;
  lens?: string;
  lensMake?: string;
  lensSerial?: string;
  focalLength?: number;
  focalLength35mm?: number;
  aperture?: number;
  maxAperture?: number;
  shutterSpeed?: string;
  iso?: number;
  exposureCompensation?: number;
  exposureProgram?: string;
  exposureMode?: string;
  meteringMode?: string;
  whiteBalance?: string;
  flash?: string;
  subjectDistance?: number;
  sceneCaptureType?: string;
  colorSpace?: string;
  artist?: string;
  copyright?: string;
  software?: string;
  imageDescription?: string;
  dateTimeOriginal?: string;
  orientation?: number;
  colorTemperature?: number;
  gpsLatitude?: number;
  gpsLongitude?: number;
  gpsAltitude?: number;
}

export interface CatalogPhoto {
  id: string;
  filename: string;
  relPath: string;
  folder: string;
  directoryHandle: FileSystemDirectoryHandle | null;
  fileHandle: FileSystemFileHandle | null;
  thumbnailBlob: Blob | null;
  thumbnailUrl: string | null;
  width: number;
  height: number;
  fileSize: number;
  mimeType: string;
  rating: number;
  colorLabel: ColorLabel;
  flag: FlagStatus;
  rotation: number;
  keywords: string[];
  dateCreated: number;
  dateImported: number;
  exif: ExifData;
  decodeError?: string;
  copyOf?: string;
  copyName?: string;
}

// ── zustand store shape (only the members we read/call) ──────────────────────

export interface CatalogState {
  photos: CatalogPhoto[];
  selectedIds: Set<string>;
  activePhotoId: string | null;
  /** Durably persist + swap in fully-formed updated records (used by core for
   *  path moves; we reuse it to persist EXIF/keyword edits). */
  relocatePhotos(updated: CatalogPhoto[]): Promise<void>;
  updatePhoto(photo: CatalogPhoto): void;
  addKeywords(ids: string[], keywords: string[]): Promise<void>;
  removeKeywords(ids: string[], keywords: string[]): Promise<void>;
}

/** A zustand hook: callable as a selector inside React, with getState/subscribe
 *  off the function for use outside render. */
export interface StoreHook<T> {
  (): T;
  <U>(selector: (state: T) => U): U;
  getState(): T;
  setState(partial: Partial<T> | ((state: T) => Partial<T>)): void;
  subscribe(listener: (state: T, prev: T) => void): () => void;
}

// ── contribution shapes ──────────────────────────────────────────────────────

export interface PanelDockDefault {
  module: "library" | "develop";
  direction: "left" | "right";
  order?: number;
  width?: number;
  height?: number;
}

export interface PanelContribution {
  id: string;
  title: string;
  component: ComponentType;
  slot?: "develop-right" | "develop-left" | "none";
  order?: number;
  defaultDock?: PanelDockDefault;
}

export interface GridMenuItemContribution {
  id: string;
  label: string | ((ids: string[]) => string);
  order?: number;
  danger?: boolean;
  enabled?: (ids: string[]) => boolean;
  onClick: (ids: string[]) => void;
}

export interface CatalogHooksContribution {
  id: string;
  onPhotoImport?(ctx: {
    photo: CatalogPhoto;
    dir: FileSystemDirectoryHandle;
    fileName: string;
  }): Promise<Partial<CatalogPhoto> | void>;
}

export type SettingsField =
  | { key: string; label: string; hint?: string; type: "boolean"; default: boolean }
  | { key: string; label: string; hint?: string; type: "number"; default: number; min?: number; max?: number; step?: number }
  | { key: string; label: string; hint?: string; type: "string"; default: string; placeholder?: string }
  | { key: string; label: string; hint?: string; type: "select"; default: string; options: { value: string; label: string }[] };

export interface SettingsContribution {
  title?: string;
  fields: SettingsField[];
  order?: number;
  component?: ComponentType;
  keywords?: string[];
}

export interface KeyActionContribution {
  id: string;
  label: string;
  category?: "General" | "Develop" | "Library";
  defaultCombo: string;
  handler(): void;
}

export type RenamePhotoResult =
  | { ok: true; filename: string }
  | { ok: false; reason: string };

// ── UI kit (api.ui) ──────────────────────────────────────────────────────────

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

export interface UiKit {
  Button: ComponentType<{
    variant?: Variant;
    size?: Size;
    active?: boolean;
    full?: boolean;
    disabled?: boolean;
    title?: string;
    onClick?: () => void;
    children?: ReactNode;
    style?: CSSProperties;
  }>;
  Select: ComponentType<{
    value: string;
    onChange: (value: string) => void;
    options?: { value: string; label: string; disabled?: boolean }[];
    groups?: { title?: string; items: { value: string; label: string; disabled?: boolean }[] }[];
    placeholder?: string;
    disabled?: boolean;
    className?: string;
  }>;
  TextInput: ComponentType<{
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    disabled?: boolean;
    style?: CSSProperties;
    onKeyDown?: (e: unknown) => void;
  }>;
  NumberInput: ComponentType<{
    value: number;
    onChange: (value: number) => void;
    min?: number;
    max?: number;
    step?: number;
    width?: number | string;
    disabled?: boolean;
  }>;
  TextArea: ComponentType<{
    value: string;
    onChange: (value: string) => void;
    rows?: number;
    mono?: boolean;
    placeholder?: string;
    disabled?: boolean;
    style?: CSSProperties;
  }>;
  Toggle: ComponentType<{
    checked: boolean;
    onChange: (checked: boolean) => void;
    label?: string;
    ariaLabel?: string;
  }>;
  SegmentedControl: ComponentType<{
    value: string;
    onChange: (value: string) => void;
    options: { value: string; label: string; title?: string }[];
    size?: Size;
  }>;
  Field: ComponentType<{ label?: string; hint?: string; children?: ReactNode }>;
  Section: ComponentType<{ title: string; right?: ReactNode; children?: ReactNode }>;
  Card: ComponentType<{ children?: ReactNode; className?: string; style?: CSSProperties }>;
  Badge: ComponentType<{ children?: ReactNode; color?: string }>;
  ProgressBar: ComponentType<{ value: number }>;
  Stack: ComponentType<{ children?: ReactNode; gap?: number; style?: CSSProperties }>;
  Row: ComponentType<{
    children?: ReactNode;
    gap?: number;
    align?: string;
    justify?: string;
    wrap?: boolean;
    style?: CSSProperties;
  }>;
  tokens: Record<string, string>;
}

// ── the scoped API object handed to activate() ───────────────────────────────

export interface SafelightAPI {
  version: 1;
  extensionId: string;
  react: typeof import("react");
  registerPanel(c: PanelContribution): void;
  registerGridMenuItem(c: GridMenuItemContribution): void;
  registerCatalogHooks(c: CatalogHooksContribution): void;
  registerSettings(c: SettingsContribution): void;
  registerKeybinding(c: KeyActionContribution): void;
  settings: {
    get<T>(key: string, fallback: T): T;
    set(key: string, value: unknown): void;
    onChange(cb: (key: string, value: unknown) => void): () => void;
  };
  ui: UiKit;
  stores: {
    useCatalogStore: StoreHook<CatalogState>;
  };
  dock: { togglePanel(id: string): void };
  navigation: { goTo(module: "library" | "develop"): void };
  catalog: {
    renamePhoto(photoId: string, newBaseName: string): Promise<RenamePhotoResult>;
  };
}

export interface ExtensionModule {
  activate(api: SafelightAPI): void;
  deactivate?(): void;
}
