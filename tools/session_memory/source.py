"""Read imported DSH v4 sessions for the memory pilot.

The importer registry is the authority for which sessions are eligible.  The
source transcript itself is the DSH-owned ``session.v4.jsonl`` (optionally
zstd-compressed) under ``$DSH_HOME/sessions``.  Registry source paths are kept
as provenance only; this module never opens them.
"""

from __future__ import annotations

from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import subprocess
from typing import Any, Iterable, Iterator, Mapping


REGISTRY_VERSION = 1
SESSION_VERSION = 4
SUPPORTED_FORMATS = frozenset({"codex", "claude"})
KNOWN_IMPORTER_FORMATS = frozenset(
    {
        "codex",
        "claude",
        "chatgpt",
        "cursor",
        "gemini",
        "reasonix",
        "opencode",
        "zcode",
        "grokbuild",
        "openclaw",
        "pi",
        "hermes",
        "dsh",
        "dsh4",
        "antigravity",
        "workbuddy",
        "local-jsonl",
    }
)
SESSION_FILENAMES = frozenset({"session.v4.jsonl", "session.v4.jsonl.zstd"})


class SourceReaderError(ValueError):
    """The registry or DSH session is not safe and valid for this reader."""


class RegistryError(SourceReaderError):
    """The dsh-chat-import registry is missing or has an unsupported schema."""


class SourceFormatError(SourceReaderError):
    """A selected DSH session is not a complete v4 JSONL stream."""


class DuplicateSessionError(SourceReaderError):
    """More than one DSH log claims the same imported session id."""


_AUTO_CONTEXT_TAGS = (
    "environment_context",
    "appshot",
    "appshots",
    "app_snapshot",
    "screen_context",
    "browser_context",
    "computer_context",
    "user_context",
    "workspace_context",
)
_AUTO_CONTEXT_TAG_PATTERN = "|".join(re.escape(tag) for tag in _AUTO_CONTEXT_TAGS)
_AUTO_CONTEXT_BLOCK_RE = re.compile(
    rf"<(?P<tag>{_AUTO_CONTEXT_TAG_PATTERN})\b[^>]*>.*?</(?P=tag)\s*>",
    re.IGNORECASE | re.DOTALL,
)
_AUTO_CONTEXT_EMPTY_RE = re.compile(
    rf"<(?P<tag>{_AUTO_CONTEXT_TAG_PATTERN})\b[^>]*/\s*>",
    re.IGNORECASE,
)

# These patterns intentionally target the shape of credentials, rather than
# every occurrence of words such as "token" in ordinary prose.
_PEM_RE = re.compile(
    r"-----BEGIN [^-\r\n]+-----.*?-----END [^-\r\n]+-----",
    re.IGNORECASE | re.DOTALL,
)
_SK_TOKEN_RE = re.compile(r"\bsk-[A-Za-z0-9][A-Za-z0-9._-]{2,}\b")
_BEARER_RE = re.compile(
    r"(?i)(\bBearer\s+)[A-Za-z0-9._~+/=-]+",
)
_ASSIGNED_SECRET_RE = re.compile(
    r"(?ix)"
    r"(?P<prefix>[\"']?\b(?:api[_-]?key|password|token)\b[\"']?\s*[:=]\s*)"
    r"(?P<value>\"[^\"\r\n]*\"|'[^'\r\n]*'|[^\s,;\}\]\)]+)",
)

_NON_TEXT_BLOCK_TYPES = frozenset(
    {
        "reasoning",
        "thinking",
        "analysis",
        "tool-call",
        "tool_call",
        "tool-use",
        "tool_use",
        "image",
        "input_image",
        "audio",
        "file",
    }
)
_VISIBLE_TEXT_BLOCK_TYPES = frozenset(
    {"text", "output_text", "input_text", "plain_text"}
)


def _ensure_requested_formats(formats: Iterable[str] | None) -> frozenset[str]:
    requested = SUPPORTED_FORMATS if formats is None else frozenset(formats)
    if not requested.issubset(SUPPORTED_FORMATS):
        unknown = sorted(requested - SUPPORTED_FORMATS)
        raise SourceReaderError(f"Unsupported requested session format(s): {unknown}")
    return requested


def _load_registry(dsh_home: Path) -> Mapping[str, Any]:
    registry_path = Path(dsh_home) / "dsh-chat-import" / "imports.json"
    try:
        raw = registry_path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise RegistryError(f"Import registry not found: {registry_path}") from exc
    except OSError as exc:
        raise RegistryError(f"Cannot read import registry: {registry_path}") from exc
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RegistryError(f"Invalid import registry JSON: {registry_path}") from exc
    if not isinstance(value, dict) or set(value) != {"version", "imports"}:
        raise RegistryError("Unsupported import registry schema; expected version and imports")
    if value.get("version") != REGISTRY_VERSION:
        raise RegistryError(f"Unsupported import registry version: {value.get('version')!r}")
    imports = value.get("imports")
    if not isinstance(imports, dict):
        raise RegistryError("Import registry imports must be an object")
    return value


def _is_superseded_or_copy(record: Mapping[str, Any]) -> bool:
    """Return true for records which are not the current imported session.

    The importer can retain force-import copies.  They are intentionally not
    followed here: the memory pilot uses the current non-copy source record.
    """

    if record.get("superseded") or record.get("isCopy"):
        return True
    if record.get("copy") or record.get("copyOf"):
        return True
    if record.get("supersededBy"):
        return True
    status = record.get("status")
    if status in {"superseded", "copy", "archived"} or (
        isinstance(status, str) and status.startswith("superseded")
    ):
        return True
    return False


def _record_format(record: Mapping[str, Any], source_path: str) -> str:
    fmt = record.get("format")
    if not isinstance(fmt, str) or not fmt.strip():
        raise RegistryError(f"Registry entry has no format: {source_path}")
    return fmt.strip().lower()


def _record_id(record: Mapping[str, Any], source_path: str) -> str:
    session_id = record.get("dshId")
    if not isinstance(session_id, str) or not session_id.strip():
        raise RegistryError(f"Registry entry has no dshId: {source_path}")
    session_id = session_id.strip()
    # The DSH session layout is sessions/<workspace>/<id>/; allowing a slash
    # here would turn a registry value into a path selector.
    if session_id in {".", ".."} or "/" in session_id or "\\" in session_id:
        raise RegistryError(f"Unsafe dshId in registry: {session_id!r}")
    return session_id


def _stats(record: Mapping[str, Any]) -> dict[str, int]:
    out: dict[str, int] = {}
    for source_key, public_key in (("turns", "registeredTurns"), ("events", "registeredEvents")):
        value = record.get(source_key)
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            out[public_key] = value
            # Keep the importer names too; callers that already know the
            # registry can use either spelling without guessing.
            out[source_key] = value
    return out


def _iter_registry_entries(
    imports: Mapping[str, Any], requested: frozenset[str]
) -> Iterator[dict[str, Any]]:
    """Yield selected current single or multi registry records."""

    for source_key in sorted(imports, key=lambda key: str(key)):
        raw_record = imports[source_key]
        if not isinstance(source_key, str) or not source_key:
            raise RegistryError("Import registry source path keys must be non-empty strings")
        if isinstance(raw_record, str):
            # Legacy string records have no format and therefore cannot be
            # safely selected by this bounded reader.
            continue
        if not isinstance(raw_record, dict):
            raise RegistryError(f"Unsupported registry entry schema: {source_key}")
        fmt = _record_format(raw_record, source_key)
        if fmt not in KNOWN_IMPORTER_FORMATS:
            raise RegistryError(f"Unknown registry format: {fmt!r}")
        if fmt not in requested:
            # The real registry also contains other importer formats.  They
            # are outside this pilot's authority and remain untouched.
            continue
        if fmt not in SUPPORTED_FORMATS:
            raise RegistryError(f"Unsupported registry format: {fmt!r}")
        if _is_superseded_or_copy(raw_record):
            continue
        kind = raw_record.get("kind")
        if kind == "single":
            session_id = _record_id(raw_record, source_key)
            item = {
                "sessionId": session_id,
                "format": fmt,
                "sourcePath": source_key,
                "kind": "single",
            }
            item.update(_stats(raw_record))
            yield item
            continue
        if kind != "multi":
            raise RegistryError(f"Unsupported registry kind {kind!r}: {source_key}")

        tables = [name for name in ("conversations", "sessions") if name in raw_record]
        if len(tables) != 1 or not isinstance(raw_record.get(tables[0]), dict):
            raise RegistryError(
                f"Multi registry entry must contain one sessions or conversations table: {source_key}"
            )
        table_name = tables[0]
        table = raw_record[table_name]
        for source_session_key in sorted(table):
            sub_record = table[source_session_key]
            if not isinstance(source_session_key, str) or not source_session_key:
                raise RegistryError(f"Invalid multi-session key: {source_key}")
            if not isinstance(sub_record, dict):
                raise RegistryError(f"Invalid multi-session record: {source_key}#{source_session_key}")
            if _is_superseded_or_copy(sub_record):
                continue
            session_id = _record_id(sub_record, f"{source_key}#{source_session_key}")
            item = {
                "sessionId": session_id,
                "format": fmt,
                "sourcePath": source_key,
                "kind": "multi",
                "sourceSessionId": source_session_key,
            }
            item.update(_stats(sub_record))
            yield item


def _safe_path(path: Path, session_root: Path) -> Path:
    try:
        resolved = path.resolve(strict=True)
    except OSError as exc:
        raise SourceReaderError(f"Session source is not readable: {path}") from exc
    root = session_root.resolve(strict=True)
    try:
        relative = resolved.relative_to(root)
    except ValueError as exc:
        raise SourceReaderError(f"Session path escapes the DSH session root: {path}") from exc
    if len(relative.parts) != 3 or relative.parts[-1] not in SESSION_FILENAMES:
        raise SourceReaderError(f"Unsupported DSH session path: {path}")
    return resolved


def _source_process(path: Path) -> subprocess.Popen[bytes]:
    try:
        return subprocess.Popen(
            ["zstd", "-d", "-c", "--", str(path)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except OSError as exc:
        raise SourceFormatError("Unable to start the zstd decompressor") from exc


def _iter_source_bytes(path: Path) -> Iterator[bytes]:
    if path.name == "session.v4.jsonl":
        try:
            with path.open("rb") as stream:
                yield from stream
        except OSError as exc:
            raise SourceFormatError(f"Cannot read DSH session source: {path}") from exc
        return

    if path.name != "session.v4.jsonl.zstd":
        raise SourceFormatError(f"Unsupported DSH session source suffix: {path.name}")

    process = _source_process(path)
    assert process.stdout is not None
    assert process.stderr is not None
    try:
        yield from process.stdout
        process.stdout.close()
        stderr = process.stderr.read()
        return_code = process.wait()
        if return_code != 0:
            detail = stderr.decode("utf-8", "replace").strip()
            raise SourceFormatError(
                f"zstd failed for {path} (exit {return_code}): {detail[:300]}"
            )
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        if process.stdout is not None and not process.stdout.closed:
            process.stdout.close()
        if process.stderr is not None and not process.stderr.closed:
            process.stderr.close()


def _iter_records(path: Path) -> Iterator[tuple[int, dict[str, Any]]]:
    for line_number, raw_line in enumerate(_iter_source_bytes(path), start=1):
        if not raw_line.strip():
            raise SourceFormatError(f"Blank JSONL record at line {line_number}: {path}")
        try:
            line = raw_line.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise SourceFormatError(f"Non-UTF-8 JSONL record at line {line_number}: {path}") from exc
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            raise SourceFormatError(f"Invalid JSONL record at line {line_number}: {path}") from exc
        if not isinstance(value, dict):
            raise SourceFormatError(f"JSONL record is not an object at line {line_number}: {path}")
        yield line_number, value


def _validate_header(record: Mapping[str, Any], expected_id: str, path: Path) -> dict[str, Any]:
    if record.get("type") != "session":
        raise SourceFormatError(f"DSH session header is missing at {path}")
    if record.get("version") != SESSION_VERSION:
        raise SourceFormatError(
            f"Unsupported DSH session root version {record.get('version')!r}: {path}"
        )
    header_id = record.get("id")
    if not isinstance(header_id, str) or header_id != expected_id:
        raise SourceFormatError(
            f"DSH session header id does not match registry ({expected_id!r}): {path}"
        )
    return dict(record)


def _session_metadata(path: Path, expected_id: str) -> tuple[dict[str, Any], str | None]:
    records = _iter_records(path)
    try:
        _line_number, first = next(records)
    except StopIteration as exc:
        raise SourceFormatError(f"Empty DSH session source: {path}") from exc
    header = _validate_header(first, expected_id, path)
    title: str | None = None
    for line_number, record in records:
        if not isinstance(record.get("type"), str):
            raise SourceFormatError(f"Event type is missing at line {line_number}: {path}")
        if record.get("type") != "session/title":
            continue
        data = record.get("data")
        candidate = data.get("title") if isinstance(data, dict) else record.get("title")
        if isinstance(candidate, str) and candidate.strip():
            title = candidate.strip()
    if title is not None:
        title, _ = _redact_text(title)
    workspace = header.get("cwd")
    if workspace is not None and not isinstance(workspace, str):
        raise SourceFormatError(f"DSH session cwd is not a string: {path}")
    return header, title


def _find_session_path(dsh_home: Path, session_id: str) -> Path:
    session_root = (Path(dsh_home) / "sessions")
    try:
        root = session_root.resolve(strict=True)
    except OSError as exc:
        raise SourceReaderError(f"DSH session root not found: {session_root}") from exc
    if not root.is_dir():
        raise SourceReaderError(f"DSH session root is not a directory: {root}")
    candidates: list[Path] = []
    try:
        workspace_dirs = sorted(root.iterdir(), key=lambda p: p.name)
    except OSError as exc:
        raise SourceReaderError(f"Cannot scan DSH session root: {root}") from exc
    for workspace_dir in workspace_dirs:
        if not workspace_dir.is_dir():
            continue
        session_dir = workspace_dir / session_id
        if not session_dir.exists():
            continue
        if not session_dir.is_dir():
            raise SourceReaderError(f"DSH session id path is not a directory: {session_dir}")
        for name in sorted(SESSION_FILENAMES):
            candidate = session_dir / name
            if not candidate.exists():
                continue
            safe = _safe_path(candidate, root)
            candidates.append(safe)
    if not candidates:
        raise SourceReaderError(f"No DSH v4 session source found for {session_id!r}")
    # The same id must not resolve to both raw and compressed logs, or to two
    # workspace folders.  Duplicates are ambiguous provenance and are rejected.
    unique = sorted(candidates, key=str)
    if len(unique) != 1:
        raise DuplicateSessionError(
            f"Multiple DSH v4 session sources found for {session_id!r}: {[str(p) for p in unique]}"
        )
    path = unique[0]
    return path


def _hash_source(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as exc:
        raise SourceFormatError(f"Cannot hash DSH session source: {path}") from exc
    return digest.hexdigest()


def _text_from_content(value: Any) -> tuple[list[str], Counter[str]]:
    """Extract visible text and count deliberately non-visible content blocks."""

    excluded: Counter[str] = Counter()

    def visit(node: Any) -> list[str]:
        if isinstance(node, str):
            return [node]
        if isinstance(node, list):
            parts: list[str] = []
            for child in node:
                parts.extend(visit(child))
            return parts
        if not isinstance(node, dict):
            return []

        block_type = node.get("type")
        if isinstance(block_type, str):
            normalized = block_type.strip().lower()
            if normalized in {t.lower() for t in _NON_TEXT_BLOCK_TYPES}:
                if "tool" in normalized:
                    excluded["tools"] += 1
                else:
                    excluded["thinking"] += 1
                return []
            if normalized in {t.lower() for t in _VISIBLE_TEXT_BLOCK_TYPES}:
                text = node.get("text")
                if isinstance(text, str):
                    return [text]
                return []

        # v4 message blocks normally use {type:'text', text:'...'}, while
        # imported nested messages may wrap blocks in content/parts arrays.
        text = node.get("text")
        if isinstance(text, str):
            return [text]
        for key in ("content", "parts", "segments", "output"):
            if key in node:
                return visit(node[key])
        return []

    return visit(value), excluded


def _remove_auto_context(text: str) -> tuple[str, int]:
    count = 0

    def remove_match(match: re.Match[str]) -> str:
        nonlocal count
        count += 1
        return ""

    text = _AUTO_CONTEXT_BLOCK_RE.sub(remove_match, text)
    text = _AUTO_CONTEXT_EMPTY_RE.sub(remove_match, text)
    return text, count


def _remove_runtime_context_json(text: str) -> tuple[str, int]:
    """Remove a known DSH runtime-context JSON prefix, preserving the prompt.

    DSH can prepend a JSON object such as ``{"dshRuntimeContext": ...}`` to a
    user message and then append the real request.  We only remove a complete
    object whose root contains exactly that key and whose context has the
    observed version/digest shape.  A JSON object with any other root field is
    retained because it may be the user's actual task or prompt.
    """

    leading = len(text) - len(text.lstrip())
    candidate = text[leading:]
    if not candidate.startswith("{"):
        return text, 0
    try:
        value, end = json.JSONDecoder().raw_decode(candidate)
    except json.JSONDecodeError:
        return text, 0
    if not isinstance(value, dict) or set(value) != {"dshRuntimeContext"}:
        return text, 0
    context = value.get("dshRuntimeContext")
    if not isinstance(context, dict):
        return text, 0
    if not isinstance(context.get("version"), int) or isinstance(context.get("version"), bool):
        return text, 0
    if not isinstance(context.get("digest"), str) or not context.get("digest"):
        return text, 0
    if set(context) - {"version", "digest", "contexts", "precedence"}:
        return text, 0
    if "contexts" in context and not isinstance(context["contexts"], list):
        return text, 0
    if "precedence" in context and not isinstance(context["precedence"], str):
        return text, 0
    return candidate[end:].lstrip(), 1


def _redact_text(text: str) -> tuple[str, int]:
    count = 0

    def replace(match: re.Match[str]) -> str:
        nonlocal count
        count += 1
        return "[REDACTED]"

    text = _PEM_RE.sub(replace, text)
    text = _SK_TOKEN_RE.sub(replace, text)
    text = _BEARER_RE.sub(lambda m: m.group(1) + replace(m), text)
    text = _ASSIGNED_SECRET_RE.sub(lambda m: m.group("prefix") + replace(m), text)
    return text, count


def _excluded_result(counter: Counter[str]) -> dict[str, int]:
    keys = (
        "system",
        "runtime",
        "skills",
        "compaction",
        "thinking",
        "tools",
        "source",
        "empty",
        "other",
        "autoContext",
        "runtimeContext",
        "redactions",
    )
    result = {key: int(counter.get(key, 0)) for key in keys}
    # The aliases make the explicit counters readable to both Python callers
    # and JSON consumers without changing the canonical camelCase names.
    result["auto_context"] = result["autoContext"]
    result["autoContextBlocks"] = result["autoContext"]
    result["runtime_context"] = result["runtimeContext"]
    result["runtimeContextBlocks"] = result["runtimeContext"]
    result["secretRedactions"] = result["redactions"]
    return result


def _event_exclusion_key(event_type: str) -> str | None:
    lowered = event_type.lower()
    if lowered in {"system/message", "system", "system-prompt"} or lowered.startswith("system/"):
        return "system"
    if "runtime" in lowered:
        return "runtime"
    if "skill" in lowered:
        return "skills"
    if "compaction" in lowered or "compact" in lowered:
        return "compaction"
    if "thinking" in lowered or "reasoning" in lowered:
        return "thinking"
    if lowered.startswith("tool/") or lowered in {"tool", "tool_call", "tool-result", "tool_result"}:
        return "tools"
    if lowered in {"session", "session/title", "session/end-seed", "turn/start", "turn/end", "step/start", "step/end", "permission/preset", "sandbox/mode", "approval/policy"}:
        return None
    return "other"


def _message_object(record: Mapping[str, Any]) -> Mapping[str, Any]:
    data = record.get("data")
    if not isinstance(data, dict):
        return {}
    nested = data.get("message")
    if isinstance(nested, dict):
        return nested
    return data


def _load_messages(path: Path, expected_id: str) -> tuple[dict[str, Any], str | None, list[dict[str, Any]], dict[str, int]]:
    records = _iter_records(path)
    try:
        _line_number, first = next(records)
    except StopIteration as exc:
        raise SourceFormatError(f"Empty DSH session source: {path}") from exc
    header = _validate_header(first, expected_id, path)
    title: str | None = None
    messages: list[dict[str, Any]] = []
    excluded: Counter[str] = Counter()

    for line_number, record in records:
        event_type = record.get("type")
        if not isinstance(event_type, str):
            raise SourceFormatError(f"Event type is missing at line {line_number}: {path}")
        if event_type == "session/title":
            data = record.get("data")
            candidate = data.get("title") if isinstance(data, dict) else record.get("title")
            if isinstance(candidate, str) and candidate.strip():
                title = candidate.strip()
            continue
        if event_type not in {"user/message", "assistant/message"}:
            key = _event_exclusion_key(event_type)
            if key is not None:
                excluded[key] += 1
            continue

        message = _message_object(record)
        source = message.get("source")
        source_kind = source.get("kind") if isinstance(source, dict) else None
        if event_type == "user/message" and source is not None and source_kind not in {"user", "human"}:
            excluded["source"] += 1
            continue
        seq = record.get("seq")
        if not isinstance(seq, int) or isinstance(seq, bool):
            raise SourceFormatError(f"Message sequence is missing at line {line_number}: {path}")
        text_parts, block_excluded = _text_from_content(message.get("content", message.get("text")))
        excluded.update(block_excluded)
        text = "\n".join(part for part in text_parts if part != "")
        if not text.strip():
            excluded["empty"] += 1
            continue
        if event_type == "user/message":
            text, runtime_count = _remove_runtime_context_json(text)
            excluded["runtimeContext"] += runtime_count
            text, context_count = _remove_auto_context(text)
            excluded["autoContext"] += context_count
        text, redaction_count = _redact_text(text)
        excluded["redactions"] += redaction_count
        text = text.strip()
        if not text:
            excluded["empty"] += 1
            continue
        messages.append({
            "seq": seq,
            "role": "user" if event_type == "user/message" else "assistant",
            "text": text,
        })

    if title is not None:
        title, title_redactions = _redact_text(title)
        excluded["redactions"] += title_redactions
    return header, title, messages, _excluded_result(excluded)


def _entry_path(entry: Mapping[str, Any]) -> Path:
    path = entry.get("path")
    if not isinstance(path, str) or not path:
        raise SourceReaderError("Inventory entry path must be a non-empty string")
    expected_id = entry.get("sessionId")
    if not isinstance(expected_id, str) or not expected_id:
        raise SourceReaderError("Inventory entry sessionId must be a non-empty string")
    path_obj = Path(path)
    # Derive the session root from the required sessions/<workspace>/<id>/file
    # shape.  This avoids trusting a caller-provided root or sourcePath.
    try:
        resolved = path_obj.resolve(strict=True)
    except OSError as exc:
        raise SourceReaderError(f"Inventory entry path is not readable: {path}") from exc
    if resolved.name not in SESSION_FILENAMES or resolved.parent.name != expected_id:
        raise SourceReaderError(f"Inventory entry path does not match sessionId: {path}")
    session_root = resolved.parents[2]
    if session_root.name != "sessions":
        raise SourceReaderError(f"Inventory entry path is outside a DSH sessions root: {path}")
    return _safe_path(resolved, session_root)


def inventory(dsh_home: Path, formats: set[str] | None = None) -> list[dict[str, Any]]:
    """List selected imported DSH sessions and their safe local log paths.

    Only the registry and DSH-owned session logs under ``dsh_home/sessions``
    are read.  Entries for other importer formats remain outside this pilot's
    authority and are skipped after the registry's version/schema is checked.
    """

    requested = _ensure_requested_formats(formats)
    registry = _load_registry(Path(dsh_home))
    entries: list[dict[str, Any]] = []
    session_cache: dict[str, tuple[Path, dict[str, Any], str | None]] = {}
    for item in _iter_registry_entries(registry["imports"], requested):
        session_id = item["sessionId"]
        if session_id not in session_cache:
            path = _find_session_path(Path(dsh_home), session_id)
            header, title = _session_metadata(path, session_id)
            session_cache[session_id] = (path, header, title)
        path, header, title = session_cache[session_id]
        result = dict(item)
        result.update({
            "path": str(path),
            "workspace": header.get("cwd"),
            "title": title,
        })
        entries.append(result)
    return sorted(entries, key=lambda value: (value["format"], value["sessionId"], value["sourcePath"]))


def load_session(entry: Mapping[str, Any]) -> dict[str, Any]:
    """Load clean, redacted visible messages from one inventory entry."""

    if not isinstance(entry, Mapping):
        raise SourceReaderError("Session inventory entry must be an object")
    fmt = entry.get("format")
    if not isinstance(fmt, str) or fmt.lower() not in SUPPORTED_FORMATS:
        raise SourceReaderError(f"Unsupported session format: {fmt!r}")
    session_id = entry.get("sessionId")
    if not isinstance(session_id, str) or not session_id:
        raise SourceReaderError("Session inventory entry has no sessionId")
    source_path = entry.get("sourcePath")
    if not isinstance(source_path, str) or not source_path:
        raise SourceReaderError("Session inventory entry has no sourcePath")
    path = _entry_path(entry)
    source_sha256_before = _hash_source(path)
    header, title, messages, excluded = _load_messages(path, session_id)
    source_sha256_after = _hash_source(path)
    if source_sha256_before != source_sha256_after:
        raise SourceReaderError(
            f"DSH session source changed while it was being read: {path}"
        )
    workspace = header.get("cwd")
    if workspace is None:
        workspace = entry.get("workspace")
    if title is None:
        candidate = entry.get("title")
        title = candidate.strip() if isinstance(candidate, str) and candidate.strip() else None
    return {
        "sessionId": session_id,
        "format": fmt.lower(),
        "workspace": workspace,
        "title": title,
        "path": str(path),
        "sourcePath": source_path,
        "sourceSha256": source_sha256_after,
        "messages": messages,
        "excluded": excluded,
    }


__all__ = [
    "DuplicateSessionError",
    "RegistryError",
    "SESSION_VERSION",
    "SUPPORTED_FORMATS",
    "SourceFormatError",
    "SourceReaderError",
    "inventory",
    "load_session",
]
