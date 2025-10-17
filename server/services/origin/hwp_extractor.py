#!/usr/bin/env python3
from __future__ import annotations

import io
import re
import sys
import unicodedata
import zipfile
from contextlib import closing
from typing import Optional, Tuple


def write_stdout(message: str) -> None:
  data = message.encode("utf-8")
  sys.stdout.buffer.write(data)
  sys.stdout.flush()


def write_stderr(message: str) -> None:
  data = message.encode("utf-8", errors="replace")
  sys.stderr.buffer.write(data)
  sys.stderr.flush()

try:
  from hwp5.hwp5txt import TextTransform
  from hwp5.hwp5html import HTMLTransform
  from hwp5.xmlmodel import Hwp5File
  from hwp5.dataio import ParseError
  from hwp5.errors import InvalidHwp5FileError
  from lxml import html as lxml_html

  HAS_PYHWP = True
  PYHWP_IMPORT_ERROR: Exception | None = None
except ImportError as import_error:
  HAS_PYHWP = False
  PYHWP_IMPORT_ERROR = import_error

try:
  from hwp_extract import (
    HWPExtractor,
    HWPExtractorError,
    HWPExtractorNoPasswordError,
  )
except ImportError as err:
  write_stderr(
    "hwp_extract module is not installed or failed to load. "
    "Please run 'pip install hwp-extract'.\n"
  )
  write_stderr(f"ImportError details: {err}\n")
  sys.exit(1)


def _printable_ratio(candidate: str) -> float:
  if not candidate:
    return 0.0
  printable = sum(1 for ch in candidate if ch.isprintable() or ch in "\n\t")
  return printable / max(1, len(candidate))


def _hangul_ratio(candidate: str) -> float:
  if not candidate:
    return 0.0
  hangul = sum(1 for ch in candidate if "\uAC00" <= ch <= "\uD7A3")
  letters = sum(1 for ch in candidate if ch.isalpha())
  return hangul / max(1, letters)


def smart_decode(raw: bytes) -> str:
  sample = raw[:4096]
  looks_utf16 = sample.count(b"\x00") > len(sample) * 0.2

  def score_text(txt: str) -> float:
    return _printable_ratio(txt) + 0.4 * _hangul_ratio(txt)

  candidates: list[tuple[str | None, dict[str, str]]] = []
  if looks_utf16:
    candidates += [
      ("utf-16-le", {}),
      ("utf-16-be", {}),
      ("utf-16", {"errors": "replace"}),
    ]

  candidates += [
    ("cp949", {"errors": "replace"}),
    ("euc-kr", {"errors": "replace"}),
    ("utf-8", {"errors": "replace"}),
  ]

  best_txt = ""
  best_score = -1.0

  for enc, kw in candidates:
    try:
      txt = raw.decode(enc, **kw)
    except Exception:
      continue
    sc = score_text(txt)
    if sc > best_score:
      best_txt, best_score = txt, sc
    if sc > 1.2:
      return txt

  if looks_utf16 and best_score < 0.9 and len(raw) >= 4:
    narrowed = raw[::2]
    for enc in ("cp949", "euc-kr", "utf-8"):
      try:
        txt = narrowed.decode(enc, errors="replace")
      except Exception:
        continue
      sc = score_text(txt)
      if sc > best_score:
        best_txt, best_score = txt, sc
      if sc > 1.2:
        return txt

  return best_txt


def normalize_text(raw: str) -> str:
  cleaned = raw.replace("\r\n", "\n").replace("\r", "\n")
  cleaned = cleaned.replace("\u0000", "")
  cleaned = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", cleaned)
  cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)

  punctuation = set(".,!?;:'\"()[]{}<>-–—…%&/+•|#")

  def is_allowed_char(ch: str) -> bool:
    if ch.isspace():
      return True
    code = ord(ch)
    if ch in punctuation:
      return True
    if 0x30 <= code <= 0x39:
      return True
    if 0x41 <= code <= 0x5A or 0x61 <= code <= 0x7A:
      return True
    if 0xAC00 <= code <= 0xD7A3:
      return True
    if 0x1100 <= code <= 0x11FF or 0x3130 <= code <= 0x318F:
      return True
    if 0x4E00 <= code <= 0x9FFF or 0x3400 <= code <= 0x4DBF:
      return True
    if 0x3000 <= code <= 0x303F:
      return True
    if 0x2010 <= code <= 0x205E:
      return True
    category = unicodedata.category(ch)
    return category.startswith(("L", "N"))

  sanitized_lines: list[str] = []

  for raw_line in cleaned.split("\n"):
    filtered_chars = [ch for ch in raw_line if is_allowed_char(ch)]
    filtered_line = "".join(filtered_chars)
    filtered_line = re.sub(r"\s+", " ", filtered_line).strip()
    if not filtered_line:
      continue

    candidate_spans = re.findall(r"[가-힣A-Za-z0-9][가-힣A-Za-z0-9\s.,!?…()\-]*", filtered_line)
    if not candidate_spans:
      continue

    best_span = max(candidate_spans, key=len).strip()
    if not best_span:
      continue

    hangul_chars = sum(1 for ch in best_span if "\uAC00" <= ch <= "\uD7A3")
    alnum_chars = sum(1 for ch in best_span if ch.isalnum())
    if alnum_chars == 0:
      continue
    if hangul_chars / alnum_chars < 0.2 and not re.search(r"[A-Za-z]", best_span):
      continue

    sanitized_lines.append(best_span)

  return "\n".join(sanitized_lines)


def try_hwpx(path: str) -> Optional[str]:
  try:
    with open(path, "rb") as handle:
      signature = handle.read(4)
    if signature != b"PK\x03\x04":
      return None

    with zipfile.ZipFile(path) as archive:
      section_entries = [
        name
        for name in archive.namelist()
        if name.lower().startswith("contents/section") and name.lower().endswith(".xml")
      ]
      if not section_entries:
        return None

      texts: list[str] = []
      for name in sorted(section_entries):
        with archive.open(name) as fh:
          xml_bytes = fh.read()
        try:
          xml_text = xml_bytes.decode("utf-8")
        except UnicodeDecodeError:
          xml_text = xml_bytes.decode("utf-8", errors="replace")
        stripped = re.sub(r"<[^>]+>", " ", xml_text)
        texts.append(stripped)

    return normalize_text("\n".join(texts))
  except Exception:
    return None


def extract_with_pyhwp(path: str) -> Tuple[Optional[str], Optional[Exception]]:
  if not HAS_PYHWP:
    return None, PYHWP_IMPORT_ERROR

  def run_transform(transform) -> bytes:
    with closing(Hwp5File(path)) as hwp5file:
      buffer = io.BytesIO()
      transform(hwp5file, buffer)
      return buffer.getvalue()

  try:
    raw = run_transform(TextTransform().transform_hwp5_to_text)
    if not raw.strip():
      raw = run_transform(HTMLTransform().transform_hwp5_to_html)
      if not raw.strip():
        return None, ValueError("pyhwp produced no output")
      html_text = raw.decode("utf-8", errors="replace")
      document = lxml_html.fromstring(html_text)
      text = document.text_content()
    else:
      text = raw.decode("utf-8", errors="replace")

    normalized = normalize_text(text)
    if normalized:
      return normalized, None
    return None, ValueError("pyhwp output was empty after normalization")
  except (ParseError, InvalidHwp5FileError) as err:
    return None, err
  except Exception as err:  # pragma: no cover
    return None, err


def extract_with_hwp_extract(path: str) -> str:
  with open(path, "rb") as handle:
    data = handle.read()

  extractor = HWPExtractor(data=data, raise_pw_error=False)
  text_fragments: list[str] = []

  for stream in extractor.extract_files():
    name = stream.name.lower()
    if not (name.startswith("bodytext/") or name.startswith("viewtext/")):
      continue

    decoded = smart_decode(stream.data).strip()
    if not decoded:
      continue
    normalized = normalize_text(decoded)
    if normalized:
      text_fragments.append(normalized)

  if not text_fragments:
    raise RuntimeError("No textual content found in HWP file.")

  return "\n\n".join(text_fragments)


def extract_text(path: str) -> Tuple[str, str]:
  hwpx_text = try_hwpx(path)
  if hwpx_text:
    return hwpx_text, "hwpx"

  pyhwp_text: Optional[str] = None
  pyhwp_error: Optional[Exception] = None

  if HAS_PYHWP:
    pyhwp_text, pyhwp_error = extract_with_pyhwp(path)
    if pyhwp_text:
      return pyhwp_text, "pyhwp"

  try:
    fallback_text = extract_with_hwp_extract(path)
    label = "smart_decode"
    if not HAS_PYHWP and PYHWP_IMPORT_ERROR is not None:
      label += " (pyhwp missing)"
    return fallback_text, label
  except Exception as err:
    suffix = ""
    if pyhwp_error is not None:
      suffix = f" (pyhwp failed: {pyhwp_error})"
    raise RuntimeError(f"{err}{suffix}") from err


def main(argv: Optional[list[str]] = None) -> None:
  args = argv if argv is not None else sys.argv[1:]
  if not args:
    write_stderr("Usage: hwp_extractor.py <path-to-hwp>\n")
    sys.exit(1)

  path = args[0]

  try:
    text, source = extract_text(path)
    write_stderr(f"Decoded using {source} path.\n")
    write_stdout(text)
  except HWPExtractorNoPasswordError as err:
    write_stderr(f"{err}\n")
    sys.exit(1)
  except HWPExtractorError as err:
    write_stderr(f"{err}\n")
    sys.exit(1)
  except Exception as err:
    write_stderr(f"{err}\n")
    sys.exit(1)


if __name__ == "__main__":
  main()
