#!/usr/bin/env python3
"""Focused, isolated preflight for the release cheat-sheet renderer."""

import importlib.util
import re
import subprocess
import sys
import tempfile
from pathlib import Path

OPS = Path(__file__).resolve().parents[1]
RENDERER = OPS / "render_cheatsheet.py"
CHECKED_IN = OPS / "WSI-Release-Cheat-Sheet.pdf"
MARKDOWN = OPS / "RELEASE-CHEATSHEET.md"
HTML = OPS / "RELEASE-CHEATSHEET.html"


def run(*arguments):
    return subprocess.run(
        [sys.executable, str(RENDERER), *map(str, arguments)],
        capture_output=True,
        text=True,
        check=False,
    )


def main():
    if importlib.util.find_spec("reportlab") is None:
        print("renderer preflight requires the documented ReportLab package", file=sys.stderr)
        return 77
    original = CHECKED_IN.read_bytes()
    source = RENDERER.read_text(encoding="utf-8")
    assert "/usr/share/fonts" not in source
    assert 'registerFontFamily(' in source

    with tempfile.TemporaryDirectory(prefix="wsi-renderer-test.") as directory:
        root = Path(directory)
        missing = root / "missing.ttf"
        rejected = run(
            "--output", root / "must-not-exist.pdf",
            "--font-regular", missing,
            "--font-bold", missing,
            "--font-mono", missing,
        )
        assert rejected.returncode != 0
        assert "font file does not exist" in rejected.stderr
        assert not (root / "must-not-exist.pdf").exists()

        output = root / "rendered.pdf"
        rendered = run("--output", output)
        assert rendered.returncode == 0, rendered.stderr
        assert output.is_file() and output.stat().st_size > 0
        contents = output.read_bytes()
        assert contents.startswith(b"%PDF-")
        assert len(re.findall(rb"/Type\s*/Page\b", contents)) == 3

        # The full renderer includes both an explicitly bold H3 style and
        # inline <b> markup in a normal DVSans paragraph. Requiring both their
        # text and the family map guards the macOS failure where aliases were
        # registered but dvsans-bold could not be resolved as a family face.
        assert 'fontName="DVSans-Bold"' in source
        assert 'callout("<b>' in source
        assert 'normal="DVSans"' in source
        assert 'bold="DVSans-Bold"' in source
        assert 'normal="DVMono"' in source

    synchronized = (source, MARKDOWN.read_text(encoding="utf-8"),
                    HTML.read_text(encoding="utf-8"))
    for required in (
        "Manual WSI ingestion", "source ops/wsi-ingest.conf",
        "promote --dry-run DATASET", "sealed_pending_transactions: 0",
        "docs/WSI-INGESTION.md",
    ):
        assert all(required in document for document in synchronized)

    assert CHECKED_IN.read_bytes() == original
    print("renderer preflight passed: portable fonts, isolated nonempty three-page PDF")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
