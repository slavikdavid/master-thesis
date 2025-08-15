import re
from pathlib import Path
from typing import List, Optional
import logging

from tree_sitter import Parser
from tree_sitter_languages import get_parser

# map file extensions to Tree-sitter language names
EXT_TO_LANG = {
    ".py": "python",
    ".js": "javascript",
    ".ts": "typescript",
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


def _get_parser_for_path(path: str) -> Optional[Parser]:
    ext = Path(path).suffix.lower()
    lang_name = EXT_TO_LANG.get(ext)
    if not lang_name:
        return None

    # initialize parser once per language using the built-in helper
    if lang_name not in _PARSERS:
        try:
            parser = get_parser(lang_name)
            _PARSERS[lang_name] = parser
        except Exception as e:
            logging.warning(f"Failed to create parser for {lang_name}: {e}")
            _PARSERS[lang_name] = None
    return _PARSERS[lang_name]


def chunk_code(
    path: str,
    text: str,
    max_chars: int = 1000,
    overlap: int = 200
) -> List[str]:
    """
    1) Parse via Tree-sitter and collect top-level named children.
    2) Batch adjacent nodes into chunks <= max_chars.
    3) If one node > max_chars, split it on blank-line boundaries with overlap.
    4) If parse fails or yields nothing, slide over lines instead.
    """
    parser = _get_parser_for_path(path)
    chunks: List[str] = []

    if parser:
        try:
            tree = parser.parse(text.encode("utf8"))
            root = tree.root_node
            nodes = [
                text[n.start_byte:n.end_byte]
                for n in root.named_children
                if text[n.start_byte:n.end_byte].strip()
            ]

            batch: List[str] = []
            batch_size = 0
            for code in nodes:
                code_len = len(code)
                if batch and batch_size + code_len > max_chars:
                    chunks.append("\n\n".join(batch))
                    batch, batch_size = [], 0
                if code_len > max_chars:
                    chunks.extend(_split_on_blank_lines(code, max_chars, overlap))
                else:
                    batch.append(code)
                    batch_size += code_len + 2
            if batch:
                chunks.append("\n\n".join(batch))
        except Exception as e:
            logging.warning(f"Tree-sitter parsing failed for {path}: {e}")
            chunks = []

    if not chunks:
        lines = text.splitlines(keepends=True)
        start = 0
        while start < len(lines):
            cur_chunk = []
            cur_len = 0
            i = start
            while i < len(lines) and cur_len + len(lines[i]) <= max_chars:
                cur_chunk.append(lines[i])
                cur_len += len(lines[i])
                i += 1
            if not cur_chunk and i < len(lines):
                cur_chunk = [lines[i]]
                i += 1
            chunks.append("".join(cur_chunk))
            overlap_chars = overlap
            j = i
            while j > start and overlap_chars > 0:
                overlap_chars -= len(lines[j - 1])
                j -= 1
            start = max(j, start + 1)

    return [c for c in chunks if c.strip()]


def _split_on_blank_lines(code: str, max_chars: int, overlap: int) -> List[str]:
    parts = re.split(r"\n\s*\n", code)
    final: List[str] = []
    batch: List[str] = []
    size = 0

    for part in parts:
        part_len = len(part)
        if batch and size + part_len > max_chars:
            final.append("\n\n".join(batch))
            batch, size = [], 0
        if part_len > max_chars:
            start = 0
            while start < part_len:
                end = min(start + max_chars, part_len)
                final.append(part[start:end])
                start = end - overlap if end - overlap > 0 else end
        else:
            batch.append(part)
            size += part_len + 2
    if batch:
        final.append("\n\n".join(batch))

    return final