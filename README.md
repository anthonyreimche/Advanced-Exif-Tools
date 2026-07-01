# Advanced EXIF Tools

Batch and single **file renaming** with a Lightroom/digicam-style token system,
plus an advanced **metadata inspector and editor**, for
[Safelight](https://github.com/anthonyreimche/SafeLight).

Adds an **EXIF Tools** panel to the Library (and *Rename with template…* /
*Edit metadata…* entries to the photo right-click menu).

## Rename

Build a filename from **tokens** and literal text, preview the result across the
whole selection, then apply it. Renames go through Safelight's own atomic rename,
so ratings, edits, cached previews and the `.safelight.json` sidecar follow the
file — and a numbering shuffle (e.g. renumbering a whole shoot) is done as a safe
two-pass rename so nothing collides.

| Token | Meaning | Example |
|---|---|---|
| `{name}` | Original name (no extension) | `IMG_1234` |
| `{seq}` / `{seq:4}` | Sequence number (padding from settings, or inline) | `001` / `0001` |
| `{letter}` / `{LETTER}` | Sequence letter (a, b … z, aa) | `a` / `A` |
| `{folder}` | Containing folder | `Trip` |
| `{yyyy}` `{yy}` `{mon}` `{day}` | Capture date parts | `2026` `26` `06` `30` |
| `{hour}` `{min}` `{sec}` | Capture time parts | `14` `05` `42` |
| `{date}` `{time}` | `yyyymmdd` / `hhmmss` | `20260630` `140542` |
| `{make}` `{model}` `{lens}` | Camera & lens | `NIKON` `Z8` |
| `{iso}` `{fnum}` `{shutter}` `{focal}` | Exposure | `400` `f2.8` `1_250` `35mm` |

Sequence **start**, **step**, zero-pad **digits**, and a **case** transform are
set in the panel, and named **presets** can be saved.

## Metadata

Edit the high-value writable fields across one photo or a whole selection —
**creator**, **copyright**, **caption**, **keywords**, **capture time** (set an
absolute time, or *shift* every photo's own time to fix a camera clock), and
**GPS** — over a full-tag EXIF **inspector** (every IFD0 / Exif / GPS / Interop /
thumbnail tag, not just the handful the Info panel shows).

**How edits are written**

- **JPEG / TIFF** → written *in place* as native EXIF. Every rewritten buffer is
  re-parsed and validated (and for TIFF the pixel/thumbnail data is checked
  byte-for-byte) **before** it touches disk, so a file is never left damaged.
- **RAW and everything else** → a non-destructive **`.xmp` sidecar** next to the
  file (read back by this extension so Safelight still shows the values). If an
  in-place edit can't be done safely it falls back to a sidecar automatically
  rather than risking the original.

Keywords are stored in the catalog for every format (and in the sidecar for
RAW); the other fields are written into the file's EXIF for JPEG/TIFF.

## Install

Install from the in-app **Extensions** store, or clone this repo into
`userData/plugins/`. Requires **Safelight 2.5.0+** (the atomic rename API).

## Build

```
npm install
npm run build      # bundles src/ → dist/index.js (committed)
npm run typecheck
```

React is left external and taken from `api.react`; the single ESM bundle exports
`activate(api)`.

## License

MIT © Anthony Reimche
