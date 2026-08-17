#!/usr/bin/env python3
import json
import tempfile
import unittest
from pathlib import Path
import sys
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import retro_build_metadata as rb


class RetroMetadataTests(unittest.TestCase):
    def test_normalizes_gap_variants(self):
        self.assertEqual(rb.extract_if_epitope("if IgG"), "if.IgG")
        self.assertEqual(rb.extract_if_epitope("if. IgA"), "if.IgA")
        self.assertEqual(rb.extract_if_epitope("prefix if.CD3 extra"), "if.CD3")
        self.assertEqual(rb.extract_if_epitope("if.Pending"), "")
        self.assertEqual(rb.extract_if_epitope(""), "")

    def test_image_id_matches_java_url_safe_base64(self):
        self.assertEqual(rb.image_id_for_relative("A.vsi"), "QS52c2k")
        self.assertEqual(rb.image_id_for_relative("case/BA26.vsi"), "Y2FzZS9CQTI2LnZzaQ")

    def test_keeps_existing_token_without_force(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            slide = root / "slide.vsi"
            slide.write_text("x")
            meta = root / "slide.metadata.json"
            meta.write_text(json.dumps({"clinicalMarker": "if.Albumin"}))
            args = rb.parse_args(["--slides-dir", str(root)])
            result = rb.update_slide(slide, root, args, ocr_enabled=False)
            self.assertEqual(result, "keep if.Albumin")
            self.assertEqual(json.loads(meta.read_text())["clinicalMarker"], "if.Albumin")

    def test_pending_placeholder_is_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            slide = root / "slide.vsi"
            slide.write_text("x")
            meta = root / "slide.metadata.json"
            meta.write_text(json.dumps({"clinicalMarker": "if.Pending"}))
            self.assertEqual(rb.read_existing_marker(meta), "")

    def test_space_separated_label_token(self):
        self.assertEqual(rb.extract_if_epitope("if Fibrin"), "if.Fibrin")

    def test_canonicalizes_panel_ocr_aliases(self):
        self.assertEqual(rb.extract_if_epitope("if.03"), "if.C3")
        self.assertEqual(rb.extract_if_epitope("if.196"), "if.IgG")
        self.assertEqual(rb.extract_if_epitope("if.Clq"), "if.C1q")
        self.assertEqual(rb.extract_if_epitope("if.|"), "")
        self.assertEqual(rb.extract_if_epitope("if.Ig"), "")

    def test_extracts_spring_csrf_input(self):
        html = '<form><input type="hidden" name="_csrf" value="token-1"/></form>'
        self.assertEqual(rb.extract_csrf_token(html), "token-1")

    def test_writes_token_over_pending(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            slide = root / "slide.vsi"
            slide.write_text("x")
            (root / "slide.label.png").write_bytes(b"png")
            meta = root / "slide.metadata.json"
            meta.write_text(json.dumps({"clinicalMarker": "if.Pending"}))
            args = rb.parse_args(["--slides-dir", str(root), "--server-url", ""])
            with mock.patch.object(rb, "ocr_label_file", return_value="if.IgG"):
                result = rb.update_slide(slide, root, args, ocr_enabled=True)
            self.assertIn("write if.IgG", result)
            self.assertEqual(json.loads(meta.read_text())["clinicalMarker"], "if.IgG")


if __name__ == "__main__":
    unittest.main()
