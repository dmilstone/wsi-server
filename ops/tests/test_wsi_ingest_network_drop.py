import os, shutil, stat, sys, tempfile, time, unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import wsi_ingest_daemon as wd

engine = wd.engine
network_drop = wd.network_drop


class DiscoverUnitsTests(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.root = Path(self.t.name)

    def tearDown(self):
        self.t.cleanup()

    def keys(self, units):
        return sorted(u["key"] for u in units)

    def test_flat_layout_is_one_unit_per_slide_not_per_folder(self):
        (self.root / "case1").mkdir()
        (self.root / "case1" / "slide.svs").write_bytes(b"x")
        (self.root / "case2").mkdir()
        (self.root / "case2" / "slide.ndpi").write_bytes(b"x")
        units = network_drop.discover_units(self.root, engine)
        self.assertEqual(self.keys(units), ["case1/slide.svs", "case2/slide.ndpi"])
        by_key = {u["key"]: u for u in units}
        self.assertEqual(by_key["case1/slide.svs"]["origin"], "case1")
        self.assertEqual(by_key["case2/slide.ndpi"]["origin"], "case2")
        self.assertEqual(by_key["case1/slide.svs"]["stem"], "slide")
        self.assertTrue(by_key["case1/slide.svs"]["complete"])

    def test_dated_subdirectory_layout_uses_immediate_parent_as_origin(self):
        (self.root / "2026-08-31" / "case1").mkdir(parents=True)
        (self.root / "2026-08-31" / "case1" / "slide.svs").write_bytes(b"x")
        units = network_drop.discover_units(self.root, engine)
        self.assertEqual(len(units), 1)
        self.assertEqual(units[0]["key"], "2026-08-31/case1/slide.svs")
        self.assertEqual(units[0]["origin"], "case1")

    def test_two_slides_in_the_same_dated_folder_are_independent_units(self):
        dated = self.root / "20260831"
        dated.mkdir()
        (dated / "a.svs").write_bytes(b"x")
        (dated / "b.svs").write_bytes(b"x")
        units = network_drop.discover_units(self.root, engine)
        self.assertEqual(self.keys(units), ["20260831/a.svs", "20260831/b.svs"])
        self.assertEqual({u["origin"] for u in units}, {"20260831"})

    def test_mrxs_companion_folder_is_not_its_own_dataset(self):
        d = self.root / "case1"
        d.mkdir()
        (d / "slide.mrxs").write_bytes(b"x")
        (d / "slide").mkdir()
        (d / "slide" / "Data0000.dat").write_bytes(b"x")
        units = network_drop.discover_units(self.root, engine)
        self.assertEqual(self.keys(units), ["case1/slide.mrxs"])
        self.assertTrue(units[0]["complete"])
        self.assertEqual(units[0]["companion"], d / "slide")

    def test_vsi_without_companion_is_incomplete(self):
        d = self.root / "20260831"
        d.mkdir()
        (d / "slide.vsi").write_bytes(b"x")
        units = network_drop.discover_units(self.root, engine)
        self.assertEqual(len(units), 1)
        self.assertFalse(units[0]["complete"])
        self.assertIsNone(units[0]["companion"])

    def test_vsi_with_companion_is_complete(self):
        d = self.root / "20260831"
        d.mkdir()
        (d / "slide.vsi").write_bytes(b"x")
        (d / "_slide_").mkdir()
        (d / "_slide_" / "tile.dat").write_bytes(b"x")
        units = network_drop.discover_units(self.root, engine)
        self.assertEqual(len(units), 1)
        self.assertTrue(units[0]["complete"])
        self.assertEqual(units[0]["companion"], d / "_slide_")

    def test_excludes_processed_directory_and_noise_files(self):
        (self.root / "processed" / "old-case").mkdir(parents=True)
        (self.root / "processed" / "old-case" / "slide.svs").write_bytes(b"x")
        (self.root / ".DS_Store").write_bytes(b"x")
        found = network_drop.discover_units(self.root, engine)
        self.assertEqual(found, [])

    def test_loose_files_directly_at_root_are_not_swept_into_a_dataset(self):
        (self.root / "slide.svs").write_bytes(b"x")
        events = []
        found = network_drop.discover_units(self.root, engine, log=lambda e, **f: events.append((e, f)))
        self.assertEqual(found, [])
        self.assertIn("network_drop_loose_file_at_root", [e for e, _ in events])


class SizeFingerprintTests(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.root = Path(self.t.name)

    def tearDown(self):
        self.t.cleanup()

    def test_ignores_mtime_differences(self):
        d = self.root / "case1"
        d.mkdir()
        slide = d / "slide.svs"
        slide.write_bytes(b"x" * 10)
        fp1 = network_drop._unit_size_fingerprint([slide])
        future = time.time() + 100
        os.utime(slide, (future, future))
        fp2 = network_drop._unit_size_fingerprint([slide])
        self.assertEqual(fp1, fp2)

    def test_detects_size_change(self):
        d = self.root / "case1"
        d.mkdir()
        slide = d / "slide.svs"
        slide.write_bytes(b"x" * 10)
        fp1 = network_drop._unit_size_fingerprint([slide])
        slide.write_bytes(b"x" * 20)
        fp2 = network_drop._unit_size_fingerprint([slide])
        self.assertNotEqual(fp1, fp2)

    def test_excludes_noise_files_inside_a_companion_folder(self):
        d = self.root / "case1"
        d.mkdir()
        vsi = d / "slide.vsi"
        vsi.write_bytes(b"x" * 10)
        companion = d / "_slide_"
        companion.mkdir()
        (companion / "tile.dat").write_bytes(b"y" * 5)
        (companion / "Thumbs.db").write_bytes(b"windows junk")
        (companion / ".DS_Store").write_bytes(b"finder junk")
        fp = network_drop._unit_size_fingerprint([vsi, companion])
        self.assertEqual([["_slide_/tile.dat", 5], ["slide.vsi", 10]], fp)

    def test_noise_file_size_change_does_not_affect_the_fingerprint(self):
        d = self.root / "case1"
        d.mkdir()
        vsi = d / "slide.vsi"
        vsi.write_bytes(b"x" * 10)
        companion = d / "_slide_"
        companion.mkdir()
        (companion / "tile.dat").write_bytes(b"y")
        (companion / ".DS_Store").write_bytes(b"a")
        fp1 = network_drop._unit_size_fingerprint([vsi, companion])
        (companion / ".DS_Store").write_bytes(b"a totally different size now, as if just Finder-rewritten")
        fp2 = network_drop._unit_size_fingerprint([vsi, companion])
        self.assertEqual(fp1, fp2)


class TrackingLedgerTests(unittest.TestCase):
    def test_resets_on_change_and_accumulates_when_stable(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger = network_drop.TrackingLedger(Path(tmp) / "tracking.json")
            since1, obs1 = ledger.observe("case1", [["a.svs", 10]], now=1000)
            self.assertEqual((since1, obs1), (1000, 1))
            since2, obs2 = ledger.observe("case1", [["a.svs", 10]], now=1010)
            self.assertEqual((since2, obs2), (1000, 2))  # unchanged -> clock keeps running
            since3, obs3 = ledger.observe("case1", [["a.svs", 999]], now=1020)
            self.assertEqual((since3, obs3), (1020, 1))  # changed -> clock resets

    def test_sweep_stale_drops_vanished_entries(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger = network_drop.TrackingLedger(Path(tmp) / "tracking.json")
            ledger.observe("case1", [["a.svs", 10]], now=1000)
            ledger.observe("case2", [["b.svs", 10]], now=1000)
            ledger.sweep_stale(present_keys={"case1"})
            self.assertEqual(list(ledger._load().keys()), ["case1"])


class IsReadyTests(unittest.TestCase):
    def test_requires_both_observation_count_and_quiet_window(self):
        c = {"obs": 2, "interval": 1, "quiet": 5}
        self.assertFalse(network_drop._is_ready(stable_since=100, observations=1, c=c, now=200))
        self.assertFalse(network_drop._is_ready(stable_since=198, observations=2, c=c, now=200))
        self.assertTrue(network_drop._is_ready(stable_since=190, observations=2, c=c, now=200))


class MoveToProcessedTests(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.root = Path(self.t.name)

    def tearDown(self):
        self.t.cleanup()

    def test_mirrors_relative_path_and_suffixes_on_second_collision(self):
        events = []
        log = lambda event, **fields: events.append((event, fields))

        (self.root / "2026-08-31" / "case1").mkdir(parents=True)
        (self.root / "2026-08-31" / "case1" / "slide.svs").write_bytes(b"a")
        network_drop._move_to_processed(self.root, Path("2026-08-31/case1"), log)
        self.assertFalse((self.root / "2026-08-31" / "case1").exists())
        self.assertTrue((self.root / "processed" / "2026-08-31" / "case1" / "slide.svs").is_file())

        (self.root / "2026-08-31" / "case1").mkdir(parents=True)
        (self.root / "2026-08-31" / "case1" / "slide.svs").write_bytes(b"b")
        network_drop._move_to_processed(self.root, Path("2026-08-31/case1"), log)
        remaining = sorted(p.name for p in (self.root / "processed" / "2026-08-31").iterdir())
        self.assertEqual(len(remaining), 2)
        self.assertEqual(remaining[0], "case1")
        self.assertTrue(remaining[1].startswith("case1."))
        self.assertEqual(events, [])  # no failure logged; this is the expected, successful path


class LiveOverrideTests(unittest.TestCase):
    """Pure-function tests for the dashboard-writable live override file --
    see effective_config()'s docstring for the precedence it implements."""

    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.staging = Path(self.t.name) / "staging"
        self.staging.mkdir()

    def tearDown(self):
        self.t.cleanup()

    def test_missing_override_file_reports_not_set(self):
        is_set, root = network_drop.read_live_override(self.staging)
        self.assertFalse(is_set)
        self.assertIsNone(root)

    def test_write_then_read_round_trips_a_path(self):
        network_drop.write_live_override(self.staging, "/tmp/some-network-root")
        is_set, root = network_drop.read_live_override(self.staging)
        self.assertTrue(is_set)
        self.assertEqual(root, Path("/tmp/some-network-root"))

    def test_write_empty_string_marks_explicitly_disabled_not_unset(self):
        network_drop.write_live_override(self.staging, "/tmp/some-network-root")
        network_drop.write_live_override(self.staging, "")
        is_set, root = network_drop.read_live_override(self.staging)
        self.assertTrue(is_set)  # a file exists -- explicitly disabled, distinct from "no file yet"
        self.assertIsNone(root)

    def test_override_file_location_and_permissions(self):
        network_drop.write_live_override(self.staging, "/tmp/x")
        path = network_drop.live_override_path(self.staging)
        self.assertEqual(path, self.staging / ".wsi-ingest-control" / "daemon" / "network-drop-root.txt")
        self.assertTrue(path.is_file())
        self.assertEqual(0o600, stat.S_IMODE(path.stat().st_mode))
        self.assertEqual(0o700, stat.S_IMODE(path.parent.stat().st_mode))

    def test_second_write_replaces_first(self):
        network_drop.write_live_override(self.staging, "/tmp/first")
        network_drop.write_live_override(self.staging, "/tmp/second")
        _, root = network_drop.read_live_override(self.staging)
        self.assertEqual(root, Path("/tmp/second"))

    def test_effective_config_falls_back_to_environment_when_no_override_file(self):
        with mock.patch.dict(os.environ, {"WSI_INGEST_NETWORK_DROP_ROOT": "/tmp/env-root"}):
            is_enabled, root = network_drop.effective_config({"staging": self.staging})
        self.assertTrue(is_enabled)
        self.assertEqual(root, Path("/tmp/env-root"))

    def test_effective_config_disabled_when_neither_override_nor_environment_set(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            is_enabled, root = network_drop.effective_config({"staging": self.staging})
        self.assertFalse(is_enabled)
        self.assertIsNone(root)

    def test_effective_config_override_path_wins_over_environment(self):
        network_drop.write_live_override(self.staging, "/tmp/live-root")
        with mock.patch.dict(os.environ, {"WSI_INGEST_NETWORK_DROP_ROOT": "/tmp/env-root"}):
            is_enabled, root = network_drop.effective_config({"staging": self.staging})
        self.assertTrue(is_enabled)
        self.assertEqual(root, Path("/tmp/live-root"))

    def test_effective_config_empty_override_disables_even_with_environment_set(self):
        network_drop.write_live_override(self.staging, "")
        with mock.patch.dict(os.environ, {"WSI_INGEST_NETWORK_DROP_ROOT": "/tmp/env-root"}):
            is_enabled, root = network_drop.effective_config({"staging": self.staging})
        self.assertFalse(is_enabled)
        self.assertIsNone(root)


class NetworkDropIntegrationTests(unittest.TestCase):
    """Real-time integration tests against poll_and_relocate itself -- uses
    real (short) sleeps, matching the existing autobatch/daemon test style,
    since the module intentionally calls time.time() internally rather than
    accepting an injectable clock."""

    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        root = Path(self.t.name)
        self.staging = root / "staging"
        self.production = root / "prod"
        self.drop_root = root / "network-drop"
        self.staging.mkdir()
        self.production.mkdir()
        self.drop_root.mkdir()
        (self.production / ".wsi-environment-production").write_text("")
        self.env = dict(
            WSI_INGEST_STAGING_ROOT=str(self.staging), WSI_INGEST_PRODUCTION_ROOT=str(self.production),
            WSI_INGEST_REQUIRED_OBSERVATIONS="2", WSI_INGEST_OBSERVATION_INTERVAL_SECONDS="1",
            WSI_INGEST_MIN_QUIET_SECONDS="1",
            WSI_INGEST_NETWORK_DROP_ROOT=str(self.drop_root),
        )
        self.env_patch = mock.patch.dict(os.environ, self.env, clear=True)
        self.env_patch.start()
        self.tracking = network_drop.TrackingLedger(Path(self.t.name) / "tracking.json")
        self.merge_ledger = wd.autobatch.AutobatchMergeLedger(Path(self.t.name) / "merge.json")
        self.events = []

    def tearDown(self):
        self.env_patch.stop()
        self.t.cleanup()

    def log(self, event, **fields):
        self.events.append((event, fields))

    def event_names(self):
        return [e for e, _ in self.events]

    def write_network_file(self, relative, data):
        path = self.drop_root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def poll(self):
        c = engine.cfg()
        network_drop.poll_and_relocate(c, engine, self.tracking, log=self.log,
                                       merge_ledger=self.merge_ledger)
        return c

    def promote_and_merge(self, stem):
        """Stand in for the daemon's promote-then-merge: the temp wrapper
        is already in staging; a real promote would atomic-rename it into
        production under the same stem, then merge_promoted_autobatch_dataset
        folds the files into production/<dated-parent>/."""
        shutil.move(str(self.staging / stem), str(self.production / stem))
        return wd.merge_promoted_autobatch_dataset(engine.cfg(), self.merge_ledger, stem)

    def test_enabled_reflects_env_var(self):
        self.assertTrue(network_drop.enabled())
        with mock.patch.dict(os.environ, {"WSI_INGEST_NETWORK_DROP_ROOT": ""}):
            self.assertFalse(network_drop.enabled())

    def test_noop_when_configured_root_does_not_exist(self):
        shutil.rmtree(self.drop_root)
        self.poll()  # must not raise
        self.assertEqual(self.events, [])

    def test_growing_file_never_reaches_required_observations(self):
        self.write_network_file("case1/slide.svs", b"x" * 10)
        self.poll()
        self.write_network_file("case1/slide.svs", b"x" * 10000)
        time.sleep(1.1)
        self.poll()
        self.assertFalse((self.staging / "slide").exists())

    def test_stable_slide_relocates_by_stem_and_leaves_the_dated_folder_in_place(self):
        self.write_network_file("case1/slide.svs", b"x" * 100)
        self.poll()
        time.sleep(1.1)
        self.poll()
        self.assertTrue((self.staging / "slide" / "slide.svs").is_file())
        self.assertEqual(wd.autobatch.read_merge_origin(self.staging / "slide"), "case1")
        self.assertTrue((self.drop_root / "case1").is_dir())  # parent stays for later slides
        self.assertFalse((self.drop_root / "case1" / "slide.svs").exists())
        self.assertTrue((self.drop_root / "processed" / "case1" / "slide.svs").is_file())
        self.assertEqual(self.merge_ledger.pending(), {"slide": "case1"})
        self.assertIn("network_drop_relocated", self.event_names())

    def test_dated_subdirectory_structure_is_mirrored_under_processed(self):
        self.write_network_file("2026-08-31/case1/slide.svs", b"x" * 100)
        self.poll()
        time.sleep(1.1)
        self.poll()
        self.assertTrue((self.staging / "slide" / "slide.svs").is_file())
        self.assertEqual(wd.autobatch.read_merge_origin(self.staging / "slide"), "case1")
        self.assertTrue((self.drop_root / "2026-08-31" / "case1").is_dir())
        self.assertTrue((self.drop_root / "processed" / "2026-08-31" / "case1" / "slide.svs").is_file())
        self.assertEqual(self.merge_ledger.pending(), {"slide": "case1"})

    def test_local_name_collision_leaves_network_original_untouched(self):
        (self.staging / "slide").mkdir()
        self.write_network_file("case1/slide.svs", b"x" * 100)
        self.poll()
        time.sleep(1.1)
        self.poll()
        self.assertTrue((self.drop_root / "case1" / "slide.svs").is_file())
        self.assertIn("network_drop_relocate_name_collision", self.event_names())

    def test_orphaned_temp_dir_from_a_crash_is_cleaned_up_next_pass(self):
        orphan = self.staging / f"{network_drop.TEMP_PREFIX}deadbeef"
        orphan.mkdir()
        (orphan / "partial.svs").write_bytes(b"x")
        self.poll()
        self.assertFalse(orphan.exists())
        self.assertIn("network_drop_cleaned_orphaned_temp_dirs", self.event_names())

    def test_relocate_excludes_noise_from_the_copy_and_leaves_it_on_the_share(self):
        # Thumbs.db arriving from a Windows-side SMB write has been observed
        # to fail shutil.copy2's copystat with PermissionError. Noise is not
        # part of a slide unit, so it is never copied (and never moved to
        # processed); it stays in the dated folder on the share.
        self.write_network_file("case1/slide.svs", b"x" * 100)
        self.write_network_file("case1/Thumbs.db", b"windows junk")
        self.write_network_file("case1/.DS_Store", b"finder junk")
        self.poll()
        time.sleep(1.1)
        self.poll()
        copied = sorted(p.name for p in (self.staging / "slide").iterdir())
        self.assertEqual([wd.autobatch.MERGE_ORIGIN_FILENAME, "slide.svs"], copied)
        self.assertEqual(wd.autobatch.read_merge_origin(self.staging / "slide"), "case1")
        self.assertTrue((self.drop_root / "processed" / "case1" / "slide.svs").is_file())
        remaining = sorted(p.name for p in (self.drop_root / "case1").iterdir())
        self.assertEqual([".DS_Store", "Thumbs.db"], remaining)
        self.assertIn("network_drop_relocated", self.event_names())
        self.assertNotIn("network_drop_copy_failed", self.event_names())

    def test_noise_file_churn_does_not_reset_the_stability_clock(self):
        self.write_network_file("case1/slide.svs", b"x" * 100)
        self.write_network_file("case1/.DS_Store", b"a")
        self.poll()
        self.write_network_file("case1/.DS_Store", b"a different size, as if just Finder-rewritten")
        time.sleep(1.1)
        self.poll()
        self.assertTrue((self.staging / "slide" / "slide.svs").is_file())
        self.assertIn("network_drop_relocated", self.event_names())

    def test_relocate_unit_never_touches_source_on_fingerprint_mismatch(self):
        c = engine.cfg()
        self.write_network_file("case1/slide.svs", b"x" * 50)
        unit = network_drop.discover_units(self.drop_root, engine)[0]
        bogus_fingerprint = [["slide.svs", 999999]]
        result = network_drop.relocate_unit(
            c, engine, self.drop_root, unit, bogus_fingerprint, self.log, self.merge_ledger)
        self.assertFalse(result)
        self.assertTrue((self.drop_root / "case1" / "slide.svs").is_file())
        self.assertFalse((self.staging / "slide").exists())
        self.assertIn("network_drop_copy_mismatch", self.event_names())

    def test_processed_directory_is_never_rediscovered_as_a_new_candidate(self):
        self.write_network_file("case1/slide.svs", b"x" * 100)
        self.poll()
        time.sleep(1.1)
        self.poll()  # relocates the one slide
        self.events.clear()
        time.sleep(1.1)
        self.poll()  # nothing new should happen
        self.assertNotIn("network_drop_relocated", self.event_names())

    # --- live override precedence over the environment variable, exercised
    #     through poll_and_relocate() itself -- this is what lets
    #     ops/wsi_ops_dashboard.py's field take effect on an already-running
    #     daemon's very next poll, with no restart of anything. ------------

    def test_live_override_enables_relocation_even_when_environment_variable_unset(self):
        os.environ.pop("WSI_INGEST_NETWORK_DROP_ROOT", None)
        live_only_root = Path(self.t.name) / "live-only-drop"
        live_only_root.mkdir()
        network_drop.write_live_override(self.staging, str(live_only_root))
        path = live_only_root / "case1" / "slide.svs"
        path.parent.mkdir(parents=True)
        path.write_bytes(b"x" * 100)

        c = engine.cfg()
        network_drop.poll_and_relocate(c, engine, self.tracking, log=self.log,
                                       merge_ledger=self.merge_ledger)
        time.sleep(1.1)
        network_drop.poll_and_relocate(c, engine, self.tracking, log=self.log,
                                       merge_ledger=self.merge_ledger)

        self.assertTrue((self.staging / "slide" / "slide.svs").is_file())
        self.assertIn("network_drop_relocated", self.event_names())

    def test_live_override_empty_disables_relocation_even_when_environment_variable_set(self):
        # WSI_INGEST_NETWORK_DROP_ROOT is already set to self.drop_root in setUp.
        network_drop.write_live_override(self.staging, "")
        self.write_network_file("case1/slide.svs", b"x" * 100)
        self.poll()
        time.sleep(1.1)
        self.poll()
        self.assertFalse((self.staging / "slide").exists())
        self.assertTrue((self.drop_root / "case1" / "slide.svs").is_file())  # untouched
        self.assertNotIn("network_drop_relocated", self.event_names())

    def test_live_override_can_repoint_to_a_different_root_between_polls(self):
        first_root = self.drop_root
        second_root = Path(self.t.name) / "second-drop"
        second_root.mkdir()
        (second_root / "case2").mkdir()
        (second_root / "case2" / "beta.svs").write_bytes(b"x" * 100)

        self.write_network_file("case1/alpha.svs", b"x" * 100)
        self.poll()  # 1st observation of alpha, against the env-var root (first_root)
        network_drop.write_live_override(self.staging, str(second_root))
        time.sleep(1.1)
        self.poll()  # now live-controlled: scans second_root instead -- alpha no longer even observed
        time.sleep(1.1)
        self.poll()  # beta's 2nd observation + past the quiet window -- relocates

        self.assertFalse((self.staging / "alpha").exists())  # never relocated -- root changed mid-tracking
        self.assertTrue((first_root / "case1" / "alpha.svs").is_file())
        self.assertFalse((first_root / "processed").exists())
        self.assertTrue((self.staging / "beta" / "beta.svs").is_file())
        self.assertTrue((second_root / "processed" / "case2" / "beta.svs").is_file())

    def test_vsi_is_not_copied_until_its_companion_folder_is_present_and_stable(self):
        self.write_network_file("20260831/slide.vsi", b"x" * 100)
        self.poll()
        time.sleep(1.1)
        self.poll()
        self.assertFalse((self.staging / "slide").exists())
        self.write_network_file("20260831/_slide_/tile.dat", b"y" * 50)
        self.poll()
        time.sleep(1.1)
        self.poll()
        self.assertTrue((self.staging / "slide" / "slide.vsi").is_file())
        self.assertTrue((self.staging / "slide" / "_slide_" / "tile.dat").is_file())
        self.assertEqual(self.merge_ledger.pending(), {"slide": "20260831"})

    def test_one_pass_copies_at_most_one_ready_slide(self):
        self.write_network_file("20260831/a.svs", b"x" * 10)
        self.write_network_file("20260831/b.svs", b"x" * 20)
        self.poll()
        time.sleep(1.1)
        self.poll()
        staged = sorted(p.name for p in self.staging.iterdir() if p.is_dir() and not p.name.startswith("."))
        self.assertEqual(staged, ["a"])
        self.assertTrue((self.drop_root / "20260831" / "b.svs").is_file())

    def test_repeat_scans_with_distinct_timestamps_share_one_dated_production_folder(self):
        # VS200 names a repeat scan of the same physical slide with a new
        # timestamp in the filename. Those are two slides, not duplicates.
        self.write_network_file("20260831/slide_20260831_120000.svs", b"a" * 10)
        self.write_network_file("20260831/slide_20260831_150000.svs", b"b" * 20)
        self.poll()
        time.sleep(1.1)
        self.poll()
        self.promote_and_merge("slide_20260831_120000")
        self.poll()
        self.promote_and_merge("slide_20260831_150000")
        names = sorted(p.name for p in (self.production / "20260831").iterdir())
        self.assertEqual(["slide_20260831_120000.svs", "slide_20260831_150000.svs"], names)
        self.assertTrue((self.drop_root / "20260831").is_dir())
        self.assertFalse((self.production / "slide_20260831_120000").exists())
        self.assertFalse((self.production / "slide_20260831_150000").exists())

    def test_identical_scan_filename_is_not_merged_as_a_duplicate(self):
        # The same scan file appearing again (same basename, including the
        # scanner timestamp) is a duplicate, not a repeat scan.
        self.write_network_file("20260831/slide_20260831_120000.svs", b"a" * 10)
        self.poll()
        time.sleep(1.1)
        self.poll()
        self.promote_and_merge("slide_20260831_120000")
        self.write_network_file("20260831/slide_20260831_120000.svs", b"a" * 10)
        self.poll()
        time.sleep(1.1)
        self.poll()
        self.promote_and_merge("slide_20260831_120000")
        names = sorted(p.name for p in (self.production / "20260831").iterdir())
        self.assertEqual(["slide_20260831_120000.svs"], names)
        self.assertFalse((self.production / "slide_20260831_120000").exists())

    def test_merge_uses_in_wrapper_marker_when_ledger_is_empty(self):
        self.write_network_file("20260831/slide.svs", b"x" * 100)
        self.poll()
        time.sleep(1.1)
        self.poll()
        self.assertEqual(wd.autobatch.read_merge_origin(self.staging / "slide"), "20260831")
        self.merge_ledger.clear("slide")
        result = self.promote_and_merge("slide")
        self.assertEqual(result, "20260831")
        self.assertTrue((self.production / "20260831" / "slide.svs").is_file())
        self.assertFalse((self.production / "slide").exists())
        self.assertFalse((self.production / "20260831" / wd.autobatch.MERGE_ORIGIN_FILENAME).exists())


if __name__ == "__main__":
    unittest.main()
