# KMTNet scConv Studio (SOLO)

Open [kmtnet-scconv-standalone.html](kmtnet-scconv-standalone.html).
The page runs locally. It needs no Python and uploads no data.

## Quick start: batch export (recommended)

1. Open the page.
2. Click **Add planning CSV** and select `fields_observing_order.csv`.
3. Check the preview.
4. Click **Download all scripts (ZIP)**.

**Output:**
* One `scSOLO_<SITE>_<YYYY-MM-DD>.cat` per site and night
  * The example contains 15 scripts, 292 fields.
  * No per-night `.cat` files are necessary
* Preset: `SOLO.set` (project=SOLO, one R-band 60 s exposure per field).
* **Loop N**: Set it before you import. `0` disables looping. A positive value is the restart row.

## Timing

* The observing window is the time the field center is above 30° (=`altitude_limit_deg`), clipped to the full night.
* Fields sort by session (dusk, then dawn), then by `order_in_night`.

| Output | Value | CSV source |
|---|---|---|
| `UTOBS` | Window start. | =`altitude_window_start_ut` (round to seconds) |
| `window_end` (written in comment) | Window end. | = `set_time_ut` clipped to night end (round to seconds). **Not** `altitude_window_end_ut`, to maximize `UTTOL`. |
| `UTTOL` | Seconds from `UTOBS` to `window_end` (duration). | - |

NOTE: In the input CSV, `[rise/set]_time_ut`: 30° crossings (e.g., these can be at daylight time).

<!-- | `altitude_window_start_ut` | `max(rise_time_ut, session_start_ut)` |
| `altitude_window_end_ut` | `min(set_time_ut, session_end_ut)` | -->


## Exporter (HTML file)

* Start: `max(rise_time_ut, night_start_ut)` (== `altitude_window_start_ut` for all 292 current fields).
* End: `min(set_time_ut, night_end_ut)`.
* Night boundaries: `night_start_ut` and `night_end_ut` in the CSV.

NOTE:
* It does not calculate new rise/set times (uses input CSV).
* `UTTOL` does not subtract exposure time.

## Saved test scripts

The local `test_computation/` directory has two ZIPs. Git excludes this directory.
* `SOLO_observing_scripts_full_night.zip`: per-field timing windows.
* `SOLO_observing_scripts_without_timing.zip`: `UTOBS = -`, `UTTOL = 0`.
* Both: 15 nights, 292 fields, **Loop N** = 0.

## Other workflows

### Convert one catalog

1. Select **SOLO**.
2. Open `solo_scripts/SOLO.set` in **Setting File**.
3. Open a nightly `.cat` in **Catalog File**.
4. Click **Download Script**.

**Output:** `sc<catalog name>` (e.g., `scSOLO_CTIO_2026-10-27.cat`).


### Rebuild catalogs with Python

`make_solo_cat.py`: `fields_observing_order.csv` → `SOLO.set` + nightly `.cat` files in `solo_scripts/`.

```sh
# from the repository root
uv venv                                        # if .venv does not exist
uv pip install --python .venv/bin/python pandas
uv run --no-project python obsplan/make_solo_cat.py
```

NOTE: It overwrites files with the same names. It does not delete old catalogs.


## File formats

### Setting file (`.set`)

* `12 + nfil` nonblank lines, in the order below.
* Trailing comments start with `#` or `=`. Do not add standalone comment lines.

| Position | Field | Meaning |
|---|---|---|
| 1 | `pID` | Project ID (SOLO, KSP, BLG, DEEPS). |
| 2 | `nfil` | Filters per position. `0`: filter and exposure from catalog columns. |
| next `nfil` | `FILTER EXPTIME` | Filter and exposure [s] (e.g., `R 60`). |
| next 3 | `cLabel`, `cRA`, `cDEC` | Catalog column numbers (1-based). |
| next | `copt` | Offset correction flag. `1` for BLG, `0` for others. |
| next | `imgtyp` | Image type (e.g., `OBJECT`). |
| next 4 | `cObject`, `cFilter`, `cExposure`, `cUTObs` | Column numbers. `0` = unused. |
| last | `tol` | `UTTOL` [s]. |

`SOLO.set`: `R 60`, label/RA/Dec in columns 1–3, no `UTOBS` column, `tol = 0`.

### Catalog file (`.cat`)

* One target per line, whitespace-separated.
* RA `hh:mm:ss`, Dec `±dd:mm:ss`. Seconds can have decimals.
* Comments: `#` or `=`, full line or after the data.

### Output script

* One line per target per filter: `LABEL(FILTER)`.
  * BLG with `nfil = 0`: `LABEL(FILTER,col7)`.
* Blank lines separate blocks of `nfil` exposures (5 if `nfil < 3`). `#N` marks each block start.
* DEEPS with `cUTObs >= 4`: columns `cUTObs-3`…`cUTObs` (year, month, day, `HHMMSS`) → `YYYY-MM-DDTHH:MM:SS`.
* Positive **Loop N**: appends `+ostart N`.

## SOLO labels

Format: `{site}{DDDD}{session}{idx:02d}` (e.g., `C0664W03`).

| Part | Meaning |
|---|---|
| `site` | `C` CTIO, `S` SSO, `A` SAAO. |
| `DDDD` | Days since 2025-01-01 (day 0). |
| `session` | `W` dusk (west), `E` dawn (east). |
| `idx` | Tile index from the end of `tile_id`. |

NOTE: `O` (opposition) exists in the label helper, but the sorter does not support it.

**Night date:** UT date of the nearest local mean midnight (from site longitude and `session_start_ut`).
* A mismatch with `night_ut` gives a warning.

**Catalog line:** keeps the full `tile_id` and target count.

```text
C0664W03    20:45:01.38  -17:59:18.6  # CTIO_2026-10-27_dusk_03  n_targets 11
```

### Sky Map

* **Coords**: AltAz (dome, north up, east left), or Equatorial/Galactic/Ecliptic (equirectangular or Mollweide).
* **Site**: CTIO, SAAO, or SSO.
* Overlays: Galactic plane, ecliptic, horizon, Sun, Moon, Moon avoidance circle.
* Click a target to copy its coordinates.

NOTE: The time field shows UTC, but manual edits use the browser's local time zone. Use **Now** and the step buttons.

**AltAz tint** by solar altitude h_sun (brightest toward the Sun):

| h_sun | Tint |
|---|---|
| > 0° | Yellow (day) |
| −6° to 0° | Gold (civil) |
| −12° to −6° | Deep gold (nautical) |
| −18° to −12° | Faint amber (astronomical) |
| ≤ −18° | None (night) |
