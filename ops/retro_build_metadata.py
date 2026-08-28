#!/usr/bin/env python3
"""Update <stem>.metadata.json with ingest-time if.epitope tokens.

Previous viewer versions painted sidecar clinicalMarker under each filename.
This script writes those tokens at (or after) ingestion:

  1. Keep an existing real if.<epitope> unless --force.
  2. OCR a sibling label image ({stem}.label.png, {stem}_label.png, …).
  3. OCR /api/images/{id}/label.png from a running viewer (form login).

Placeholders such as if.Pending are treated as empty, matching WsiCatalogScanner.
The browser Scan path stays only for rows that are still empty after this sweep.
"""
from __future__ import annotations

import argparse
import base64
import http.cookiejar
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import traceback
import urllib.parse
import urllib.request
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request

SLIDE_EXTS = (".vsi", ".svs", ".tiff", ".tif", ".ndpi", ".czi", ".lif", ".nd2")
IF_TOKEN = re.compile(r"(?i)if\.\S+")
PLACEHOLDER = re.compile(r"(?i)^if\.(pending|none|unknown|n/?a)\b")
PANEL_ALIASES = {
    "iga": "if.IgA",
    "19a": "if.IgA",
    "igg": "if.IgG",
    "196": "if.IgG",
    "igm": "if.IgM",
    "igh": "if.IgM",
    "c3": "if.C3",
    "03": "if.C3",
    "c1q": "if.C1q",
    "clq": "if.C1q",
    "clg": "if.C1q",
    "albumin": "if.Albumin",
    "albunin": "if.Albumin",
    "fibrin": "if.Fibrin",
    "kappa": "if.Kappa",
    "lambda": "if.Lambda",
    "protein": "if.Protein",
    "iggneph": "if.IgG/Nephr",
    "iggnephr": "if.IgG/Nephr",
}
DEFAULT_SERVER = "http://127.0.0.1:8080"


def normalize_if_epitope(text: str) -> str:
    return re.sub(r"(?i)if[\s.]+", "if.", str(text or ""), count=1)


def extract_if_epitope(text: str) -> str:
    source = str(text or "")
    greedy = re.search(r"(?i)if[\s.]+\S+", source)
    normalized = normalize_if_epitope(greedy.group(0) if greedy else source)
    match = IF_TOKEN.search(normalized)
    if not match:
        return ""
    token = match.group(0)
    if PLACEHOLDER.match(token):
        return ""
    body = token.split(".", 1)[-1]
    key = re.sub(r"[^a-z0-9]", "", body.lower())
    if key in PANEL_ALIASES:
        return PANEL_ALIASES[key]
    if re.fullmatch(r"[A-Za-z]{3,}(?:/[A-Za-z]+)?", body) or re.fullmatch(r"[A-Za-z]{2,}\d+", body):
        return token
    return ""


def extract_csrf_token(html: str) -> str:
    source = str(html or "")
    for tag in re.finditer(r"<input[^>]*>", source, re.I):
        chunk = tag.group(0)
        if re.search(r'name=["\']_csrf["\']', chunk, re.I):
            value = re.search(r'value=["\']([^"\']+)["\']', chunk, re.I)
            if value:
                return value.group(1)
    meta = re.search(
        r'<meta[^>]*name=["\']_csrf["\'][^>]*content=["\']([^"\']+)["\']',
        source,
        re.I,
    )
    return meta.group(1) if meta else ""


def cookie_value(jar: http.cookiejar.CookieJar, name: str) -> str:
    for cookie in jar:
        if cookie.name == name:
            return cookie.value or ""
    return ""


def metadata_path_for_slide(slide_path: Path) -> Path:
    return slide_path.with_name(f"{slide_path.stem}.metadata.json")


def sibling_label_paths(slide_path: Path) -> list[Path]:
    stem = slide_path.stem
    parent = slide_path.parent
    names = (
        f"{stem}.label.png",
        f"{stem}_label.png",
        f"{stem}-label.png",
        "label.png",
    )
    return [parent / name for name in names if (parent / name).is_file()]


def read_existing_marker(meta_path: Path) -> str:
    if not meta_path.is_file():
        return ""
    try:
        payload = json.loads(meta_path.read_text())
    except (OSError, json.JSONDecodeError):
        return ""
    if not isinstance(payload, dict):
        return ""
    for key in ("clinicalMarker", "clinical_marker", "epitope", "if_epitope", "ifEpitope", "stain"):
        token = extract_if_epitope(str(payload.get(key) or ""))
        if token:
            return token
    ocr = payload.get("ocr")
    if isinstance(ocr, dict):
        return extract_if_epitope(str(ocr.get("clinicalMarker") or ocr.get("text") or ""))
    return ""


def read_raw_clinical_marker(meta_path: Path) -> str:
    if not meta_path.is_file():
        return ""
    try:
        payload = json.loads(meta_path.read_text())
    except (OSError, json.JSONDecodeError):
        return ""
    if not isinstance(payload, dict):
        return ""
    return str(payload.get("clinicalMarker") or "")


def write_sidecar(meta_path: Path, marker: str, extra: dict | None = None) -> None:
    payload = {}
    if meta_path.is_file():
        try:
            existing = json.loads(meta_path.read_text())
            if isinstance(existing, dict):
                payload.update(existing)
        except (OSError, json.JSONDecodeError):
            payload = {}
    payload["clinicalMarker"] = marker
    payload["status"] = "updated_via_epitope_ocr" if marker else "pending_epitope"
    if extra:
        payload.update(extra)
    tmp = meta_path.with_suffix(meta_path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n")
    tmp.replace(meta_path)


def image_id_for_relative(relative_path: str) -> str:
    return base64.urlsafe_b64encode(relative_path.encode("utf-8")).decode("ascii").rstrip("=")


class ViewerSession:
    """Form-login session for /api/images/{id}/label.png (not HTTP Basic)."""

    def __init__(self, base_url: str, user: str, password: str):
        self.base = str(base_url or "").rstrip("/")
        self.user = user
        self.password = password
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def login(self) -> None:
        if not self.base:
            raise RuntimeError("server URL is empty")
        login_url = f"{self.base}/login"
        with self.opener.open(login_url, timeout=30) as response:
            html = response.read().decode("utf-8", "replace")
        csrf = extract_csrf_token(html) or cookie_value(self.jar, "XSRF-TOKEN")
        if not csrf:
            raise RuntimeError("login CSRF token missing")
        body = urllib.parse.urlencode({
            "username": self.user,
            "password": self.password,
            "_csrf": csrf,
        }).encode("utf-8")
        request = Request(login_url, data=body, method="POST")
        request.add_header("Content-Type", "application/x-www-form-urlencoded")
        # csrf.spa() XOR-masks the form field; do not copy it to X-XSRF-TOKEN.
        with self.opener.open(request, timeout=30) as response:
            path = urllib.parse.urlparse(response.geturl()).path.rstrip("/")
            has_session = bool(cookie_value(self.jar, "JSESSIONID"))
            if path.endswith("login") or not has_session:
                raise RuntimeError("login rejected")

    def fetch_label_png(self, image_id: str) -> bytes | None:
        if not self.base or not image_id:
            return None
        url = f"{self.base}/api/images/{urllib.parse.quote(image_id, safe='-_=')}/label.png?max=0"
        try:
            with self.opener.open(url, timeout=60) as response:
                data = response.read()
                return data or None
        except HTTPError:
            return None
        except (URLError, TimeoutError, OSError):
            return None


def fetch_label_png(server_url: str, image_id: str, user: str, password: str, session=None) -> bytes | None:
    client = session
    if client is None:
        client = ViewerSession(server_url, user, password)
        try:
            client.login()
        except (HTTPError, URLError, TimeoutError, OSError, RuntimeError):
            return None
    return client.fetch_label_png(image_id)


def ocr_backend_available() -> str:
    try:
        import cv2  # noqa: F401
        import pytesseract  # noqa: F401
        return "cv2"
    except ImportError:
        pass
    if shutil.which("tesseract"):
        return "tesseract-cli"
    return ""


def rotate_png_file(src: Path, dest: Path, angle: int) -> bool:
    turn = int(angle) % 360
    if turn == 0:
        if src.resolve() != dest.resolve():
            shutil.copyfile(src, dest)
        return dest.is_file()
    sips = shutil.which("sips")
    if not sips:
        return False
    completed = subprocess.run(
        [sips, "-r", str(turn), str(src), "--out", str(dest)],
        capture_output=True,
        check=False,
    )
    return completed.returncode == 0 and dest.is_file() and dest.stat().st_size > 0


def tesseract_stdout(image_path: Path) -> str:
    exe = shutil.which("tesseract")
    if not exe or not image_path.is_file():
        return ""
    completed = subprocess.run(
        [exe, image_path.name, "stdout", "--psm", "11"],
        cwd=str(image_path.parent),
        capture_output=True,
        check=False,
    )
    return (completed.stdout or b"").decode("utf-8", "replace")


def ocr_with_tesseract_cli(data: bytes, angles=(90, 0, 180, 270)) -> str:
    if not data or not shutil.which("tesseract"):
        return ""
    with tempfile.TemporaryDirectory(prefix="wsi-epitope-ocr-") as tmp:
        tmp_path = Path(tmp)
        source = tmp_path / "label.png"
        source.write_bytes(data)
        for angle in angles:
            rotated = tmp_path / f"label-{int(angle)}.png"
            if not rotate_png_file(source, rotated, int(angle)):
                continue
            token = extract_if_epitope(tesseract_stdout(rotated))
            if token:
                return token
    return ""


def _ocr_image_bytes_cv2(data: bytes, angles=(90, 0, 180, 270)) -> str:
    import cv2
    import numpy as np
    import pytesseract

    array = np.frombuffer(data, dtype=np.uint8)
    image = cv2.imdecode(array, cv2.IMREAD_COLOR)
    if image is None:
        return ""
    config = "--psm 11 -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789./- "
    for angle in angles:
        rotated = image
        if angle == 90:
            rotated = cv2.rotate(image, cv2.ROTATE_90_CLOCKWISE)
        elif angle == 180:
            rotated = cv2.rotate(image, cv2.ROTATE_180)
        elif angle == 270:
            rotated = cv2.rotate(image, cv2.ROTATE_90_COUNTERCLOCKWISE)
        text = pytesseract.image_to_string(rotated, config=config)
        token = extract_if_epitope(text)
        if token:
            return token
    return ""


def ocr_image_bytes(data: bytes, angles=(90, 0, 180, 270)) -> str:
    if not data:
        return ""
    try:
        token = _ocr_image_bytes_cv2(data, angles)
        if token:
            return token
    except ImportError:
        pass
    except Exception:
        pass
    return ocr_with_tesseract_cli(data, angles)


def ocr_label_file(path: Path) -> str:
    try:
        return ocr_image_bytes(path.read_bytes())
    except OSError:
        return ""


def iter_slides(root: Path) -> list[Path]:
    slides = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [name for name in dirnames if not name.startswith(".wsi-environment-")]
        for name in filenames:
            lower = name.lower()
            if any(lower.endswith(ext) for ext in SLIDE_EXTS):
                slides.append(Path(dirpath) / name)
    slides.sort()
    return slides


def update_slide(slide_path: Path, root: Path, args, ocr_enabled: bool = True, session=None) -> str:
    meta_path = metadata_path_for_slide(slide_path)
    existing = read_existing_marker(meta_path)
    raw = read_raw_clinical_marker(meta_path)
    if existing and not args.force:
        if raw != existing:
            write_sidecar(meta_path, existing, {
                "ocrStatus": "normalized",
                "version": 1,
            })
        return f"keep {existing}"

    marker = ""
    source = ""
    png_bytes = 0
    fetch_ok = False
    client = session if session is not None else getattr(args, "session", None)
    if ocr_enabled:
        for label_path in sibling_label_paths(slide_path):
            marker = ocr_label_file(label_path)
            if marker:
                source = str(label_path.name)
                break
        if not marker and args.server_url:
            relative = slide_path.resolve().relative_to(root.resolve()).as_posix()
            image_id = image_id_for_relative(relative)
            png = fetch_label_png(args.server_url, image_id, args.user, args.password, session=client)
            png_bytes = len(png) if png else 0
            fetch_ok = bool(png)
            if png:
                marker = ocr_image_bytes(png)
                if marker:
                    source = "server-label"


    if not marker:
        if raw and not existing:
            write_sidecar(meta_path, "", {"ocrStatus": "empty", "version": 1})
            return "cleared"
        if not meta_path.exists():
            write_sidecar(meta_path, "", {"status": "synchronized_via_retro_sweep"})
            return "pending"
        if existing:
            return f"keep {existing}"
        return "missing"

    write_sidecar(meta_path, marker, {
        "ocrStatus": "ok",
        "ocrSource": source,
        "version": 1,
    })
    return f"write {marker} from {source}"


def resolve_password(explicit: str) -> str:
    return (
        str(explicit or "").strip()
        or os.environ.get("WSI_PASSWORD", "")
        or os.environ.get("WSI_ANNOTATOR_PASSWORD", "")
        or "Annotator"
    )


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Write ingest-time if.epitope sidecar tokens")
    parser.add_argument(
        "--slides-dir",
        default=os.environ.get("WSI_IMAGE_DIRECTORY", "/Users/dm026/wsi-slides"),
        help="Root directory of WSI containers",
    )
    parser.add_argument(
        "--only-dir",
        default="",
        help="Restrict the sweep to slide files under this one directory (absolute, "
             "or relative to --slides-dir), instead of walking the whole tree -- e.g. "
             "for an automated caller that just promoted a single dataset and wants "
             "its sidecar written without paying for a full retro-sweep. Image ids "
             "are still computed relative to the full --slides-dir root, so they stay "
             "identical to what a full sweep (or the running server) would produce.",
    )
    parser.add_argument("--force", action="store_true", help="Re-OCR slides that already have a token")
    parser.add_argument(
        "--server-url",
        default=os.environ.get("WSI_SERVER_URL", DEFAULT_SERVER),
        help="Running viewer for label.png, e.g. http://127.0.0.1:8080",
    )
    parser.add_argument("--user", default=os.environ.get("WSI_USER", "Annotator"))
    parser.add_argument(
        "--password",
        default="",
        help="Prefer WSI_PASSWORD in the environment; never log this value",
    )
    args = parser.parse_args(argv)
    args.password = resolve_password(args.password)
    args.session = None
    return args


def main(argv=None) -> int:
    args = parse_args(argv)
    root = Path(args.slides_dir).expanduser()
    if not root.is_dir():
        print(f"[ERROR] slides directory does not exist: {root}", file=sys.stderr)
        return 1

    scan_root = root
    if args.only_dir:
        scan_root = Path(args.only_dir).expanduser()
        if not scan_root.is_absolute():
            scan_root = root / scan_root
        if not scan_root.is_dir():
            print(f"[ERROR] --only-dir does not exist: {scan_root}", file=sys.stderr)
            return 1

    backend = ocr_backend_available()
    ocr_enabled = bool(backend)
    if not ocr_enabled:
        print("[WARN] tesseract CLI (or cv2/pytesseract) unavailable; will keep existing tokens only.")

    if args.server_url:
        session = ViewerSession(args.server_url, args.user, args.password)
        try:
            session.login()
        except Exception as error:
            print(f"[ERROR] viewer form login failed: {type(error).__name__}", file=sys.stderr)
            return 1
        args.session = session
        print(f"Logged in to {args.server_url} for label.png")

    # iter_slides walks only scan_root (cheap when --only-dir narrows it to one
    # freshly-promoted dataset), but update_slide() below always computes image
    # ids relative to the full root, so ids match the running server exactly.
    slides = iter_slides(scan_root)
    print(f"Updating if.epitope sidecars under {scan_root} ({len(slides)} slides, ocr={backend or 'off'})")
    counts = {"keep": 0, "write": 0, "pending": 0, "missing": 0}
    for slide in slides:
        try:
            result = update_slide(slide, root, args, ocr_enabled=ocr_enabled, session=args.session)
            print(f"-> {slide.name}: {result}")
            key = result.split(" ", 1)[0]
            counts[key] = counts.get(key, 0) + 1
        except Exception:
            print(f"[FAIL] {slide.name}")
            traceback.print_exc()
    print(
        f"\n[SUCCESS] keep={counts.get('keep', 0)} write={counts.get('write', 0)} "
        f"pending={counts.get('pending', 0)} missing={counts.get('missing', 0)}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
