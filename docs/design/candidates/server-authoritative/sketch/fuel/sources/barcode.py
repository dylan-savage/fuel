"""Barcode decoding on the mini with zxing-cpp, plus GTIN parsing.

The phone sends a downscaled JPEG from <input type="file" accept="image/*" capture="environment">;
the mini decodes it. No wasm, no getUserMedia permission, one camera path shared with AI photos.
zxing-cpp installed from a wheel on this Mac (Python 3.12) and decoded a rotated, blurred
synthetic EAN-13 on 2026-10-28. Real phone photos are untested.
"""

from __future__ import annotations

from fuel.model import Gtin


def decode(jpeg: bytes) -> Gtin | None:
    """First EAN-13, UPC-A or EAN-8 found in the image, parsed. None when no barcode is readable.

    Pillow opens the image (EXIF orientation applied); zxingcpp.read_barcodes restricted to
    those formats. Pure apart from CPU; safe to call outside any transaction.
    """
    raise NotImplementedError


def parse_gtin(digits: str) -> Gtin | None:
    """Typed or decoded digits to a Gtin: strip spaces, verify the check digit, pad UPC-A (12)
    to 13. EAN-8 stays 8. None for anything else. The only constructor of Gtin."""
    raise NotImplementedError
