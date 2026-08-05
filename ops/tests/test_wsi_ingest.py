import contextlib, io, os, shutil, stat, subprocess, tempfile, unittest
from pathlib import Path
from unittest import mock
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import wsi_ingest as wi

class Result:
    def __init__(self, code, out='', err=''):
        self.returncode=code; self.stdout=out; self.stderr=err

class IngestTests(unittest.TestCase):
    def setUp(self):
        self.t=tempfile.TemporaryDirectory(); r=Path(self.t.name); self.st=r/'staging'; self.pr=r/'prod'; self.st.mkdir(); self.pr.mkdir(); (self.pr/'.wsi-environment-production').write_text('')
        self.env=dict(WSI_INGEST_STAGING_ROOT=str(self.st), WSI_INGEST_PRODUCTION_ROOT=str(self.pr), WSI_INGEST_REQUIRED_OBSERVATIONS='3', WSI_INGEST_OBSERVATION_INTERVAL_SECONDS='10', WSI_INGEST_MIN_QUIET_SECONDS='20')
        self.now=2000000000.0
    def tearDown(self): self.t.cleanup()
    def invoke(self,*args,input=''):
        out=io.StringIO(); err=io.StringIO()
        with mock.patch.dict(os.environ,self.env,clear=False), mock.patch('wsi_ingest.time.time',return_value=self.now), mock.patch('builtins.input',return_value=input.rstrip('\n')), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try: wi.main(list(args)); return Result(0,out.getvalue(),err.getvalue())
            except wi.Fail as e: print('FAIL',e.cat+':',str(e),file=err); return Result(1,out.getvalue(),err.getvalue())
            except SystemExit as e: return Result(e.code or 0,out.getvalue(),err.getvalue())
    def cli(self,*args,input=''):
        e=os.environ.copy(); e.update(self.env); return subprocess.run([str(Path(__file__).parents[1]/'wsi-ingest'),*args],input=input,text=True,capture_output=True,env=e)
    def ds(self,n='case'):
        d=self.st/n; d.mkdir(); (d/'slide.vsi').write_text('vsi'); (d/'slide_data').mkdir(); (d/'slide_data'/'a.bin').write_text('x'); return d
    def seal_obs(self,n='case'):
        self.now=2000000000.0; self.ds(n); self.assertEqual(self.invoke('seal',n,input='SEAL\n').returncode,0)
        self.now=2000000010.0; self.assertEqual(self.invoke('observe',n).returncode,0)
        self.now=2000000021.0; self.assertEqual(self.invoke('observe',n).returncode,0)
    def test_missing_configuration(self):
        self.env={}; self.assertNotEqual(self.invoke('status').returncode,0)
    def test_disjoint_and_nested_root_rejection(self):
        self.assertIn('canonical_disjoint: true', self.cli('status').stdout)
        self.env['WSI_INGEST_PRODUCTION_ROOT']=str(self.st/'p'); (self.st/'p').mkdir(); self.assertNotEqual(self.invoke('status').returncode,0)
    def test_marker_validation(self):
        (self.pr/'.wsi-environment-staging').write_text(''); self.assertIn('production_marker_exact: False', self.invoke('status').stdout); self.ds(); self.assertNotEqual(self.invoke('inspect','case').returncode,0)
    def test_dataset_name_validation(self):
        for n in ['','/x','a/b','..','.','a\\b']:
            self.assertNotEqual(self.invoke('inspect',n).returncode,0)
    def test_symlink_and_unsupported_rejection(self):
        os.symlink(self.st, self.st/'link'); self.assertNotEqual(self.invoke('inspect','link').returncode,0)
        d=self.ds('s'); os.symlink(d/'slide.vsi', d/'ln'); self.assertNotEqual(self.invoke('inspect','s').returncode,0)
        e=self.st/'empty'; e.mkdir(); (e/'x.txt').write_text('x'); self.assertNotEqual(self.invoke('inspect','empty').returncode,0)
    def test_inspect_readonly_and_aggregate(self):
        self.ds(); before=sorted(str(p.relative_to(self.st)) for p in self.st.rglob('*')); p=self.invoke('inspect','case'); after=sorted(str(p.relative_to(self.st)) for p in self.st.rglob('*'))
        self.assertEqual(before,after); self.assertIn('regular_files:',p.stdout); self.assertNotIn('slide.vsi',p.stdout)
    def test_seal_confirmation_permissions_determinism(self):
        self.ds(); self.assertNotEqual(self.invoke('seal','case',input='NO\n').returncode,0); self.assertEqual(self.invoke('seal','case',input='SEAL\n').returncode,0)
        c=self.st/'.wsi-ingest-control'; self.assertEqual(stat.S_IMODE(c.stat().st_mode),0o700)
        mans=list(c.glob('*.manifest.json')); self.assertEqual(stat.S_IMODE(mans[0].stat().st_mode),0o600)
        first=mans[0].read_text(); self.assertEqual(self.invoke('seal','case',input='SEAL\n').returncode,0); self.assertEqual(first,mans[0].read_text())
    def test_observation_spacing_and_config(self):
        self.ds(); self.invoke('seal','case',input='SEAL\n'); self.assertNotEqual(self.invoke('observe','case').returncode,0); self.now=2000000010.0; self.assertEqual(self.invoke('observe','case').returncode,0)
        self.env['WSI_INGEST_REQUIRED_OBSERVATIONS']='1'; self.assertNotEqual(self.invoke('status').returncode,0)
    def test_changes_after_seal_invalidate_and_reseal_required(self):
        self.ds(); self.invoke('seal','case',input='SEAL\n'); (self.st/'case'/'new.vsi').write_text('x'); self.now=2000000010.0; self.assertNotEqual(self.invoke('observe','case').returncode,0); self.assertNotEqual(self.invoke('observe','case').returncode,0)
    def test_dry_run_no_mutation_and_missing_observations(self):
        self.ds(); self.invoke('seal','case',input='SEAL\n'); self.now=2000000030.0; before=sorted(str(p.relative_to(self.st)) for p in self.st.rglob('*')); p=self.invoke('promote','--dry-run','case'); self.assertNotEqual(p.returncode,0); self.assertEqual(before, sorted(str(p.relative_to(self.st)) for p in self.st.rglob('*')))
    def test_success_atomic_rename_journal_recovery_history_privacy(self):
        self.seal_obs(); p=self.invoke('promote','--step','case',input='PROMOTE\n'); self.assertEqual(p.returncode,0,p.stderr); self.assertFalse((self.st/'case').exists()); self.assertTrue((self.pr/'case').exists()); self.assertTrue(list((self.st/'.wsi-ingest-control').glob('*.receipt.json')))
        h=self.invoke('history'); self.assertNotIn('slide.vsi',h.stdout); self.assertIn('observations',h.stdout)
    def test_wrong_promote_destination_collision(self):
        self.seal_obs(); (self.pr/'case').mkdir(); p=self.invoke('promote','--step','case',input='BAD\n'); self.assertNotEqual(p.returncode,0)
    def test_recover_before_and_after_rename_and_ambiguous(self):
        self.seal_obs();
        with mock.patch('wsi_ingest.atomic_rename_noreplace',side_effect=wi.Fail('fault','before')):
            self.assertNotEqual(self.invoke('promote','--step','case',input='PROMOTE\n').returncode,0)
        self.assertIn('preserve source', self.invoke('recover').stdout)
        shutil.rmtree(self.st/'case'); [x.unlink() for x in (self.st/'.wsi-ingest-control').glob('case*')]; self.seal_obs()
        original=wi.atomic_rename_noreplace
        def after(src,dst): original(src,dst); raise wi.Fail('fault','after')
        with mock.patch('wsi_ingest.atomic_rename_noreplace',side_effect=after):
            self.assertNotEqual(self.invoke('promote','--step','case',input='PROMOTE\n').returncode,0)
        self.assertIn('recovered verified', self.invoke('recover').stdout)
    def test_read_only_commands_do_not_create_control_state(self):
        self.assertFalse((self.st/'.wsi-ingest-control').exists()); self.invoke('status'); self.assertFalse((self.st/'.wsi-ingest-control').exists())
        self.ds(); self.invoke('inspect','case'); self.assertFalse((self.st/'.wsi-ingest-control').exists())
        p=self.invoke('promote','--dry-run','case'); self.assertNotEqual(p.returncode,0); self.assertFalse((self.st/'.wsi-ingest-control').exists())
    def test_native_no_replace_race_leaves_both_trees_and_no_receipt(self):
        self.seal_obs(); original=wi.atomic_rename_noreplace
        def race(src,dst): Path(dst).mkdir(); return original(src,dst)
        with mock.patch('wsi_ingest.atomic_rename_noreplace',side_effect=race): p=self.invoke('promote','--step','case',input='PROMOTE\n')
        self.assertNotEqual(p.returncode,0); self.assertTrue((self.st/'case'/'slide.vsi').exists()); self.assertTrue((self.pr/'case').exists()); self.assertFalse(list((self.st/'.wsi-ingest-control').glob('*.receipt.json')))
    def test_recover_refuses_multiple_incomplete_transactions_with_opaque_ids(self):
        self.seal_obs();
        with mock.patch('wsi_ingest.atomic_rename_noreplace',side_effect=wi.Fail('fault','before')): self.assertNotEqual(self.invoke('promote','--step','case',input='PROMOTE\n').returncode,0)
        self.seal_obs('case2')
        with mock.patch('wsi_ingest.atomic_rename_noreplace',side_effect=wi.Fail('fault','before')): self.assertNotEqual(self.invoke('promote','--step','case2',input='PROMOTE\n').returncode,0)
        r=self.invoke('recover'); self.assertNotEqual(r.returncode,0); self.assertIn('multiple incomplete transactions:', r.stdout); self.assertNotIn('slide.vsi', r.stdout + r.stderr)
    def test_no_test_environment_hooks_in_production_source(self):
        text=Path(wi.__file__).read_text()
        for token in ['WSI_INGEST_TEST_','TEST_NOW','TEST_FAULT','TEST_DEST_RACE']: self.assertNotIn(token,text)
    def test_no_force_option_and_lock(self):
        p=self.invoke('promote','--force','case'); self.assertNotEqual(p.returncode,0)

if __name__=='__main__': unittest.main()
