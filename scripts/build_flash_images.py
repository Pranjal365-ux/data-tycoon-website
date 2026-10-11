"""Render the round flash PDFs into lightweight WebP page images.

The original PDFs are about 17 MB each, which made the flash slow to open on
event Wi-Fi. Players are served these page images through the authenticated
API instead (about 250 KB per page), so the PDFs never need to be public.

Usage (requires poppler-utils for `pdftoppm` and Pillow):
    python scripts/build_flash_images.py
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "content-src" / "flashes"
TARGET = ROOT / "api" / "_private" / "flashes"
DPI = 150
QUALITY = 80


def build(pdf: Path) -> None:
    out_dir = TARGET / pdf.stem
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["pdftoppm", "-r", str(DPI), "-png", str(pdf), str(Path(tmp) / "page")], check=True)
        pngs = sorted(Path(tmp).glob("page-*.png"), key=lambda p: int(p.stem.split("-")[-1]))
        for number, png in enumerate(pngs, start=1):
            Image.open(png).convert("RGB").save(out_dir / f"page-{number}.webp", "WEBP", quality=QUALITY, method=6)
    total = sum(f.stat().st_size for f in out_dir.iterdir())
    print(f"{pdf.name}: {len(pngs)} pages, {total / 1024:.0f} KB")


def main() -> int:
    pdfs = sorted(SOURCE.glob("flash-*.pdf"))
    if not pdfs:
        print(f"No flash PDFs found in {SOURCE}", file=sys.stderr)
        return 1
    for pdf in pdfs:
        build(pdf)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
