import json, os, sys, tempfile, time, unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import wsi_ingest_daemon as wd

engine = wd.engine
autobatch = wd.autobatch


class AutobatchUnitTests(unittest.TestCase):
    """Pure-function / single-method tests that never touch the filesystem
    stability clock via time.sleep -- these inject `now` directly."""

    def test_split_known_extension_prefers_longest_suffix(self):
        stem, ext = autobatch.split_known_extension("slide.ome.tiff", engine)
        self.assertEqual((stem, ext), ("slide", ".ome.tiff"))
        stem, ext = autobatch.split_known_extension("slide.vsi", engine)
        self.assertEqual((stem, ext), ("slide", ".vsi"))
        stem, ext = autobatch.split_known_extension("notes.txt", engine)
        self.assertIsNone(stem)

    def test_expected_companion_name_for_vsi_and_mrxs(self):
        self.assertEqual(autobatch.expected_companion_name("A.vsi", engine), "_A_")
        self.assertEqual(autobatch.expected_companion_name("A.mrxs", engine), "A")
        self.assertIsNone(autobatch.expected_companion_name("A.svs", engine))

    def test_companion_stem_shape_matching(self):
        self.assertEqual(autobatch.companion_stem("_A_"), "A")
        self.assertIsNone(autobatch.companion_stem("A"))
        self.assertIsNone(autobatch.companion_stem("_A"))

    def test_tracking_ledger_resets_on_change_and_accumulates_when_stable(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger = autobatch.TrackingLedger(Path(tmp) / "tracking.json")
            since1, obs1 = ledger.observe("folder", "a.svs", ["file", 10, 100], now=1000)
            self.assertEqual((since1, obs1), (1000, 1))
            since2, obs2 = ledger.observe("folder", "a.svs", ["file", 10, 100], now=1010)
            self.assertEqual((since2, obs2), (1000, 2))  # unchanged fingerprint -> clock keeps running
            since3, obs3 = ledger.observe("folder", "a.svs", ["file", 999, 100], now=1020)
            self.assertEqual((since3, obs3), (1020, 1))  # fingerprint changed -> clock resets

    def test_tracking_ledger_sweep_stale_drops_vanished_entries(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger = autobatch.TrackingLedger(Path(tmp) / "tracking.json")
            ledger.observe("folder", "a.svs", ["file", 10, 100], now=1000)
            ledger.observe("folder", "b.svs", ["file", 10, 100], now=1000)
            ledger.sweep_stale("folder", present_names={"a.svs"})
            data = ledger._load()
            self.assertEqual(list(data["folder"].keys()), ["a.svs"])

    def test_merge_ledger_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger = autobatch.AutobatchMergeLedger(Path(tmp) / "merge.json")
            self.assertEqual(ledger.pending(), {})
            ledger.record("temp-name", "20260828")
            self.assertEqual(ledger.pending(), {"temp-name": "20260828"})
            ledger.clear("temp-name")
            self.assertEqual(ledger.pending(), {})

    def test_is_ready_requires_both_observation_count_and_quiet_window(self):
        c = {"obs": 2, "interval": 1, "quiet": 5}
        self.assertFalse(autobatch._is_ready(stable_since=100, observations=1, c=c, now=200))  # not enough observations
        self.assertFalse(autobatch._is_ready(stable_since=198, observations=2, c=c, now=200))  # not quiet long enough
        self.assertTrue(autobatch._is_ready(stable_since=190, observations=2, c=c, now=200))


class AutobatchDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.staging = Path(self.t.name) / "staging"
        self.staging.mkdir()

    def tearDown(self):
        self.t.cleanup()

    def test_only_folders_with_sentinel_are_discovered(self):
        marked = self.staging / "20260828"
        marked.mkdir()
        (marked / autobatch.AUTOBATCH_SENTINEL).write_text("")
        unmarked = self.staging / "manual-batch"
        unmarked.mkdir()
        (self.staging / "-unrecognized").mkdir()
        (self.staging / ".hidden").mkdir()
        found = autobatch.discover_marked_folders(self.staging)
        self.assertEqual([p.name for p in found], ["20260828"])

    def test_name_agnostic_any_folder_name_can_be_marked(self):
        for name in ("20260828", "renal_study_2026", "batch-3"):
            d = self.staging / name
            d.mkdir()
            (d / autobatch.AUTOBATCH_SENTINEL).write_text("")
        found = [p.name for p in autobatch.discover_marked_folders(self.staging)]
        self.assertEqual(found, sorted(["20260828", "renal_study_2026", "batch-3"]))


class AutobatchScanIntegrationTests(unittest.TestCase):
    """Real-time integration tests against scan_and_relocate itself -- uses
    real (short) sleeps since the module intentionally calls time.time()
    internally rather than accepting an injectable clock."""

    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        root = Path(self.t.name)
        self.staging = root / "staging"
        self.production = root / "prod"
        self.staging.mkdir()
        self.production.mkdir()
        (self.production / ".wsi-environment-production").write_text("")
        self.env = dict(
            WSI_INGEST_STAGING_ROOT=str(self.staging), WSI_INGEST_PRODUCTION_ROOT=str(self.production),
            WSI_INGEST_REQUIRED_OBSERVATIONS="2", WSI_INGEST_OBSERVATION_INTERVAL_SECONDS="1",
            WSI_INGEST_MIN_QUIET_SECONDS="1",
        )
        self.env_patch = mock.patch.dict(os.environ, self.env, clear=True)
        self.env_patch.start()
        self.tracking = autobatch.TrackingLedger(Path(self.t.name) / "tracking.json")
        self.merge_ledger = autobatch.AutobatchMergeLedger(Path(self.t.name) / "merge.json")
        self.events = []

    def tearDown(self):
        self.env_patch.stop()
        self.t.cleanup()

    def log(self, event, **fields):
        self.events.append((event, fields))

    def mark(self, name="20260828"):
        d = self.staging / name
        d.mkdir()
        (d / autobatch.AUTOBATCH_SENTINEL).write_text("")
        return d

    def scan(self):
        c = engine.cfg()
        autobatch.scan_and_relocate(c, engine, self.tracking, self.merge_ledger, log=self.log)
        return c

    def test_single_file_format_relocates_once_stable(self):
        folder = self.mark()
        (folder / "slide.svs").write_bytes(b"x" * 100)
        self.scan()  # first observation
        self.assertFalse((self.staging / "slide").exists())
        time.sleep(1.1)
        self.scan()  # second observation, quiet window satisfied
        self.assertTrue((self.staging / "slide").is_dir())
        self.assertTrue((self.staging / "slide" / "slide.svs").is_file())
        self.assertEqual(self.merge_ledger.pending(), {"slide": "20260828"})
        self.assertIn("autobatch_relocated", [e for e, _ in self.events])

    def test_vsi_waits_for_companion_regardless_of_arrival_order(self):
        folder = self.mark()
        (folder / "A.vsi").write_bytes(b"x" * 10)
        self.scan()
        time.sleep(1.1)
        self.scan()
        # anchor alone, even though stable, is not a complete slide yet
        self.assertFalse((self.staging / "A").exists())
        (folder / "_A_").mkdir()
        (folder / "_A_" / "tile0.dat").write_bytes(b"y" * 10)
        self.scan()
        time.sleep(1.1)
        self.scan()
        self.assertTrue((self.staging / "A").is_dir())
        self.assertTrue((self.staging / "A" / "A.vsi").is_file())
        self.assertTrue((self.staging / "A" / "_A_").is_dir())
        self.assertEqual(self.merge_ledger.pending(), {"A": "20260828"})

    def test_mrxs_waits_for_bare_stem_companion_regardless_of_arrival_order(self):
        folder = self.mark()
        (folder / "CMU-1.mrxs").write_bytes(b"x" * 10)
        self.scan()
        time.sleep(1.1)
        self.scan()
        # anchor alone, even though stable, is not a complete slide yet
        self.assertFalse((self.staging / "CMU-1").exists())
        (folder / "CMU-1").mkdir()
        (folder / "CMU-1" / "Data0000.dat").write_bytes(b"y" * 10)
        (folder / "CMU-1" / "Index.dat").write_bytes(b"z" * 10)
        self.scan()
        time.sleep(1.1)
        self.scan()
        self.assertTrue((self.staging / "CMU-1").is_dir())
        self.assertTrue((self.staging / "CMU-1" / "CMU-1.mrxs").is_file())
        self.assertTrue((self.staging / "CMU-1" / "CMU-1").is_dir())
        self.assertTrue((self.staging / "CMU-1" / "CMU-1" / "Data0000.dat").is_file())
        self.assertEqual(self.merge_ledger.pending(), {"CMU-1": "20260828"})

    def test_unrelated_bare_folder_is_not_mistaken_for_an_mrxs_companion(self):
        folder = self.mark()
        (folder / "some-other-notes").mkdir()
        (folder / "some-other-notes" / "readme.txt").write_text("not a slide")
        self.scan()
        time.sleep(1.1)
        self.scan()
        # no anchor ever claims it, so it is only ever generically unrecognized
        self.assertTrue((self.staging / autobatch.QUARANTINE_DIRNAME / "20260828" / "some-other-notes").is_dir())

    def test_companion_without_anchor_is_eventually_quarantined(self):
        folder = self.mark()
        (folder / "_Orphan_").mkdir()
        (folder / "_Orphan_" / "tile0.dat").write_bytes(b"z" * 5)
        self.scan()
        time.sleep(1.1)
        self.scan()
        self.assertFalse((folder / "_Orphan_").exists())
        self.assertTrue((self.staging / autobatch.QUARANTINE_DIRNAME / "20260828" / "_Orphan_").is_dir())
        self.assertIn("autobatch_quarantined", [e for e, _ in self.events])

    def test_unrecognized_file_is_eventually_quarantined(self):
        folder = self.mark()
        (folder / "notes.txt").write_text("not a slide")
        self.scan()
        time.sleep(1.1)
        self.scan()
        self.assertTrue((self.staging / autobatch.QUARANTINE_DIRNAME / "20260828" / "notes.txt").is_file())

    def test_filesystem_noise_is_never_tracked_or_quarantined(self):
        folder = self.mark()
        (folder / ".DS_Store").write_bytes(b"\x00")
        (folder / "Thumbs.db").write_bytes(b"\x00")
        self.scan()
        time.sleep(1.1)
        self.scan()
        self.assertTrue((folder / ".DS_Store").exists())
        self.assertTrue((folder / "Thumbs.db").exists())
        self.assertFalse((self.staging / autobatch.QUARANTINE_DIRNAME).exists())

    def test_unmarked_folder_is_completely_untouched(self):
        loose = self.staging / "manual-batch"
        loose.mkdir()
        (loose / "slide.svs").write_bytes(b"x" * 100)
        self.scan()
        time.sleep(1.1)
        self.scan()
        self.assertTrue((loose / "slide.svs").is_file())
        self.assertEqual(self.merge_ledger.pending(), {})

    def test_invalid_stem_is_quarantined_instead_of_relocated(self):
        folder = self.mark()
        (folder / "..vsi").write_bytes(b"x" * 10)  # extension-stripped stem is "."
        (folder / "_._").mkdir()
        (folder / "_._" / "tile0.dat").write_bytes(b"y")
        self.scan()
        time.sleep(1.1)
        self.scan()
        self.assertFalse((folder / "..vsi").exists())
        self.assertTrue((self.staging / autobatch.QUARANTINE_DIRNAME / "20260828" / "..vsi").is_file())


class AutobatchDaemonMergeTests(unittest.TestCase):
    """merge_promoted_autobatch_dataset() itself, exercised without needing a
    real seal/observe/promote cycle -- it only assumes the temp wrapper's
    contents already sit in production/<name>/."""

    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        root = Path(self.t.name)
        self.staging = root / "staging"
        self.production = root / "prod"
        self.staging.mkdir()
        self.production.mkdir()
        (self.production / ".wsi-environment-production").write_text("")
        self.env = dict(
            WSI_INGEST_STAGING_ROOT=str(self.staging), WSI_INGEST_PRODUCTION_ROOT=str(self.production),
            WSI_INGEST_REQUIRED_OBSERVATIONS="3", WSI_INGEST_OBSERVATION_INTERVAL_SECONDS="10",
            WSI_INGEST_MIN_QUIET_SECONDS="20",
        )
        self.env_patch = mock.patch.dict(os.environ, self.env, clear=True)
        self.env_patch.start()

    def tearDown(self):
        self.env_patch.stop()
        self.t.cleanup()

    def test_merges_into_origin_and_clears_ledger(self):
        c = engine.cfg()
        (self.production / "slide").mkdir()
        (self.production / "slide" / "slide.svs").write_bytes(b"x")
        merge_ledger = autobatch.AutobatchMergeLedger(self.staging / "merge.json")
        merge_ledger.record("slide", "20260828")
        result = wd.merge_promoted_autobatch_dataset(c, merge_ledger, "slide")
        self.assertEqual(result, "20260828")
        self.assertTrue((self.production / "20260828" / "slide.svs").is_file())
        self.assertFalse((self.production / "slide").exists())
        self.assertEqual(merge_ledger.pending(), {})

    def test_non_autobatch_dataset_is_returned_unchanged(self):
        c = engine.cfg()
        merge_ledger = autobatch.AutobatchMergeLedger(self.staging / "merge.json")
        result = wd.merge_promoted_autobatch_dataset(c, merge_ledger, "manual-batch")
        self.assertEqual(result, "manual-batch")

    def test_interrupted_merge_resumes_on_next_call(self):
        c = engine.cfg()
        (self.production / "slide").mkdir()
        (self.production / "slide" / "a.svs").write_bytes(b"x")
        (self.production / "slide" / "b.svs").write_bytes(b"y")
        merge_ledger = autobatch.AutobatchMergeLedger(self.staging / "merge.json")
        merge_ledger.record("slide", "20260828")
        # Simulate a crash that moved only the first item before dying.
        (self.production / "20260828").mkdir()
        engine.atomic_rename_noreplace(self.production / "slide" / "a.svs", self.production / "20260828" / "a.svs")
        result = wd.merge_promoted_autobatch_dataset(c, merge_ledger, "slide")
        self.assertEqual(result, "20260828")
        self.assertTrue((self.production / "20260828" / "a.svs").is_file())
        self.assertTrue((self.production / "20260828" / "b.svs").is_file())
        self.assertFalse((self.production / "slide").exists())

    def test_name_collision_blocks_merge_and_preserves_ledger_entry(self):
        c = engine.cfg()
        (self.production / "slide").mkdir()
        (self.production / "slide" / "a.svs").write_bytes(b"new")
        (self.production / "20260828").mkdir()
        (self.production / "20260828" / "a.svs").write_bytes(b"already-there")
        merge_ledger = autobatch.AutobatchMergeLedger(self.staging / "merge.json")
        merge_ledger.record("slide", "20260828")
        result = wd.merge_promoted_autobatch_dataset(c, merge_ledger, "slide")
        self.assertEqual(result, "slide")  # unresolved this pass
        self.assertEqual(merge_ledger.pending(), {"slide": "20260828"})
        self.assertEqual((self.production / "20260828" / "a.svs").read_bytes(), b"already-there")


if __name__ == "__main__":
    unittest.main()
