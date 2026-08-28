#!/usr/bin/env python3
"""Standalone, Windows-only smoke test for the unattended ingestion daemon.

This is NOT part of the automated cross-platform test suite (ops/tests/run.sh)
-- it deliberately refuses to run anywhere except Windows, because its entire
purpose is to exercise the two Windows-specific code paths in wsi_ingest.py
that cannot be exercised on the Mac/Linux machines this project is normally
developed on:

  - atomic_rename_noreplace()'s MoveFileExW branch (used by `promote`)
  - the msvcrt.locking()-based lock()/close_lock() branch (used by every
    mutating command)

Everything else it does was already proven to work identically on macOS
during development; this script exists purely to confirm those two Windows
branches behave the same way on a real Windows 11 host before anyone relies
on them there.

Usage (from an ordinary Command Prompt or PowerShell window, Python 3.9+):

    py windows_daemon_smoke_test.py

It creates its own throwaway staging/production folders under a temporary
directory -- it never touches any real staging or production path, and never
reads WSI_INGEST_* from your environment. It cleans up after itself on
success and prints the temp folder path (without deleting it) on failure, so
you can inspect exactly what happened.

Exit code 0 means both scenarios below passed. Any other exit code, or an
uncaught traceback, means something about the Windows-specific code paths
needs attention before this is trusted in production.
"""
import os, platform, shutil, sys, tempfile, time
from pathlib import Path

HERE = Path(__file__).resolve().parent


def fail(message):
    print(f"\nFAIL: {message}")
    sys.exit(1)


def main():
    if platform.system() != "Windows":
        fail("this script only runs on Windows -- see the module docstring for why")

    sys.path.insert(0, str(HERE))
    import wsi_ingest_daemon as daemon  # noqa: E402  (import after the platform guard, on purpose)

    root = Path(tempfile.mkdtemp(prefix="wsi-windows-smoke-"))
    staging = root / "staging"
    production = root / "production"
    staging.mkdir()
    production.mkdir()
    (production / ".wsi-environment-production").write_text("")

    os.environ.update({
        "WSI_INGEST_STAGING_ROOT": str(staging),
        "WSI_INGEST_PRODUCTION_ROOT": str(production),
        "WSI_INGEST_REQUIRED_OBSERVATIONS": "2",
        "WSI_INGEST_OBSERVATION_INTERVAL_SECONDS": "1",
        "WSI_INGEST_MIN_QUIET_SECONDS": "1",
        "WSI_INGEST_DAEMON_INTEGRITY_RETRY_LIMIT": "2",
    })

    ok = True
    print(f"Working in {root}\n")

    # --- Scenario 1: a good dataset should seal, observe, and be promoted -----
    print("Scenario 1: valid dataset should reach production via a real")
    print("            atomic MoveFileExW rename ...")
    good = staging / "GoodSlide"
    good.mkdir()
    (good / "slide.vsi").write_text("pretend slide bytes")

    daemon.main(["--once"])       # seals
    time.sleep(1.2)
    daemon.main(["--once"])       # 1st observation
    time.sleep(1.2)
    daemon.main(["--once"])       # 2nd observation -> promote

    if (production / "GoodSlide").is_dir() and not (staging / "GoodSlide").exists():
        print("  PASS: GoodSlide was atomically moved into production.\n")
    else:
        ok = False
        print("  FAIL: GoodSlide was not promoted -- see the log below.\n")

    # --- Scenario 2: a lock held during promotion must be respected -----------
    print("Scenario 2: a second, concurrent daemon invocation must not be able")
    print("            to acquire the ingestion lock while the first is using it")
    print("            (exercises msvcrt.locking) ...")
    from wsi_ingest_daemon import engine
    cfg = engine.cfg()
    held = engine.lock(cfg, create=True)
    try:
        try:
            engine.lock(cfg, create=False)
            ok = False
            print("  FAIL: a second lock acquisition succeeded while the first was held.\n")
        except engine.Fail as error:
            if error.cat == "lock":
                print("  PASS: second acquisition was correctly refused.\n")
            else:
                ok = False
                print(f"  FAIL: refused for the wrong reason ({error.cat}).\n")
    finally:
        engine.close_lock(held)

    print("--- daemon log ---")
    log_path = daemon.log_path(cfg)
    if log_path.exists():
        print(log_path.read_text())

    if ok:
        print("ALL SCENARIOS PASSED.")
        shutil.rmtree(root, ignore_errors=True)
        return 0
    else:
        print(f"One or more scenarios FAILED. Inspect {root} before deleting it.")
        return 1


if __name__ == "__main__":
    sys.exit(main())
