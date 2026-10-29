"""Where the worker finds its data and KiCad. Reads no file at all: both locations come from the environment the plugin server was started with."""
from __future__ import annotations

import os
from pathlib import Path


def data_dir() -> Path:
    d = Path(os.environ["ZCODE_KICAD_DATA_DIR"]).resolve()
    d.mkdir(parents=True, exist_ok=True)
    return d


def kicad_app_dir() -> Path:
    configured = (os.environ.get("ZCODE_KICAD_APP") or "").strip()
    if configured:
        return Path(configured)
    # KenFutWork: Windows 的 KiCad 装在 C:\Program Files\KiCad\<版本>\（kicad-cli 在 bin\，
    # 官方库在 share\kicad\）。按版本号倒序取第一个存在的安装。
    if os.name == "nt":
        for base in (r"C:\Program Files\KiCad", r"C:\Program Files (x86)\KiCad"):
            root = Path(base)
            if not root.is_dir():
                continue
            versions = sorted((p for p in root.iterdir() if p.is_dir()), reverse=True)
            for version in versions:
                if (version / "bin").is_dir():
                    return version
    return Path("/Applications/KiCad/KiCad.app")
