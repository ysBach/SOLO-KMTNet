"""Build KMTNet scConv inputs (SOLO.set + one .cat per site-night) from
``fields_observing_order.csv``."""

import logging
from datetime import date, datetime, timedelta
from pathlib import Path

import pandas as pd

logger = logging.getLogger(__name__)

SRC = Path(__file__).with_name("fields_observing_order.csv")
OUTDIR = Path(__file__).with_name("solo_scripts")
SESSION_ORDER = {"dusk": 0, "dawn": 1}
SITE_CODE = {"CTIO": "C", "SSO": "S", "SAAO": "A"}
# dusk fields are in the western sky, dawn fields in the eastern; O = opposition
SESSION_CODE = {"dusk": "W", "dawn": "E", "opposition": "O"}
# Day 0 of the project (UT); labels carry the night number since this date
EPOCH = date(2025, 1, 1)
# East longitudes [deg], same values as SITES in kmtnet-scconv-standalone.html
SITE_LON_DEG = {"CTIO": -70.806, "SAAO": 20.811, "SSO": 149.064}


def night_date(t_ut: datetime, lon_deg: float) -> date:
    """Return the UT date at the local mean midnight nearest to ``t_ut``.

    Every instant between local mean noon and the next local mean noon maps to
    the same midnight, so one night always gets one date, even when the UT
    date changes during the night. Local mean midnight sits at a fixed UT for
    a site (``24 h - lon/15``), so consecutive nights never share or skip a date.

    Parameters
    ----------
    t_ut : `datetime.datetime`
        Any instant during the night, UT (naive).
    lon_deg : `float`
        Site east longitude in degrees.
    """
    shift = timedelta(hours=lon_deg / 15)
    lmt = t_ut + shift
    midnight_lmt = datetime.combine(
        (lmt + timedelta(hours=12)).date(), datetime.min.time()
    )
    return (midnight_lmt - shift).date()


def short_label(site: str, night: date, session: str, tile_id: str) -> str:
    """Return the short label ``{site}{DDDD}{E|W|O}{idx:02d}``, e.g. ``C0664W03``.

    ``DDDD`` is the number of days from `EPOCH` (2025-01-01 = 0) to ``night``.

    Parameters
    ----------
    site : `str`
        ``"CTIO"``, ``"SSO"`` or ``"SAAO"``.
    night : `datetime.date`
        Night date from `night_date`.
    session : `str`
        ``"dusk"``, ``"dawn"`` or ``"opposition"``.
    tile_id : `str`
        Full tile ID; its trailing ``_NN`` is the tile index.
    """
    idx = int(tile_id.rsplit("_", 1)[1])
    dddd = (night - EPOCH).days
    if not 0 <= dddd <= 9999:
        raise ValueError(f"night {night} is outside 0..9999 days from {EPOCH}")
    return f"{SITE_CODE[site]}{dddd:04d}{SESSION_CODE[session]}{idx:02d}"


SET_TEXT = """\
SOLO                   # Project name
1                      # Filter sequence per each position
R 60                   # Filter name and exposure time
1                      # column no. for LABEL
2                      # column no. for RA
3                      # column no. for DEC
0                      # set for COPT
OBJECT                 # name for IMAGETYP
1                      # column no. for OBJECT name
0                      # column no. for FILTER
0                      # column no. for EXPOSURE time
0                      # column no. for UTOBS
0                      # set for UTTOL time in seconds
"""


def write_night_cat(df: pd.DataFrame, site: str, night: date, outdir: Path) -> Path:
    """Write one site-night catalog, dusk first then dawn, in ``order_in_night``.

    Parameters
    ----------
    df : `pandas.DataFrame`
        Rows of one site and one night.
    site : `str`
        Site code.
    night : `datetime.date`
        Night date from `night_date`; used in the file name and labels.
    outdir : `pathlib.Path`
        Output directory.

    Returns
    -------
    path : `pathlib.Path`
        Written file.
    """
    df = df.sort_values("order_in_night")
    dddd = (night - EPOCH).days
    header = (
        f"# SOLO  site {site}  night {night} (day {dddd:04d} since {EPOCH}; "
        f"UT date at local midnight)  n_tiles {len(df)}"
    )
    lines = [header]
    for sess, g in sorted(df.groupby("session"), key=lambda kv: SESSION_ORDER[kv[0]]):
        r0 = g.iloc[0]
        lines.append("")
        lines.append(
            f"# {sess}: {len(g)} tiles, session {r0.session_start_ut} -- {r0.session_end_ut} UT"
        )
        for r in g.itertuples():
            label = short_label(site, night, sess, r.tile_id)
            lines.append(
                f"{label:<10s} {r.ra_hms:>12s} {r.dec_dms:>12s}"
                f"  # {r.tile_id}  n_targets {r.n_targets}"
            )
    path = outdir / f"SOLO_{site}_{night}.cat"
    path.write_text("\n".join(lines) + "\n")
    return path


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    OUTDIR.mkdir(exist_ok=True)
    (OUTDIR / "SOLO.set").write_text(SET_TEXT)
    df = pd.read_csv(SRC, dtype={"ra_hms": str, "dec_dms": str})
    starts = pd.to_datetime(df["session_start_ut"])
    df["night"] = [
        night_date(t.to_pydatetime(), SITE_LON_DEG[s])
        for t, s in zip(starts, df["site"])
    ]
    diff = df["night"].astype(str) != df["night_ut"]
    if diff.any():
        bad = df.loc[diff, ["site", "night_ut", "night"]].drop_duplicates()
        logger.warning(
            "night differs from CSV night_ut (using night):\n%s", bad.to_string()
        )
    for (site, night), g in df.groupby(["site", "night"]):
        p = write_night_cat(g, site, night, OUTDIR)
        logger.info("%s  (%d tiles)", p.name, len(g))


if __name__ == "__main__":
    main()
