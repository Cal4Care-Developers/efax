"""
PDF <-> TIFF conversion for fax transmission.

FreeSWITCH's fax apps (txfax/rxfax, via mod_spandsp) speak Group 3/4 TIFF,
not PDF, so conversion happens here in the Python layer before/after the
call.

Requires on PATH:
    - ghostscript (`gs`)      -> apt install ghostscript
    - libtiff-tools (`tiff2pdf`) -> apt install libtiff-tools
"""
import subprocess

from config import FAX_RESOLUTION


class ConversionError(RuntimeError):
    pass


def pdf_to_tiff(pdf_path: str, tiff_path: str) -> None:
    """Convert a PDF into a Group 4 TIFF suitable for txfax."""
    cmd = [
        "gs", "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER",
        "-sDEVICE=tiffg4",
        f"-r{FAX_RESOLUTION}",
        f"-sOutputFile={tiff_path}",
        pdf_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise ConversionError(f"pdf_to_tiff failed: {result.stderr.strip()}")


def tiff_to_pdf(tiff_path: str, pdf_path: str) -> None:
    """Convert a received fax TIFF into a PDF for the inbox."""
    cmd = ["tiff2pdf", "-o", pdf_path, tiff_path]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise ConversionError(f"tiff_to_pdf failed: {result.stderr.strip()}")
