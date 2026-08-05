#!/usr/bin/env python3
import argparse, ctypes, errno, fcntl, hashlib, json, os, platform, secrets, stat, sys, tempfile, time
from pathlib import Path

PROD_MARKER='.wsi-environment-production'; MARKER_PREFIX='.wsi-environment-'; CONTROL='.wsi-ingest-control'; VERSION=1
WSI_EXTS={'.vsi','.svs','.ndpi','.czi','.lif','.ome.tif','.ome.tiff','.tif','.tiff'}
class Fail(Exception):
    def __init__(self,cat,msg): self.cat=cat; super().__init__(msg)

def now(): return time.time()
def cfg():
    s=os.environ.get('WSI_INGEST_STAGING_ROOT'); p=os.environ.get('WSI_INGEST_PRODUCTION_ROOT')
    if not s or not p: raise Fail('configuration','missing WSI_INGEST_STAGING_ROOT or WSI_INGEST_PRODUCTION_ROOT')
    q=int(os.environ.get('WSI_INGEST_MIN_QUIET_SECONDS', os.environ.get('WSI_INGEST_QUIET_SECONDS','120')))
    obs=int(os.environ.get('WSI_INGEST_REQUIRED_OBSERVATIONS','3')); interval=int(os.environ.get('WSI_INGEST_OBSERVATION_INTERVAL_SECONDS','60'))
    if obs<2 or interval<=0 or q < (obs-1)*interval: raise Fail('configuration','invalid observation/quiet settings')
    sr=Path(s).expanduser().resolve(strict=False); pr=Path(p).expanduser().resolve(strict=False)
    if sr==pr or str(sr).startswith(str(pr)+os.sep) or str(pr).startswith(str(sr)+os.sep): raise Fail('configuration','roots must be canonical and disjoint')
    return {'staging':sr,'production':pr,'quiet':q,'obs':obs,'interval':interval}

def dataset_name(n):
    if not n or n in ('.','..') or os.path.isabs(n) or '/' in n or '\\' in n or Path(n).name!=n: raise Fail('dataset','dataset must be one normalized top-level name')
    return n

def ensure_control(c):
    d=c['staging']/CONTROL; d.mkdir(mode=0o700, exist_ok=True); os.chmod(d,0o700); return d

def fsync_path(p):
    fd=os.open(str(p), os.O_RDONLY); os.fsync(fd); os.close(fd)
def atomic_write(p,data):
    p.parent.mkdir(mode=0o700, exist_ok=True); fd,tmp=tempfile.mkstemp(prefix=p.name+'.', dir=str(p.parent));
    with os.fdopen(fd,'w') as f: f.write(data); f.flush(); os.fsync(f.fileno())
    os.chmod(tmp,0o600); os.replace(tmp,p); fsync_path(p.parent)

def same_dev(a,b): return os.stat(a).st_dev==os.stat(b).st_dev
def prod_marker_ok(p):
    ms=[x.name for x in p.iterdir() if x.name.startswith(MARKER_PREFIX)] if p.exists() else []
    return ms==[PROD_MARKER]
def roots_ok(c,exist=True):
    if exist and (not c['staging'].is_dir() or not c['production'].is_dir()): raise Fail('configuration','configured roots must exist')
    if c['staging']==c['production'] or str(c['staging']).startswith(str(c['production'])+os.sep) or str(c['production']).startswith(str(c['staging'])+os.sep): raise Fail('configuration','roots must be disjoint')
    if exist and not same_dev(c['staging'],c['production']): raise Fail('filesystem','staging and production must be on same filesystem')
    if exist and not prod_marker_ok(c['production']): raise Fail('environment','production marker must be exactly present')

def entry(path, base):
    st=os.lstat(path); rel=path.relative_to(base).as_posix()
    real=path.resolve(strict=False)
    if not (real==base.resolve() or str(real).startswith(str(base.resolve())+os.sep)): raise Fail('root_escape','entry escapes dataset root')
    if stat.S_ISLNK(st.st_mode): raise Fail('symlink','symlinks are rejected')
    typ='dir' if stat.S_ISDIR(st.st_mode) else 'file' if stat.S_ISREG(st.st_mode) else None
    if not typ: raise Fail('type','only files and directories are allowed')
    return {'path':rel,'type':typ,'size':st.st_size if typ=='file' else None,'mtime_ns':st.st_mtime_ns,'dev':st.st_dev,'ino':st.st_ino,'mode':stat.S_IMODE(st.st_mode)}

def manifest(ds):
    if os.path.islink(ds): raise Fail('symlink','dataset directory symlink rejected')
    if not ds.is_dir(): raise Fail('dataset','dataset must be a directory')
    out=[]; files=bytes_=0; newest=0; supported=False; markers=False
    for root,dirs,filesn in os.walk(ds, topdown=True, followlinks=False):
        rootp=Path(root); out.append(entry(rootp,ds))
        for n in sorted(dirs+filesn):
            p=rootp/n; e=entry(p,ds); out.append(e)
            if n.startswith(MARKER_PREFIX): markers=True
            low=n.lower(); supported = supported or any(low.endswith(x) for x in WSI_EXTS)
            if e['type']=='file': files+=1; bytes_+=e['size']; newest=max(newest,e['mtime_ns'])
    if markers: raise Fail('environment','environment markers are forbidden inside datasets')
    if not supported: raise Fail('unsupported','dataset contains no supported WSI container')
    out=sorted(out,key=lambda x:x['path']); digest=hashlib.sha256(json.dumps(out,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    return out,digest,{'files':files,'bytes':bytes_,'newest_age':max(0, now()-newest/1e9) if newest else 0}

def validate(c,name,base=None):
    roots_ok(c); ds=(base or c['staging'])/name; dest=c['production']/name
    if ds.parent.resolve(strict=False)!= (base or c['staging']).resolve(strict=False): raise Fail('dataset','dataset must be immediately beneath root')
    if dest.exists() and base is None: raise Fail('collision','destination already exists')
    m,d,a=manifest(ds); return ds,dest,m,d,a

def state_paths(c,name):
    cd=c['staging']/CONTROL
    return cd/(name+'.json'), cd/(name+'.manifest.json'), cd/(name+'.journal.json'), cd/(name+'.receipt.json'), cd/'ingest.lock'
def state_files(c,name):
    cd=ensure_control(c); lp=cd/'ingest.lock'
    if not lp.exists():
        fd=os.open(str(lp), os.O_CREAT|os.O_WRONLY, 0o600); os.close(fd)
    os.chmod(lp,0o600)
    return cd/(name+'.json'), cd/(name+'.manifest.json'), cd/(name+'.journal.json'), cd/(name+'.receipt.json'), lp
def load(c,name,create=True):
    s,m,j,r,l=state_files(c,name) if create else state_paths(c,name)
    if not s.exists() or not m.exists(): raise Fail('state','sealed state not found')
    return json.load(open(s)), json.load(open(m)), (json.load(open(j)) if j.exists() else None)
def lock(c,create=True):
    if create:
        *_,lp=state_files(c,'_'); f=open(lp,'a+')
    else:
        *_,lp=state_paths(c,'_'); f=open(lp,'a+') if lp.exists() else os.open(c['staging'], os.O_RDONLY)
    try: fcntl.flock(f, fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError: raise Fail('lock','another ingestion operation holds the lock')
    return f


def state_records(c):
    cd=c['staging']/CONTROL
    if not cd.exists(): return []
    records=[]
    for sf in sorted(cd.glob('*.json')):
        if sf.name.endswith(('.manifest.json','.journal.json','.receipt.json')): continue
        try:
            st=json.load(open(sf)); n=st.get('dataset')
            if n: records.append((n,st))
        except (OSError,json.JSONDecodeError):
            continue
    return records

def effective_phase(c,name,st):
    s,m,jf,rf,lf=state_paths(c,name)
    phase=st.get('phase','sealed')
    if jf.exists():
        try: phase=json.load(open(jf)).get('phase',phase)
        except (OSError,json.JSONDecodeError): pass
    if phase=='verified' and not rf.exists():
        return 'moved'
    if rf.exists():
        try:
            receipt_state=json.load(open(rf))
            if receipt_state.get('transaction_id')==st.get('transaction_id') and receipt_state.get('phase')=='verified' and phase=='verified':
                return 'verified'
        except (OSError,json.JSONDecodeError): pass
    return phase

def pending_transactions(c):
    return [(n,st) for n,st in state_records(c) if effective_phase(c,n,st)!='verified']

def cmd_status(a):
    c=cfg(); cd=c['staging']/CONTROL; pending=len(pending_transactions(c))
    print('roots_exist:', c['staging'].is_dir() and c['production'].is_dir()); print('canonical_disjoint: true')
    print('same_filesystem:', same_dev(c['staging'],c['production']) if c['staging'].exists() and c['production'].exists() else False)
    print('production_marker_exact:', prod_marker_ok(c['production']) if c['production'].exists() else False)
    held=False
    lp=cd/'ingest.lock'
    if lp.exists():
        f=open(lp,'a+')
        try: fcntl.flock(f, fcntl.LOCK_EX|fcntl.LOCK_NB); fcntl.flock(f, fcntl.LOCK_UN)
        except BlockingIOError: held=True
    print('lock_held:', held); print('sealed_pending_transactions:', pending)
def cmd_inspect(a):
    c=cfg(); n=dataset_name(a.dataset); ds,dest,m,d,ag=validate(c,n); print(f'transaction_dataset: {hashlib.sha256(n.encode()).hexdigest()[:16]}'); print('regular_files:',ag['files']); print('total_bytes:',ag['bytes']); print('latest_modification_age_seconds:',int(ag['newest_age'])); print('validation: ok')
def cmd_seal(a):
    if input('Type SEAL: ')!='SEAL': raise Fail('confirmation','wrong confirmation token')
    c=cfg(); n=dataset_name(a.dataset); ds,dest,m,d,ag=validate(c,n); tx=secrets.token_hex(16); st={'version':VERSION,'transaction_id':tx,'dataset':n,'seal_time':now(),'staging_root':str(c['staging']),'production_root':str(c['production']),'quiet_seconds':c['quiet'],'required_observations':c['obs'],'observation_interval_seconds':c['interval'],'manifest_digest':d,'phase':'sealed','observations':[{'time':now(),'digest':d}],'invalidated':False}
    sf,mf,*_=state_files(c,n); atomic_write(mf,json.dumps(m,sort_keys=True)); atomic_write(sf,json.dumps(st,sort_keys=True)); print('sealed transaction:',tx)
def recheck(c,n,readonly=True,base=None,create_state=True):
    st,m,j=load(c,n,create_state)
    if st.get('invalidated'): raise Fail('state','seal invalidated; inspect and seal again')
    ds,dest,cur,dig,ag=validate(c,n,base)
    if cur!=m or dig!=st['manifest_digest']:
        st['invalidated']=True
        if create_state:
            sf,*_=state_files(c,n); atomic_write(sf,json.dumps(st,sort_keys=True))
        raise Fail('manifest','dataset changed after seal; reseal required')
    return st,m,ds,dest,ag
def cmd_observe(a):
    c=cfg(); n=dataset_name(a.dataset); st,m,ds,dest,ag=recheck(c,n)
    last=st['observations'][-1]['time']
    if now()-last < c['interval']: raise Fail('stability','observation attempted too early')
    st['observations'].append({'time':now(),'digest':st['manifest_digest']}); sf,*_=state_files(c,n); atomic_write(sf,json.dumps(st,sort_keys=True)); print('observation_count:',len(st['observations']))
def readiness(c,st,ag):
    if len(st['observations'])<c['obs']: raise Fail('stability','missing qualifying observations')
    if now()-st['seal_time']<c['quiet'] or ag['newest_age']<c['quiet']: raise Fail('stability','quiet period not satisfied')
def journal(c,n,phase):
    sf,mf,jf,rf,lf=state_files(c,n); data={'dataset':n,'phase':phase,'time':now()}; atomic_write(jf,json.dumps(data,sort_keys=True))
def receipt(c,n,st):
    sf,mf,jf,rf,lf=state_files(c,n); atomic_write(rf,json.dumps({'dataset':n,'transaction_id':st['transaction_id'],'phase':'verified','time':now()},sort_keys=True)); os.chmod(rf,0o400)

def atomic_rename_noreplace(src,dst):
    system=platform.system()
    if system=='Linux':
        nr={'x86_64':316,'aarch64':276,'arm64':276}.get(platform.machine())
        if nr is None: raise Fail('platform','renameat2 RENAME_NOREPLACE unsupported on this architecture')
        libc=ctypes.CDLL(None, use_errno=True); AT_FDCWD=-100; RENAME_NOREPLACE=1
        rc=libc.syscall(ctypes.c_long(nr), ctypes.c_int(AT_FDCWD), ctypes.c_char_p(os.fsencode(src)), ctypes.c_int(AT_FDCWD), ctypes.c_char_p(os.fsencode(dst)), ctypes.c_uint(RENAME_NOREPLACE))
    elif system=='Darwin':
        libc=ctypes.CDLL('libc.dylib', use_errno=True); RENAME_EXCL=0x00000004
        rc=libc.renamex_np(ctypes.c_char_p(os.fsencode(src)), ctypes.c_char_p(os.fsencode(dst)), ctypes.c_uint(RENAME_EXCL))
    else:
        raise Fail('platform','atomic no-replace directory rename unavailable')
    if rc!=0:
        e=ctypes.get_errno()
        if e in (errno.EEXIST, errno.ENOTEMPTY): raise Fail('collision','destination already exists')
        raise Fail('filesystem',os.strerror(e))

def close_lock(lf):
    try:
        fcntl.flock(lf, fcntl.LOCK_UN)
    finally:
        if hasattr(lf,'close'): lf.close()
        else: os.close(lf)

def cmd_promote(a):
    c=cfg(); n=dataset_name(a.dataset); lf=lock(c,not a.dry_run)
    try:
        st,m,ds,dest,ag=recheck(c,n,create_state=not a.dry_run); readiness(c,st,ag)
        print('transaction:',st['transaction_id']); print('regular_files:',ag['files']); print('total_bytes:',ag['bytes'])
        if a.dry_run: print('dry_run: ok'); return
        if input('Type PROMOTE: ')!='PROMOTE': raise Fail('confirmation','wrong confirmation token')
        st,m,ds,dest,ag=recheck(c,n); readiness(c,st,ag); journal(c,n,'prepared')
        if dest.exists(): raise Fail('collision','destination already exists')
        atomic_rename_noreplace(ds,dest); fsync_path(c['staging']); fsync_path(c['production']); journal(c,n,'moved')
        cur,dig,ag2=manifest(dest)
        if cur!=m: raise Fail('manifest','destination differs after rename')
        journal(c,n,'verified'); receipt(c,n,st); print('promoted transaction:',st['transaction_id'])
    finally:
        close_lock(lf)
def cmd_recover(a):
    c=cfg(); lf=lock(c)
    try:
        cd=ensure_control(c); pending=[]
        for jf in cd.glob('*.journal.json'):
            j=json.load(open(jf)); n=j['dataset']; st,m,_=load(c,n)
            rf=state_paths(c,n)[3]
            if j.get('phase')!='verified' or not rf.exists(): pending.append((n,st['transaction_id']))
        if not pending:
            print('no pending journal'); return
        if len(pending)>1:
            print('multiple incomplete transactions:', ' '.join(tx for n,tx in pending)); raise Fail('manual_investigation','multiple incomplete transactions')
        n,tx=pending[0]; st,m,j=load(c,n); src=c['staging']/n; dst=c['production']/n
        if src.exists() and not dst.exists(): print('preserve source; promotion did not occur')
        elif (not src.exists()) and dst.exists():
            cur,dig,ag=manifest(dst)
            if cur!=m: raise Fail('manual_investigation','destination differs from manifest')
            journal(c,n,'verified'); receipt(c,n,st); print('recovered verified transaction:',tx)
        else: raise Fail('manual_investigation','ambiguous recovery state')
    finally:
        close_lock(lf)
def cmd_history(a):
    c=cfg()
    for n,st in state_records(c):
        print(st.get('transaction_id'), effective_phase(c,n,st), 'observations', len(st.get('observations',[])))

def main(argv=None):
    p=argparse.ArgumentParser(); sub=p.add_subparsers(dest='cmd',required=True)
    for x in ['status','history','recover']: sub.add_parser(x)
    for x in ['inspect','seal','observe']: sp=sub.add_parser(x); sp.add_argument('dataset')
    pr=sub.add_parser('promote'); g=pr.add_mutually_exclusive_group(required=True); g.add_argument('--dry-run',action='store_true'); g.add_argument('--step',action='store_true'); pr.add_argument('dataset')
    a=p.parse_args(argv); return globals()['cmd_'+a.cmd.replace('-','_')](a) or 0
if __name__=='__main__':
    try: sys.exit(main())
    except Fail as e: print('FAIL',e.cat+':',str(e),file=sys.stderr); sys.exit(1)
