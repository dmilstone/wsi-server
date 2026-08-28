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

    def test_only_dir_restricts_scan_to_one_dataset(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            dataset_a = root / "dataset_a"
            dataset_b = root / "dataset_b"
            dataset_a.mkdir()
            dataset_b.mkdir()
            (dataset_a / "slide_a.vsi").write_text("x")
            (dataset_b / "slide_b.vsi").write_text("x")
            (dataset_b / "slide_b.label.png").write_bytes(b"png")
            with mock.patch.object(rb, "ocr_label_file", return_value="if.IgG"):
                rc = rb.main([
                    "--slides-dir", str(root),
                    "--only-dir", str(dataset_b),
                    "--server-url", "",
                ])
            self.assertEqual(rc, 0)
            # Only the directory actually scanned gets a sidecar written --
            # the sibling dataset outside --only-dir is left untouched.
            self.assertTrue((dataset_b / "slide_b.metadata.json").exists())
            self.assertFalse((dataset_a / "slide_a.metadata.json").exists())
            self.assertEqual(
                json.loads((dataset_b / "slide_b.metadata.json").read_text())["clinicalMarker"],
                "if.IgG",
            )

    def test_only_dir_accepts_path_relative_to_slides_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            dataset = root / "dataset_c"
            dataset.mkdir()
            (dataset / "slide_c.vsi").write_text("x")
            (dataset / "slide_c.label.png").write_bytes(b"png")
            with mock.patch.object(rb, "ocr_label_file", return_value="if.CD3"):
                rc = rb.main([
                    "--slides-dir", str(root),
                    "--only-dir", "dataset_c",
                    "--server-url", "",
                ])
            self.assertEqual(rc, 0)
            self.assertEqual(
                json.loads((dataset / "slide_c.metadata.json").read_text())["clinicalMarker"],
                "if.CD3",
            )

    def test_only_dir_missing_directory_fails_cleanly(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            rc = rb.main(["--slides-dir", str(root), "--only-dir", "does-not-exist", "--server-url", ""])
            self.assertEqual(rc, 1)


if __name__ == "__main__":
    unittest.main()
