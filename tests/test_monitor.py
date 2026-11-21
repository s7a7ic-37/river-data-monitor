from datetime import UTC, datetime, timedelta
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from monitor import MEASURE, parse_batch, refresh


NOW = datetime(2026, 11, 21, 14, tzinfo=UTC)


def reading(at="2026-11-21T13:45:00Z", value=0.35):
    return {"measure": MEASURE.replace("https:", "http:"), "dateTime": at, "value": value}


class ImportTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "snapshot.json"

    def reload(self):
        return json.loads(self.path.read_text())

    def test_repeat_import_and_revision_keep_one_row_per_timestamp(self):
        first = refresh(self.path, lambda _: {"items": [reading()]}, NOW)
        second = refresh(self.path, lambda _: {"items": [reading(), reading()]}, NOW + timedelta(hours=1))
        corrected = refresh(self.path, lambda _: {"items": [reading(value=0.36)]}, NOW + timedelta(hours=2))
        self.assertEqual(first["added"], 1)
        self.assertEqual((second["added"], second["unchanged"]), (0, 2))
        self.assertEqual((corrected["added"], corrected["revised"]), (0, 1))
        self.assertEqual(self.reload()["readings"], [["2026-11-21T13:45:00Z", 0.36]])

    def test_bad_rows_and_conflicting_duplicates_are_counted(self):
        rows = [
            reading(), reading(value=0.36),
            reading(at="2026-11-21T13:30:00+00:00", value=-0.1),
            reading(at="2026-11-21T13:30:00Z", value=-0.1),
            reading(at="2026-11-21T13:15:00"), reading(at="2026-11-22T12:00:00Z"),
            reading(value=True), reading(value=float("nan")), {"measure": "other gauge"},
        ]
        count, accepted, repeated, rejected = parse_batch({"items": rows}, NOW - timedelta(days=3), NOW)
        self.assertEqual(count, 9)
        self.assertEqual(accepted, [("2026-11-21T13:30:00Z", -0.1)])
        self.assertEqual(repeated, 1)
        self.assertEqual(rejected, {
            "Conflicting heights at the same time": 2,
            "Invalid or out of range timestamp": 2,
            "Invalid gauge height": 2,
            "Unexpected measure": 1,
        })

    def test_outage_and_empty_batch_keep_the_last_good_snapshot(self):
        refresh(self.path, lambda _: {"items": [reading()]}, NOW)
        good = self.reload()

        def unavailable(_):
            raise TimeoutError("Synthetic provider detail")

        for fetch in (unavailable, lambda _: {"items": []}, lambda _: {"items": "unreadable"}):
            attempt = refresh(self.path, fetch, NOW + timedelta(hours=1))
            current = self.reload()
            self.assertIn("error", attempt)
            self.assertEqual(current["last_import"], good["last_import"])
            self.assertEqual(current["readings"], good["readings"])
            self.assertEqual(current["runs"][0], attempt)
            self.assertNotIn("Synthetic provider detail", self.path.read_text())

    def test_successful_import_rolls_the_window_forward(self):
        refresh(self.path, lambda _: {"items": [reading(at="2026-11-18T14:30:00Z")]}, NOW)
        refresh(self.path, lambda _: {"items": [reading()]}, NOW + timedelta(hours=1))
        self.assertEqual(self.reload()["readings"], [["2026-11-21T13:45:00Z", 0.35]])
