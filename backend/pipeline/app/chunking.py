# app/chunking.py
import re
import bisect
import logging
from pathlib import Path
from typing import List, Optional, Dict, Any

from tree_sitter import Parser
from tree_sitter_languages import get_language

# map file extensions to Tree-sitter language names
EXT_TO_LANG = {
    ".py": "python",
    ".js": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".java": "java",
    ".cpp": "cpp",
    ".c": "c",
    ".cs": "c_sharp",
    ".go": "go",
    ".rs": "rust",
    ".rb": "ruby",
    ".php": "php",
    ".ex": "elixir",
    ".exs": "elixir",
    ".el": "elisp",
    ".ml": "ocaml",
    ".r": "r",
    ".elm": "elm",
    ".ql": "ql",
}

# cache one parser per language
_PARSERS: dict[str, Optional[Parser]] = {}

# -------- noise / quality gates --------
# line that is only whitespace + braces/punct/angle brackets etc.
_NOISE_LINE_RE = re.compile(r'^[\s{}\[\]\(\);,<>/\\:"\'\-]+$')
# require at least one identifier-like token
_WORD_RE = re.compile(r'[A-Za-z_][A-Za-z0-9_]{2,}')

def _is_noise_line(line: str) -> bool:
    return _NOISE_LINE_RE.match(line) is not None

def _trim_noise_edges_lines(lines: List[str], s_idx: int, e_idx: int) -> tuple[int, int]:
    """
    Trim leading/trailing noise-only lines on a half-open [s_idx, e_idx) range.
    """
    s, e = s_idx, e_idx
    while s < e and _is_noise_line(lines[s]):
        s += 1
    while e > s and _is_noise_line(lines[e - 1]):
        e -= 1
    return s, e

def _informative(text: str,
                 min_nonspace: int = 40,
                 min_alnum: int = 20,
                 min_alpha_frac: float = 0.2) -> bool:
    """
    Filter out empty/punctuation-heavy/tiny chunks.
    """
    s = (text or "").strip()
    if not s:
        return False
    nonspace = sum(1 for c in s if not c.isspace())
    if nonspace < min_nonspace:
        return False
    alnum = sum(1 for c in s if c.isalpha() or c.isdigit())
    if alnum < min_alnum:
        return False
    alpha = sum(1 for c in s if c.isalpha())
    if nonspace and (alpha / nonspace) < min_alpha_frac:
        return False
    if not _WORD_RE.search(s):
        return False
    return True

# -------- byte/line helpers --------
def _get_parser_for_path(path: str) -> Optional[Parser]:
    ext = Path(path).suffix.lower()
    lang_name = EXT_TO_LANG.get(ext)
    if not lang_name:
        return None
    if lang_name not in _PARSERS:
        try:
            lang = get_language(lang_name)
            parser = Parser()
            parser.set_language(lang)
            _PARSERS[lang_name] = parser
        except Exception as e:
            logging.warning(f"Failed to create parser for {lang_name}: {e}")
            _PARSERS[lang_name] = None
    return _PARSERS[lang_name]

def _line_starts(btext: bytes) -> List[int]:
    """Return byte offsets for the start of each line (1-based mapping later)."""
    starts = [0]
    for i, b in enumerate(btext):
        if b == 0x0A:  # '\n'
            starts.append(i + 1)
    return starts

def _byte_to_line(idx: int, starts: List[int]) -> int:
    """Map a byte index to 1-based line number using precomputed starts."""
    return bisect.bisect_right(starts, idx)

# -------- core chunker --------
def chunk_code(
    path: str,
    text: str,
    max_chars: int = 5000,
    overlap: int = 200
) -> List[Dict[str, Any]]:
    """
    Returns a list of dicts: {content, start_line, end_line}
    Strategy:
      1) Use Tree-sitter to collect top-level named nodes (line spans).
      2) Batch adjacent nodes until ~max_chars, trimming noise edges.
      3) If a single batch is too large, split by line windows with overlap.
      4) Fallback: line-based sliding window with trimming + filters.
    """
    # normalize newlines; keep a no-keepends list for cheaper joins
    # strip BOM if present
    if text.startswith("\ufeff"):
        text = text.lstrip("\ufeff")
    lines: List[str] = text.splitlines()
    n_lines = len(lines)
    # prefix sums of line lengths (approx chars incl "\n")
    line_sizes = [len(l) + 1 for l in lines]
    pref = [0]
    for sz in line_sizes:
        pref.append(pref[-1] + sz)

    def chars_between(a: int, b: int) -> int:
        # half-open [a,b)
        a = max(0, min(a, n_lines))
        b = max(a, min(b, n_lines))
        return pref[b] - pref[a]

    def make_line_chunk(s_idx: int, e_idx: int) -> Optional[Dict[str, Any]]:
        # trim noisy edges, then check informative
        s2, e2 = _trim_noise_edges_lines(lines, s_idx, e_idx)
        if s2 >= e2:
            return None
        content = "\n".join(lines[s2:e2]).strip()
        if not _informative(content):
            return None
        return {
            "content": content,
            "start_line": s2 + 1,   # 1-based inclusive
            "end_line": e2,         # inclusive
        }

    def split_windowed(s_idx: int, e_idx: int) -> List[Dict[str, Any]]:
        """Split [s_idx,e_idx) into <= max_chars windows with ~overlap chars."""
        out: List[Dict[str, Any]] = []
        i = s_idx
        while i < e_idx:
            # grow j while under budget
            j = i
            while j < e_idx and chars_between(i, j + 1) <= max_chars:
                j += 1
            if j == i:  # single overlong line; force progress
                j = i + 1
            ck = make_line_chunk(i, j)
            if ck:
                out.append(ck)
            # compute overlap in chars by backing off from j
            back = j
            to_cover = overlap
            while back > i and to_cover > 0:
                back -= 1
                to_cover -= line_sizes[back]
            i = max(back, j)  # ensure forward progress even if overlap==0
        return out

    btext = text.encode("utf-8", errors="ignore")
    starts = _line_starts(btext)
    parser = _get_parser_for_path(path)

    chunks: List[Dict[str, Any]] = []

    if parser and n_lines > 0:
        try:
            tree = parser.parse(btext)
            root = tree.root_node

            # collect top-level named node line ranges (half-open indices)
            ranges: List[tuple[int, int]] = []
            for n in root.named_children:
                s_line = _byte_to_line(n.start_byte, starts)          # 1-based
                e_line = _byte_to_line(max(0, n.end_byte - 1), starts) # 1-based inclusive
                s_idx = max(0, s_line - 1)
                e_idx = min(n_lines, e_line)  # half-open
                if s_idx < e_idx:
                    ranges.append((s_idx, e_idx))

            # batch adjacent nodes under size budget
            batched: List[tuple[int, int]] = []
            if ranges:
                cur_s, cur_e = ranges[0]
                for s, e in ranges[1:]:
                    # try merge current with next, measuring after trimming edges
                    ts, te = _trim_noise_edges_lines(lines, cur_s, e)
                    length = chars_between(ts, te)
                    if length <= max_chars:
                        cur_e = e
                    else:
                        batched.append((cur_s, cur_e))
                        cur_s, cur_e = s, e
                batched.append((cur_s, cur_e))

            # emit chunks (and split oversize batches)
            for s_idx, e_idx in batched:
                # If still too big (e.g., one huge top-level node), split
                ts, te = _trim_noise_edges_lines(lines, s_idx, e_idx)
                if ts >= te:
                    continue
                if chars_between(ts, te) <= max_chars:
                    ck = make_line_chunk(ts, te)
                    if ck:
                        chunks.append(ck)
                else:
                    chunks.extend(split_windowed(ts, te))

        except Exception as e:
            logging.warning(f"Tree-sitter parsing failed for {path}: {e}")
            chunks = []

    # fallback
    if not chunks:
        # slide a window over all lines
        chunks = split_windowed(0, n_lines)

    # final cleanup (defensive)
    return [c for c in chunks if c.get("content", "").strip()]