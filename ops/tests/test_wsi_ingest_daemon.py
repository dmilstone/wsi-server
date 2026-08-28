import argparse, io, json, os, sys, tempfile, time, unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import wsi_ingest_daemon as wd

engine = wd.engine


class Result:
    def __init__(self, code, out='', err=''):
        self.returncode = code; self.stdout = out; self.stderr = err


def fail_result(category, message='fixture failure'):
    return Result(1, '', f'FAIL {category}: {message}\n')


def action_of(args):
    if args[0] == 'promote':
        return 'promote-dry-run' if '--dry-run' in args else 'promote-step'
    return args[0]


def fake_run_ingest(responses):
    calls = []

    def fake(args, confirmation=None, timeout=None):
        calls.append((tuple(args), confirmation))
        action = action_of(args)
        resp = responses.get(action, Result(0))
        return resp(args, confirmation) if callable(resp) else resp

    fake.calls = calls
    return fake


class DaemonTests(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        r = Path(self.t.name)
        self.st = r / 'staging'; self.pr = r / 'prod'
        self.st.mkdir(); self.pr.mkdir()
        (self.pr / '.wsi-environment-production').write_text('')
        self.env = dict(
            WSI_INGEST_STAGING_ROOT=str(self.st), WSI_INGEST_PRODUCTION_ROOT=str(self.pr),
            WSI_INGEST_REQUIRED_OBSERVATIONS='3', WSI_INGEST_OBSERVATION_INTERVAL_SECONDS='10',
            WSI_INGEST_MIN_QUIET_SECONDS='20',
        )
        self.env_patch = mock.patch.dict(os.environ, self.env, clear=True)
        self.env_patch.start()

    def tearDown(self):
        self.env_patch.stop()
        self.t.cleanup()

    def make_dataset(self, name='case', suffix='.vsi', content='vsi-content'):
        d = self.st / name; d.mkdir()
        (d / ('slide' + suffix)).write_text(content)
        return d

    def seal(self, name='case'):
        with mock.patch('builtins.input', return_value='SEAL'):
            engine.cmd_seal(argparse.Namespace(dataset=name))

    def observe(self, name='case'):
        engine.cmd_observe(argparse.Namespace(dataset=name))

    def log_lines(self, c):
        p = wd.log_path(c)
        if not p.exists():
            return []
        return [json.loads(line) for line in p.read_text().splitlines() if line.strip()]

    # --- new dataset discovery / sealing -----------------------------------

    def test_new_dataset_gets_sealed(self):
        self.make_dataset('new-case')
        c = engine.cfg()
        fake = fake_run_ingest({'seal': Result(0, 'sealed transaction: abc\n')})
        with mock.patch('wsi_ingest_daemon.run_ingest', fake):
            wd.run_pass(c, wd.IntegrityLedger(self.st / 'ledger.json', 5), '')
        self.assertEqual(fake.calls, [(('seal', 'new-case'), 'SEAL')])
        events = [e['event'] for e in self.log_lines(c)]
        self.assertIn('sealed', events)

    def test_unsupported_dataset_is_silently_retried(self):
        d = self.st / 'still-arriving'; d.mkdir()
        c = engine.cfg()
        fake = fake_run_ingest({'seal': fail_result('unsupported')})
        with mock.patch('wsi_ingest_daemon.run_ingest', fake):
            wd.run_pass(c, wd.IntegrityLedger(self.st / 'ledger.json', 5), '')
        self.assertEqual(len(fake.calls), 1)
        events = [e['event'] for e in self.log_lines(c)]
        self.assertNotIn('seal_failed', events)

    def test_unexpected_seal_failure_is_logged(self):
        self.make_dataset('bad')
        c = engine.cfg()
        fake = fake_run_ingest({'seal': fail_result('symlink')})
        with mock.patch('wsi_ingest_daemon.run_ingest', fake):
            wd.run_pass(c, wd.IntegrityLedger(self.st / 'ledger.json', 5), '')
        events = [e for e in self.log_lines(c) if e['event'] == 'seal_failed']
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]['category'], 'symlink')

    # --- observe / promote progression --------------------------------------

    def test_sealed_dataset_progresses_through_observe_and_promote_with_refresh(self):
        self.make_dataset('case')
        self.seal('case')
        c = engine.cfg()
        fake = fake_run_ingest({
            'observe': Result(0),
            'promote-dry-run': Result(0, 'dry_run: ok\n'),
            'promote-step': Result(0, 'promoted transaction: abc\n'),
        })
        refreshed = []
        with mock.patch('wsi_ingest_daemon.run_ingest', fake), \
             mock.patch('wsi_ingest_daemon.notify_server_refresh', side_effect=lambda url, **k: refreshed.append(url) or None):
            wd.run_pass(c, wd.IntegrityLedger(self.st / 'ledger.json', 5), 'http://127.0.0.1:8080')
        actions = [action_of(args) for args, _ in fake.calls]
        self.assertEqual(actions, ['observe', 'promote-dry-run', 'promote-step'])
        self.assertEqual(fake.calls[-1][1], 'PROMOTE')
        self.assertEqual(refreshed, ['http://127.0.0.1:8080'])
        events = [e['event'] for e in self.log_lines(c)]
        self.assertEqual(events, ['observed', 'promoted'])

    def test_stability_failures_are_not_logged_as_errors(self):
        self.make_dataset('case'); self.seal('case')
        c = engine.cfg()
        fake = fake_run_ingest({'observe': fail_result('stability', 'observation attempted too early')})
        with mock.patch('wsi_ingest_daemon.run_ingest', fake):
            wd.run_pass(c, wd.IntegrityLedger(self.st / 'ledger.json', 5), '')
        self.assertEqual(self.log_lines(c), [])

    def test_moved_phase_triggers_recover_not_observe(self):
        self.make_dataset('case'); self.seal('case')
        c = engine.cfg()
        engine.journal(c, 'case', 'moved')
        fake = fake_run_ingest({'recover': Result(0, 'recovered verified transaction: abc\n')})
        with mock.patch('wsi_ingest_daemon.run_ingest', fake):
            wd.run_pass(c, wd.IntegrityLedger(self.st / 'ledger.json', 5), '')
        self.assertEqual([action_of(a) for a, _ in fake.calls], ['recover'])
        events = [e['event'] for e in self.log_lines(c)]
        self.assertIn('recovered', events)

    def test_invalidated_dataset_is_resealed_not_observed(self):
        self.make_dataset('case'); self.seal('case')
        c = engine.cfg()
        sf, *_ = engine.state_files(c, 'case')
        st = json.loads(sf.read_text()); st['invalidated'] = True
        engine.atomic_write(sf, json.dumps(st, sort_keys=True))
        fake = fake_run_ingest({'seal': Result(0)})
        with mock.patch('wsi_ingest_daemon.run_ingest', fake):
            wd.run_pass(c, wd.IntegrityLedger(self.st / 'ledger.json', 5), '')
        self.assertEqual([action_of(a) for a, _ in fake.calls], ['seal'])
        events = [e['event'] for e in self.log_lines(c)]
        self.assertIn('resealed', events)

    def test_verified_dataset_is_left_alone(self):
        self.make_dataset('case'); self.seal('case')
        c = engine.cfg()
        engine.journal(c, 'case', 'verified')
        engine.receipt(c, 'case', json.loads(engine.state_files(c, 'case')[0].read_text()))
        fake = fake_run_ingest({})
        with mock.patch('wsi_ingest_daemon.run_ingest', fake):
            wd.run_pass(c, wd.IntegrityLedger(self.st / 'ledger.json', 5), '')
        self.assertEqual(fake.calls, [])

    # --- integrity probe -----------------------------------------------------

    def integrity_ready(self, name):
        self.make_dataset(name)
        self.seal(name)

    def test_valid_generic_container_passes_probe_and_promotes(self):
        self.integrity_ready('case')
        c = engine.cfg()
        fake = fake_run_ingest({'observe': Result(0), 'promote-dry-run': Result(0), 'promote-step': Result(0)})
        with mock.patch('wsi_ingest_daemon.run_ingest', fake):
            wd.run_pass(c, wd.IntegrityLedger(self.st / 'ledger.json', 5), '')
        self.assertIn('promote-step', [action_of(a) for a, _ in fake.calls])

    def test_truncated_tiff_blocks_promotion_and_escalates_after_retry_limit(self):
        d = self.st / 'case'; d.mkdir()
        # A byte-order magic with an IFD offset that points past the (tiny) file --
        # exactly the shape a truncated write leaves behind.
        (d / 'slide.svs').write_bytes(b'II*\x00' + (10_000).to_bytes(4, 'little') + b'short')
        self.seal('case')
        c = engine.cfg()
        ledger = wd.IntegrityLedger(self.st / 'ledger.json', 2)
        fake = fake_run_ingest({'observe': Result(0), 'promote-dry-run': Result(0)})
        with mock.patch('wsi_ingest_daemon.run_ingest', fake):
            wd.run_pass(c, ledger, '')
            wd.run_pass(c, ledger, '')
        self.assertNotIn('promote-step', [action_of(a) for a, _ in fake.calls])
        key = wd.short_hash('case')
        self.assertTrue(ledger.is_escalated(key))
        events = [e['event'] for e in self.log_lines(c)]
        self.assertEqual(events.count('integrity_check_failed'), 2)
        # A third pass must not even re-run the probe -- it should skip immediately.
        with mock.patch('wsi_ingest_daemon.run_ingest', fake), \
             mock.patch('wsi_ingest_daemon.probe_integrity') as probe:
            wd.run_pass(c, ledger, '')
        probe.assert_not_called()
        self.assertIn('integrity_escalated_skip', [e['event'] for e in self.log_lines(c)])

    def test_valid_tiff_header_passes_probe(self):
        d = self.st / 'case'; d.mkdir()
        body = b'not a real tiff but big enough' * 10
        (d / 'slide.svs').write_bytes(b'II*\x00' + (8).to_bytes(4, 'little') + body)
        ok, detail = wd.probe_tiff_integrity(d / 'slide.svs')
        self.assertTrue(ok, detail)

    def test_no_recognized_container_fails_probe(self):
        d = self.st / 'case'; d.mkdir()
        (d / 'notes.txt').write_text('not a slide')
        ok, detail = wd.probe_integrity(d)
        self.assertFalse(ok)

    # --- sidecar OCR (post-promotion clinical-marker automation) --------------

    def test_promotion_queues_dataset_for_sidecar_ocr(self):
        self.make_dataset('case'); self.seal('case')
        c = engine.cfg()
        fake = fake_run_ingest({'observe': Result(0), 'promote-dry-run': Result(0), 'promote-step': Result(0)})
        sidecar_ledger = wd.SidecarLedger(self.st / 'sidecar.json', 5)
        with mock.patch('wsi_ingest_daemon.run_ingest', fake), \
             mock.patch('wsi_ingest_daemon.run_pending_sidecar_ocr') as run_pending:
            wd.run_pass(c, wd.IntegrityLedger(self.st / 'ledger.json', 5), '', sidecar_ledger)
        self.assertEqual(sidecar_ledger.pending_names(), ['case'])
        run_pending.assert_called_once()

    def test_dataset_sidecar_resolved_distinguishes_placeholder_from_real_status(self):
        d = self.pr / 'case'; d.mkdir()
        (d / 'slide.vsi').write_text('x')
        self.assertFalse(wd.dataset_sidecar_resolved(d))  # no sidecar written yet
        (d / 'slide.metadata.json').write_text(json.dumps({'status': 'synchronized_via_retro_sweep'}))
        self.assertFalse(wd.dataset_sidecar_resolved(d))  # server never actually answered
        (d / 'slide.metadata.json').write_text(
            json.dumps({'clinicalMarker': 'if.IgG', 'status': 'updated_via_epitope_ocr'}))
        self.assertTrue(wd.dataset_sidecar_resolved(d))

    def test_run_sidecar_ocr_scopes_to_only_dir_and_forwards_server_url(self):
        c = engine.cfg()
        (self.pr / 'case').mkdir()
        captured = {}

        def fake_subprocess_run(cmd, **kwargs):
            captured['cmd'] = cmd
            return Result(0, 'ok')

        with mock.patch('wsi_ingest_daemon.subprocess.run', side_effect=fake_subprocess_run):
            wd.run_sidecar_ocr(c, 'case', 'http://127.0.0.1:8080')
        cmd = captured['cmd']
        self.assertIn('--only-dir', cmd)
        self.assertEqual(cmd[cmd.index('--only-dir') + 1], str(c['production'] / 'case'))
        self.assertIn('--server-url', cmd)
        self.assertEqual(cmd[cmd.index('--server-url') + 1], 'http://127.0.0.1:8080')

    def test_pending_sidecar_ocr_resolves_and_clears_ledger(self):
        d = self.pr / 'case'; d.mkdir()
        (d / 'slide.vsi').write_text('x')
        c = engine.cfg()
        sidecar_ledger = wd.SidecarLedger(self.st / 'sidecar.json', 5)
        sidecar_ledger.add('case')

        def fake_ocr(c_arg, name, server_url, timeout=120):
            (d / 'slide.metadata.json').write_text(
                json.dumps({'clinicalMarker': 'if.IgG', 'status': 'updated_via_epitope_ocr'}))
            return Result(0, 'ok')

        with mock.patch('wsi_ingest_daemon.run_sidecar_ocr', side_effect=fake_ocr):
            wd.run_pending_sidecar_ocr(c, sidecar_ledger, 'http://127.0.0.1:8080')
        self.assertEqual(sidecar_ledger.pending_names(), [])
        events = [e['event'] for e in self.log_lines(c)]
        self.assertIn('sidecar_resolved', events)

    def test_pending_sidecar_ocr_retries_then_escalates(self):
        d = self.pr / 'case'; d.mkdir()
        (d / 'slide.vsi').write_text('x')
        c = engine.cfg()
        sidecar_ledger = wd.SidecarLedger(self.st / 'sidecar.json', 2)
        sidecar_ledger.add('case')
        with mock.patch('wsi_ingest_daemon.run_sidecar_ocr', return_value=Result(0, 'pending')):
            wd.run_pending_sidecar_ocr(c, sidecar_ledger, 'http://127.0.0.1:8080')
            wd.run_pending_sidecar_ocr(c, sidecar_ledger, 'http://127.0.0.1:8080')
        self.assertTrue(sidecar_ledger.is_escalated('case'))
        with mock.patch('wsi_ingest_daemon.run_sidecar_ocr') as ocr:
            wd.run_pending_sidecar_ocr(c, sidecar_ledger, 'http://127.0.0.1:8080')
        ocr.assert_not_called()
        self.assertEqual(sidecar_ledger.pending_names(), [])
        events = [e['event'] for e in self.log_lines(c)]
        self.assertIn('sidecar_escalated_skip', events)

    def test_pending_sidecar_ocr_drops_missing_dataset_directory(self):
        c = engine.cfg()
        sidecar_ledger = wd.SidecarLedger(self.st / 'sidecar.json', 5)
        sidecar_ledger.add('ghost')
        with mock.patch('wsi_ingest_daemon.run_sidecar_ocr') as ocr:
            wd.run_pending_sidecar_ocr(c, sidecar_ledger, 'http://127.0.0.1:8080')
        ocr.assert_not_called()
        self.assertEqual(sidecar_ledger.pending_names(), [])

    def test_no_refresh_url_skips_sidecar_step_entirely(self):
        c = engine.cfg()
        sidecar_ledger = wd.SidecarLedger(self.st / 'sidecar.json', 5)
        sidecar_ledger.add('case')
        with mock.patch('wsi_ingest_daemon.run_sidecar_ocr') as ocr:
            wd.run_pending_sidecar_ocr(c, sidecar_ledger, '')
        ocr.assert_not_called()
        self.assertEqual(sidecar_ledger.pending_names(), ['case'])

    # --- pause / stop control -------------------------------------------------

    def test_pause_sentinel_prevents_new_work(self):
        self.make_dataset('case')
        c = engine.cfg()
        pause = wd.daemon_control_dir(c) / wd.PAUSE_SENTINEL
        pause.write_text('')
        with mock.patch('wsi_ingest_daemon.run_pass') as run_pass:
            wd.main(['--once'])
        run_pass.assert_not_called()

    def test_stop_sentinel_ends_loop_immediately(self):
        c_placeholder = None  # cfg() needs env, already patched in setUp
        c = engine.cfg()
        stop = wd.daemon_control_dir(c) / wd.STOP_SENTINEL
        stop.write_text('')
        started = time.time()
        with mock.patch('wsi_ingest_daemon.run_pass') as run_pass:
            rc = wd.main(['--interval', '999'])
        self.assertEqual(rc, 0)
        self.assertLess(time.time() - started, 5)
        run_pass.assert_not_called()

    def test_missing_staging_root_fails_fast(self):
        os.environ['WSI_INGEST_STAGING_ROOT'] = str(self.st / 'does-not-exist')
        self.assertEqual(wd.main(['--once']), 1)

    # --- privacy ---------------------------------------------------------------

    def test_log_never_contains_raw_dataset_name(self):
        identifying_name = 'Patient-Identifying-Folder-Name'
        self.make_dataset(identifying_name)
        c = engine.cfg()
        fake = fake_run_ingest({'seal': Result(0)})
        with mock.patch('wsi_ingest_daemon.run_ingest', fake):
            wd.run_pass(c, wd.IntegrityLedger(self.st / 'ledger.json', 5), '')
        raw_log_text = wd.log_path(c).read_text()
        self.assertNotIn(identifying_name, raw_log_text)
        self.assertIn(wd.short_hash(identifying_name), raw_log_text)

    # --- end-to-end smoke test with real subprocesses --------------------------

    def test_end_to_end_real_subprocess_promotes_dataset(self):
        os.environ.update(dict(
            WSI_INGEST_REQUIRED_OBSERVATIONS='2', WSI_INGEST_OBSERVATION_INTERVAL_SECONDS='1',
            WSI_INGEST_MIN_QUIET_SECONDS='1',
        ))
        self.make_dataset('real-case')
        self.assertEqual(wd.main(['--once']), 0)  # seals
        time.sleep(1.1)
        self.assertEqual(wd.main(['--once']), 0)  # first observation
        time.sleep(1.1)
        self.assertEqual(wd.main(['--once']), 0)  # second observation + promote
        self.assertTrue((self.pr / 'real-case').exists())
        self.assertFalse((self.st / 'real-case').exists())


if __name__ == '__main__':
    unittest.main()
