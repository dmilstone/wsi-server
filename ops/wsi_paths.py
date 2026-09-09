#!/usr/bin/env python3
"""Cross-platform WSI root resolution.

Root defaults are anchored at WSI_HOME:

  Windows:  %WSI_HOME%
  macOS:    $WSI_HOME

When WSI_HOME is unset, the fallback is <user home>/wsi using USERPROFILE
(Windows) or HOME (POSIX), never a hardcoded /Users/<name>/... path.
Join further segments with pathlib so separators follow the host OS.
"""
from __future__ import annotations

import os
from pathlib import Path


def wsi_home() -> Path:
    raw = os.environ.get("WSI_HOME") or os.environ.get("WSIHOME")
    if raw:
        return Path(os.path.expandvars(raw)).expanduser()
    home = os.environ.get("USERPROFILE") or os.environ.get("HOME")
    if home:
        return Path(home).expanduser() / "wsi"
    return Path.home() / "wsi"


def under_wsi_home(*parts: str) -> Path:
    return wsi_home().joinpath(*parts)


def default_production_image_root() -> Path:
    configured = os.environ.get("WSI_IMAGE_DIRECTORY")
    if configured:
        return Path(os.path.expandvars(configured)).expanduser()
    return under_wsi_home("wsi-slides")


def default_production_server_root() -> Path:
    configured = os.environ.get("WSI_PRODUCTION_ROOT")
    if configured:
        return Path(os.path.expandvars(configured)).expanduser()
    return under_wsi_home("wsi-server-production")


def browse_fallback_directories():
    """Starting points for a directory picker, in preference order."""
    candidates = [wsi_home(), Path.home()]
    if os.name == "nt":
        anchor = Path.home().anchor
        if anchor:
            candidates.append(Path(anchor))
    else:
        candidates.append(Path("/Volumes"))
        candidates.append(Path("/"))
    return candidates
