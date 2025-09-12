import re
import bisect
import logging
from pathlib import Path
from typing import List, Optional, Dict, Any

from tree_sitter import Parser
from tree_sitter_languages import get_language

EXTENSION_TO_LANGUAGE = {
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

_PARSER_CACHE: dict[str, Optional[Parser]] = {}

_NOISE_ONLY_LINE_RE = re.compile(r'^[\s{}\[\]\(\);,<>/\\:"\'\-]+$')
_WORD_LIKE_RE = re.compile(r'[A-Za-z_][A-Za-z0-9_]{2,}')


def _is_noise_only_line(line: str) -> bool:
    """Return True if the entire line is punctuation/whitespace-like noise."""
    return _NOISE_ONLY_LINE_RE.match(line) is not None


def _trim_noise_line_edges(lines: List[str], start_idx: int, end_idx: int) -> tuple[int, int]:
    """
    Trim leading/trailing noise-only lines from a half-open [start_idx, end_idx) range.
    Returns the trimmed (start, end) indices.
    """
    s, e = start_idx, end_idx
    while s < e and _is_noise_only_line(lines[s]):
        s += 1
    while e > s and _is_noise_only_line(lines[e - 1]):
        e -= 1
    return s, e


def _is_informative_text(
    text: str,
    min_nonspace: int = 40,
    min_alnum: int = 20,
    min_alpha_fraction: float = 0.2,
) -> bool:
    """
    Heuristic filter for empty/tiny/punctuation-heavy chunks.

    Args:
        text: Candidate chunk text.
        min_nonspace: Minimum count of non-space characters.
        min_alnum: Minimum count of alphanumeric characters.
        min_alpha_fraction: Minimum fraction of alphabetic characters among non-space characters.

    Returns:
        bool: True if the text looks informative.
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
    if nonspace and (alpha / nonspace) < min_alpha_fraction:
        return False

    if not _WORD_LIKE_RE.search(s):
        return False

    return True


def _get_parser_for_file(path: str) -> Optional[Parser]:
    """
    Get or initialize a tree-sitter Parser for the file at 'path' based on its extension.
    """
    ext = Path(path).suffix.lower()
    language_name = EXTENSION_TO_LANGUAGE.get(ext)
    if not language_name:
        return None

    if language_name not in _PARSER_CACHE:
        try:
            language = get_language(language_name)
            parser = Parser()
            parser.set_language(language)
            _PARSER_CACHE[language_name] = parser
        except Exception as exc:
            logging.warning(f"Failed to create parser for {language_name}: {exc}")
            _PARSER_CACHE[language_name] = None

    return _PARSER_CACHE[language_name]


def _line_start_byte_offsets(raw_bytes: bytes) -> List[int]:
    """
    Return byte offsets for the start of each line (0-based). Each '\n' starts a new line.
    """
    starts = [0]
    for i, b in enumerate(raw_bytes):
        if b == 0x0A:  # '\n'
            starts.append(i + 1)
    return starts


def _byte_offset_to_line_number(byte_index: int, line_starts: List[int]) -> int:
    """
    Map a byte offset to a 1-based line number using precomputed line start offsets.
    """
    return bisect.bisect_right(line_starts, byte_index)


def chunk_source_code(
    path: str,
    text: str,
    max_chars: int = 10_000,
    overlap: int = 200,
) -> List[Dict[str, Any]]:
    """
    Chunk source code into semantically sensible pieces.

    Returns a list of dicts with:
        {
            "content": str,
            "start_line": int,  # 1-based inclusive
            "end_line": int,    # 1-based inclusive
        }

    Strategy:
      1) Use tree-sitter to collect top-level named nodes (as line ranges).
      2) Greedily merge adjacent node ranges until ~max_chars, trimming noise edges.
      3) If a merged range is still too large, split by line windows with overlap.
      4) Fallback: line-based sliding window with trimming + heuristic filters.
    """
    if text.startswith("\ufeff"):
        text = text.lstrip("\ufeff")

    lines: List[str] = text.splitlines()
    num_lines = len(lines)

    line_lengths = [len(l) + 1 for l in lines]
    cumulative = [0]
    for ln_len in line_lengths:
        cumulative.append(cumulative[-1] + ln_len)

    def char_count_between_lines(start_line_idx: int, end_line_idx: int) -> int:
        """
        Character count for a half-open line range [start_line_idx, end_line_idx).
        """
        a = max(0, min(start_line_idx, num_lines))
        b = max(a, min(end_line_idx, num_lines))
        return cumulative[b] - cumulative[a]

    def build_line_chunk(start_idx: int, end_idx: int) -> Optional[Dict[str, Any]]:
        """
        Build a chunk dict from a line range, trimming noise edges and applying filters.
        """
        trimmed_start, trimmed_end = _trim_noise_line_edges(lines, start_idx, end_idx)
        if trimmed_start >= trimmed_end:
            return None
        content = "\n".join(lines[trimmed_start:trimmed_end]).strip()
        if not _is_informative_text(content):
            return None
        return {
            "content": content,
            "start_line": trimmed_start + 1,
            "end_line": trimmed_end,
        }

    def split_by_window(start_idx: int, end_idx: int) -> List[Dict[str, Any]]:
        """
        Split a line range [start_idx, end_idx) into <= max_chars windows with ~overlap chars.
        """
        result: List[Dict[str, Any]] = []
        i = start_idx
        while i < end_idx:
            j = i
            while j < end_idx and char_count_between_lines(i, j + 1) <= max_chars:
                j += 1
            if j == i:
                j = i + 1

            chunk = build_line_chunk(i, j)
            if chunk:
                result.append(chunk)

            back = j
            remaining_overlap = overlap
            while back > i and remaining_overlap > 0:
                back -= 1
                remaining_overlap -= line_lengths[back]
            i = max(back, j) 

        return result

    encoded = text.encode("utf-8", errors="ignore")
    line_starts = _line_start_byte_offsets(encoded)
    parser = _get_parser_for_file(path)

    chunks: List[Dict[str, Any]] = []

    if parser and num_lines > 0:
        try:
            tree = parser.parse(encoded)
            root = tree.root_node

            node_line_ranges: List[tuple[int, int]] = []
            for node in root.named_children:
                start_line_1b = _byte_offset_to_line_number(node.start_byte, line_starts)
                end_line_1b = _byte_offset_to_line_number(max(0, node.end_byte - 1), line_starts)
                start_idx = max(0, start_line_1b - 1)
                end_idx = min(num_lines, end_line_1b)
                if start_idx < end_idx:
                    node_line_ranges.append((start_idx, end_idx))

            merged_ranges: List[tuple[int, int]] = []
            if node_line_ranges:
                cur_start, cur_end = node_line_ranges[0]
                for s, e in node_line_ranges[1:]:
                    trimmed_s, trimmed_e = _trim_noise_line_edges(lines, cur_start, e)
                    length = char_count_between_lines(trimmed_s, trimmed_e)
                    if length <= max_chars:
                        cur_end = e
                    else:
                        merged_ranges.append((cur_start, cur_end))
                        cur_start, cur_end = s, e
                merged_ranges.append((cur_start, cur_end))

            for start_idx, end_idx in merged_ranges:
                trimmed_s, trimmed_e = _trim_noise_line_edges(lines, start_idx, end_idx)
                if trimmed_s >= trimmed_e:
                    continue
                if char_count_between_lines(trimmed_s, trimmed_e) <= max_chars:
                    chunk = build_line_chunk(trimmed_s, trimmed_e)
                    if chunk:
                        chunks.append(chunk)
                else:
                    chunks.extend(split_by_window(trimmed_s, trimmed_e))

        except Exception as exc: 
            logging.warning(f"Tree-sitter parsing failed for {path}: {exc}")
            chunks = []

    if not chunks:
        chunks = split_by_window(0, num_lines)

    return [c for c in chunks if c.get("content", "").strip()]


chunk_code = chunk_source_code
