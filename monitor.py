"""Import recent gauge readings and publish the latest good data with an import log."""

import argparse
import json
import math
from collections import Counter
from datetime import UTC, datetime, timedelta
from pathlib import Path
from tempfile import NamedTemporaryFile
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import duckdb


MEASURE = "https://environment.data.gov.uk/flood-monitoring/id/measures/694039-level-stage-i-15_min-m"
WINDOW = timedelta(days=3)
ROW_LIMIT = 400


def timestamp(value):
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def fetch_readings(since):
    query = urlencode({"since": timestamp(since), "_limit": ROW_LIMIT})
    request = Request(
        f"{MEASURE}/readings?{query}",
        headers={"Accept": "application/json", "User-Agent": "RiverDataMonitor/1.0 (+https://river.artemislab.co.uk)"},
    )
    with urlopen(request, timeout=15) as response:
        body = response.read(512 * 1024 + 1)
    if len(body) > 512 * 1024:
        raise ValueError("Feed exceeded the response size limit")
    return json.loads(body)


def parse_batch(payload, start, end):
    rows = payload.get("items") if isinstance(payload, dict) else None
    if not isinstance(rows, list) or len(rows) > ROW_LIMIT:
        raise ValueError("Expected a bounded list of readings")

    rejected = Counter()
    by_time = {}
    for row in rows:
        if not isinstance(row, dict) or row.get("measure") not in (MEASURE, MEASURE.replace("https:", "http:")):
            rejected["Unexpected measure"] += 1
            continue
        try:
            observed = datetime.fromisoformat(row["dateTime"])
            if observed.tzinfo is None or not start <= observed <= end:
                raise ValueError
        except (KeyError, TypeError, ValueError, OverflowError):
            rejected["Invalid or out of range timestamp"] += 1
            continue
        value = row.get("value")
        if type(value) not in (int, float) or not -1000 <= value <= 1000 or not math.isfinite(value):
            rejected["Invalid gauge height"] += 1
            continue
        by_time.setdefault(timestamp(observed), []).append(value)

    accepted = []
    repeated = 0
    for observed, values in by_time.items():
        if len(set(values)) > 1:
            rejected["Conflicting heights at the same time"] += len(values)
            continue
        accepted.append((observed, values[0]))
        repeated += len(values) - 1
    return len(rows), accepted, repeated, dict(rejected)


def merge_readings(previous, incoming, start):
    with duckdb.connect(":memory:") as db:
        db.execute("CREATE TABLE readings (observed_at TIMESTAMPTZ PRIMARY KEY, metres DOUBLE NOT NULL)")
        if previous:
            db.executemany("INSERT INTO readings VALUES (?, ?)", previous)
        db.execute("CREATE TEMP TABLE batch AS SELECT * FROM readings WHERE false")
        db.executemany("INSERT INTO batch VALUES (?, ?)", incoming)
        added, revised, unchanged = db.execute("""
            SELECT count(*) FILTER (WHERE readings.observed_at IS NULL),
                   count(*) FILTER (WHERE batch.metres <> readings.metres),
                   count(*) FILTER (WHERE batch.metres = readings.metres)
            FROM batch LEFT JOIN readings USING (observed_at)
        """).fetchone()
        db.execute("""
            INSERT INTO readings SELECT * FROM batch
            ON CONFLICT (observed_at) DO UPDATE SET metres = excluded.metres
        """)
        readings = db.execute("""
            SELECT observed_at AT TIME ZONE 'UTC', metres
            FROM readings WHERE observed_at >= ? ORDER BY observed_at
        """, [start]).fetchall()
    return [[timestamp(at.replace(tzinfo=UTC)), metres] for at, metres in readings], added, revised, unchanged


def refresh(path, fetch=fetch_readings, now=None):
    now = now or datetime.now(UTC)
    start = now - WINDOW
    snapshot = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {
        "measure": MEASURE,
        "window_hours": 72,
        "last_import": None,
        "readings": [],
        "runs": [],
    }
    run = {"at": timestamp(now), "received": 0, "added": 0, "revised": 0, "unchanged": 0, "rejected": 0, "reasons": {}}
    try:
        received, incoming, repeated, reasons = parse_batch(fetch(start), start, now)
    except OSError:
        run["error"] = "The Environment Agency feed could not be reached."
    except ValueError:
        run["error"] = "The feed returned an unreadable batch."
    else:
        run.update(received=received, reasons=reasons, rejected=sum(reasons.values()), unchanged=repeated)
        if incoming:
            readings, added, revised, unchanged = merge_readings(snapshot["readings"], incoming, start)
            snapshot.update(readings=readings, last_import=run["at"])
            run.update(added=added, revised=revised, unchanged=unchanged + repeated)
        else:
            run["error"] = "The feed returned no usable readings."

    snapshot["runs"] = [run, *snapshot["runs"][:7]]
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False, suffix=".tmp")
    temp_path = Path(temp.name)
    try:
        with temp:
            json.dump(snapshot, temp, allow_nan=False, separators=(",", ":"))
            temp.write("\n")
        temp_path.replace(path)
    finally:
        temp_path.unlink(missing_ok=True)
    return run


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", nargs="?", type=Path, default=Path("web/snapshot.json"))
    args = parser.parse_args()
    print(json.dumps(refresh(args.snapshot)))
