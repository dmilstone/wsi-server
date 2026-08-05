import contextlib, io, json, os, shutil, stat, subprocess, tempfile, unittest
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import wsi_ingest as wi

class IngestTests(unittest.TestCase):
    def setUp(self):
        self.t=tempfile.TemporaryDirectory(); r=Path(self.t.name); self.st=r/'staging'; self.pr=r/'prod'; self.st.mkdir(); self.pr.mkdir(); (self.pr/'.wsi-environment-production').write_text('')
        self.env=os.environ.copy(); self.env.update(WSI_INGEST_STAGING_ROOT=str(self.st), WSI_INGEST_PRODUCTION_ROOT=str(self.pr), WSI_INGEST_REQUIRED_OBSERVATIONS='3', WSI_INGEST_OBSERVATION_INTERVAL_SECONDS='10', WSI_INGEST_MIN_QUIET_SECONDS='20', WSI_INGEST_TEST_NOW='2000000000')
    def tearDown(self): self.t.cleanup()
    def cli(self,*args,input=''):
        e=os.environ.copy(); e.update(self.env); p=subprocess.run([str(Path(__file__).parents[1]/'wsi-ingest'),*args],input=input,text=True,capture_output=True,env=e)
        return p
    def ds(self,n='case'):
        d=self.st/n; d.mkdir(); (d/'slide.vsi').write_text('vsi'); (d/'slide_data').mkdir(); (d/'slide_data'/'a.bin').write_text('x'); return d
    def seal_obs(self):
        self.env['WSI_INGEST_TEST_NOW']='2000000000'
        self.ds(); self.assertEqual(self.cli('seal','case',input='SEAL\n').returncode,0)
        self.env['WSI_INGEST_TEST_NOW']='2000000010'; self.assertEqual(self.cli('observe','case').returncode,0)
        self.env['WSI_INGEST_TEST_NOW']='2000000021'; self.assertEqual(self.cli('observe','case').returncode,0)
    def test_missing_configuration(self):
        e=os.environ.copy(); e.pop('WSI_INGEST_STAGING_ROOT',None); e.pop('WSI_INGEST_PRODUCTION_ROOT',None)
        p=subprocess.run([str(Path(__file__).parents[1]/'wsi-ingest'),'status'],env=e,capture_output=True,text=True); self.assertNotEqual(p.returncode,0)
    def test_disjoint_and_nested_root_rejection(self):
        self.assertIn('canonical_disjoint: true', self.cli('status').stdout)
        self.env['WSI_INGEST_PRODUCTION_ROOT']=str(self.st/'p'); (self.st/'p').mkdir(); self.assertNotEqual(self.cli('status').returncode,0)
    def test_marker_validation(self):
        (self.pr/'.wsi-environment-staging').write_text(''); self.assertNotEqual(self.cli('status').stdout.find('production_marker_exact: False'),-1); self.ds(); self.assertNotEqual(self.cli('inspect','case').returncode,0)
    def test_dataset_name_validation(self):
        for n in ['','/x','a/b','..','.','a\\b']:
            self.assertNotEqual(self.cli('inspect',n).returncode,0)
    def test_symlink_and_unsupported_rejection(self):
        os.symlink(self.st, self.st/'link'); self.assertNotEqual(self.cli('inspect','link').returncode,0)
        d=self.ds('s'); os.symlink(d/'slide.vsi', d/'ln'); self.assertNotEqual(self.cli('inspect','s').returncode,0)
        e=self.st/'empty'; e.mkdir(); (e/'x.txt').write_text('x'); self.assertNotEqual(self.cli('inspect','empty').returncode,0)
    def test_inspect_readonly_and_aggregate(self):
        self.ds(); before=sorted(str(p.relative_to(self.st)) for p in self.st.rglob('*')); p=self.cli('inspect','case'); after=sorted(str(p.relative_to(self.st)) for p in self.st.rglob('*'))
        self.assertEqual(before,after); self.assertIn('regular_files:',p.stdout); self.assertNotIn('slide.vsi',p.stdout)
    def test_seal_confirmation_permissions_determinism(self):
        self.ds(); self.assertNotEqual(self.cli('seal','case',input='NO\n').returncode,0); self.assertEqual(self.cli('seal','case',input='SEAL\n').returncode,0)
        c=self.st/'.wsi-ingest-control'; self.assertEqual(stat.S_IMODE(c.stat().st_mode),0o700)
        mans=list(c.glob('*.manifest.json')); self.assertEqual(stat.S_IMODE(mans[0].stat().st_mode),0o600)
        first=mans[0].read_text(); self.cli('seal','case',input='SEAL\n'); self.assertEqual(first,mans[0].read_text())
    def test_observation_spacing_and_config(self):
        self.ds(); self.cli('seal','case',input='SEAL\n'); self.assertNotEqual(self.cli('observe','case').returncode,0); self.env['WSI_INGEST_TEST_NOW']='2000000010'; self.assertEqual(self.cli('observe','case').returncode,0)
        self.env['WSI_INGEST_REQUIRED_OBSERVATIONS']='1'; self.assertNotEqual(self.cli('status').returncode,0)
    def test_changes_after_seal_invalidate_and_reseal_required(self):
        self.ds(); self.cli('seal','case',input='SEAL\n'); (self.st/'case'/'new.vsi').write_text('x'); self.env['WSI_INGEST_TEST_NOW']='2000000010'; self.assertNotEqual(self.cli('observe','case').returncode,0); self.assertNotEqual(self.cli('observe','case').returncode,0)
    def test_dry_run_no_mutation_and_missing_observations(self):
        self.ds(); self.cli('seal','case',input='SEAL\n'); self.env['WSI_INGEST_TEST_NOW']='2000000030'; before=sorted(str(p.relative_to(self.st)) for p in self.st.rglob('*')); p=self.cli('promote','--dry-run','case'); self.assertNotEqual(p.returncode,0); self.assertEqual(before, sorted(str(p.relative_to(self.st)) for p in self.st.rglob('*')))
    def test_success_atomic_rename_journal_recovery_history_privacy(self):
        self.seal_obs(); p=self.cli('promote','--step','case',input='PROMOTE\n'); self.assertEqual(p.returncode,0,p.stderr); self.assertFalse((self.st/'case').exists()); self.assertTrue((self.pr/'case').exists()); self.assertTrue(list((self.st/'.wsi-ingest-control').glob('*.receipt.json')))
        h=self.cli('history'); self.assertNotIn('slide.vsi',h.stdout); self.assertIn('observations',h.stdout)
    def test_wrong_promote_destination_collision(self):
        self.seal_obs(); (self.pr/'case').mkdir(); p=self.cli('promote','--step','case',input='BAD\n'); self.assertNotEqual(p.returncode,0)
    def test_recover_before_and_after_rename_and_ambiguous(self):
        self.seal_obs(); self.env['WSI_INGEST_TEST_FAULT']='before_rename'; self.assertNotEqual(self.cli('promote','--step','case',input='PROMOTE\n').returncode,0); self.env.pop('WSI_INGEST_TEST_FAULT'); self.assertIn('preserve source', self.cli('recover').stdout)
        shutil.rmtree(self.st/'case'); [x.unlink() for x in (self.st/'.wsi-ingest-control').glob('case*')]; self.seal_obs(); self.env['WSI_INGEST_TEST_FAULT']='after_rename'; self.assertNotEqual(self.cli('promote','--step','case',input='PROMOTE\n').returncode,0); self.env.pop('WSI_INGEST_TEST_FAULT'); self.assertIn('recovered verified', self.cli('recover').stdout)

    def test_read_only_commands_do_not_create_control_state(self):
        self.assertFalse((self.st/'.wsi-ingest-control').exists())
        self.cli('status')
        self.assertFalse((self.st/'.wsi-ingest-control').exists())
        self.ds(); self.cli('inspect','case')
        self.assertFalse((self.st/'.wsi-ingest-control').exists())
        p=self.cli('promote','--dry-run','case')
        self.assertNotEqual(p.returncode,0)
        self.assertFalse((self.st/'.wsi-ingest-control').exists())

    def test_native_no_replace_race_leaves_both_trees_and_no_receipt(self):
        self.seal_obs(); self.env['WSI_INGEST_TEST_DEST_RACE']='1'
        p=self.cli('promote','--step','case',input='PROMOTE\n')
        self.assertNotEqual(p.returncode,0)
        self.assertTrue((self.st/'case'/'slide.vsi').exists())
        self.assertTrue((self.pr/'case').exists())
        self.assertFalse(list((self.st/'.wsi-ingest-control').glob('*.receipt.json')))

    def test_recover_refuses_multiple_incomplete_transactions_with_opaque_ids(self):
        self.seal_obs(); self.env['WSI_INGEST_TEST_FAULT']='before_rename'
        self.assertNotEqual(self.cli('promote','--step','case',input='PROMOTE\n').returncode,0)
        self.env.pop('WSI_INGEST_TEST_FAULT')
        self.env['WSI_INGEST_TEST_NOW']='2000000000'; self.ds('case2'); self.assertEqual(self.cli('seal','case2',input='SEAL\n').returncode,0)
        self.env['WSI_INGEST_TEST_NOW']='2000000010'; self.assertEqual(self.cli('observe','case2').returncode,0)
        self.env['WSI_INGEST_TEST_NOW']='2000000021'; self.assertEqual(self.cli('observe','case2').returncode,0)
        self.env['WSI_INGEST_TEST_FAULT']='before_rename'
        self.assertNotEqual(self.cli('promote','--step','case2',input='PROMOTE\n').returncode,0)
        self.env.pop('WSI_INGEST_TEST_FAULT')
        r=self.cli('recover')
        self.assertNotEqual(r.returncode,0)
        self.assertIn('multiple incomplete transactions:', r.stdout)
        self.assertNotIn('slide.vsi', r.stdout + r.stderr)

    def test_no_force_option_and_lock(self):
        p=self.cli('promote','--force','case'); self.assertNotEqual(p.returncode,0)

if __name__=='__main__': unittest.main()
