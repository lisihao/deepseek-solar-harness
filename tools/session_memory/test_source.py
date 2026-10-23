from __future__ import annotations

import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

try:
    from .source import (
        DuplicateSessionError,
        RegistryError,
        SourceFormatError,
        inventory,
        load_session,
    )
except ImportError:  # unittest discover -s tools/session_memory
    from source import (  # type: ignore[no-redef]
        DuplicateSessionError,
        RegistryError,
        SourceFormatError,
        inventory,
        load_session,
    )


ZSTD = shutil.which("zstd")


class SourceReaderTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name) / "dsh"
        (self.home / "dsh-chat-import").mkdir(parents=True)
        (self.home / "sessions").mkdir()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def write_registry(self, imports: dict, version: int = 1) -> None:
        (self.home / "dsh-chat-import" / "imports.json").write_text(
            json.dumps({"version": version, "imports": imports}), encoding="utf-8"
        )

    def write_session(
        self,
        session_id: str,
        records: list[dict],
        *,
        workspace: str = "/synthetic/workspace",
        compressed: bool = False,
        workspace_dir: str = "workspace",
    ) -> Path:
        session_dir = self.home / "sessions" / workspace_dir / session_id
        session_dir.mkdir(parents=True)
        data = [
            {
                "type": "session",
                "version": 4,
                "id": session_id,
                "cwd": workspace,
                "createdAt": 1,
            },
            *records,
        ]
        raw = "".join(json.dumps(record, ensure_ascii=False) + "\n" for record in data).encode()
        if not compressed:
            path = session_dir / "session.v4.jsonl"
            path.write_bytes(raw)
            return path
        if not ZSTD:
            self.skipTest("zstd executable is unavailable")
        path = session_dir / "session.v4.jsonl.zstd"
        completed = subprocess.run([ZSTD, "-q", "-c"], input=raw, capture_output=True, check=True)
        path.write_bytes(completed.stdout)
        return path

    @staticmethod
    def user(seq: int, text: str, source: str | None = None) -> dict:
        message = {"id": f"u-{seq}", "role": "user", "content": [{"type": "text", "text": text}]}
        if source is not None:
            message["source"] = {"kind": source}
        return {"type": "user/message", "seq": seq, "data": message}

    @staticmethod
    def assistant(seq: int, content: list[dict], source: str = "model") -> dict:
        return {
            "type": "assistant/message",
            "seq": seq,
            "data": {"message": {"id": f"a-{seq}", "role": "assistant", "content": content, "source": {"kind": source}}},
        }

    def test_inventory_single_multi_stats_and_superseded_copy(self) -> None:
        one_path = self.write_session("import-one", [self.user(1, "one")])
        multi_path = self.write_session("import-conv", [self.user(1, "multi")], workspace_dir="multi")
        self.write_registry(
            {
                "/original/codex-rollout.jsonl": {
                    "kind": "single",
                    "format": "codex",
                    "dshId": "import-one",
                    "turns": 1,
                    "events": 4,
                },
                "/original/conversations.json": {
                    "kind": "multi",
                    "format": "claude",
                    "conversations": {
                        "conv": {"dshId": "import-conv", "turns": 1, "events": 2},
                        "stale": {"dshId": "import-stale", "superseded": True},
                    },
                },
                "/original/other.json": {"kind": "single", "format": "dsh4", "dshId": "ignored"},
                "/original/copy.json": {
                    "kind": "single",
                    "format": "codex",
                    "dshId": "ignored-copy",
                    "copyOf": "import-one",
                },
            }
        )
        entries = inventory(self.home)
        self.assertEqual([entry["sessionId"] for entry in entries], ["import-conv", "import-one"])
        by_id = {entry["sessionId"]: entry for entry in entries}
        self.assertEqual(Path(by_id["import-one"]["path"]), one_path.resolve())
        self.assertEqual(Path(by_id["import-conv"]["path"]), multi_path.resolve())
        self.assertEqual(by_id["import-one"]["sourcePath"], "/original/codex-rollout.jsonl")
        self.assertEqual(by_id["import-one"]["registeredTurns"], 1)
        self.assertEqual(by_id["import-one"]["registeredEvents"], 4)

    def test_nested_v4_visible_text_title_and_auto_context_exclusions(self) -> None:
        session_id = "import-nested"
        self.write_session(
            session_id,
            [
                self.user(
                    1,
                    "keep this\n<environment_context>generated cwd</environment_context>\n<appshot id='1'>pixels</appshot>",
                    "human",
                ),
                self.user(2, "drop system prompt", "system-prompt"),
                self.assistant(
                    3,
                    [
                        {"type": "reasoning", "text": "hidden"},
                        {"type": "text", "text": "visible one"},
                        {"content": [{"type": "output_text", "text": "visible two"}]},
                        {"type": "tool-call", "name": "read"},
                    ],
                ),
                {"type": "tool/call", "seq": 4, "data": {"name": "read"}},
                {"type": "session/title", "seq": 5, "data": {"title": "Synthetic title"}},
            ],
        )
        self.write_registry({"/original.jsonl": {"kind": "single", "format": "codex", "dshId": session_id}})
        result = load_session(inventory(self.home)[0])
        self.assertEqual(result["title"], "Synthetic title")
        self.assertEqual([message["role"] for message in result["messages"]], ["user", "assistant"])
        self.assertEqual(result["messages"][0]["text"], "keep this")
        self.assertEqual(result["messages"][1]["text"], "visible one\nvisible two")
        self.assertEqual(result["excluded"]["autoContext"], 2)
        self.assertEqual(result["excluded"]["source"], 1)
        self.assertEqual(result["excluded"]["thinking"], 1)
        self.assertEqual(result["excluded"]["tools"], 2)

    def test_runtime_context_json_prefix_is_removed_but_real_json_prompt_is_kept(self) -> None:
        runtime = json.dumps(
            {
                "dshRuntimeContext": {
                    "version": 1,
                    "digest": "sha256:synthetic",
                    "contexts": [],
                    "precedence": "latest",
                }
            },
            separators=(",", ":"),
        )
        real_json_prompt = json.dumps(
            {
                "dshRuntimeContext": {"version": 1, "digest": "sha256:synthetic"},
                "prompt": "keep this task",
            },
            separators=(",", ":"),
        )
        session_id = "import-runtime-json"
        self.write_session(
            session_id,
            [
                self.user(1, runtime + "\nPlease preserve this task", "user"),
                self.user(2, real_json_prompt, "user"),
            ],
        )
        self.write_registry({"/source": {"kind": "single", "format": "codex", "dshId": session_id}})
        result = load_session(inventory(self.home)[0])
        self.assertEqual(result["messages"][0]["text"], "Please preserve this task")
        self.assertEqual(result["messages"][1]["text"], real_json_prompt)
        self.assertEqual(result["excluded"]["runtimeContext"], 1)

    def test_secret_redaction_and_compressed_source_hash(self) -> None:
        session_id = "import-secret"
        self.write_session(
            session_id,
            [
                self.user(
                    1,
                    "sk-live_123 Bearer abc.def token=top-secret api_key: 'key-value'\n"
                    '{"api_key":"json-secret","password":"json-pass"}\n'
                    "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
                    "user",
                ),
            ],
            compressed=True,
        )
        self.write_registry({"/does/not/exist/source.jsonl": {"kind": "single", "format": "claude", "dshId": session_id}})
        entry = inventory(self.home)[0]
        result = load_session(entry)
        text = result["messages"][0]["text"]
        self.assertNotIn("sk-live", text)
        self.assertNotIn("Bearer abc", text)
        self.assertNotIn("top-secret", text)
        self.assertNotIn("key-value", text)
        self.assertNotIn("json-secret", text)
        self.assertNotIn("json-pass", text)
        self.assertNotIn("PRIVATE KEY", text)
        self.assertGreaterEqual(result["excluded"]["redactions"], 5)
        self.assertEqual(result["sourceSha256"], hashlib.sha256(Path(entry["path"]).read_bytes()).hexdigest())

    def test_concat_zstd_frames_are_read_to_completion(self) -> None:
        if not ZSTD:
            self.skipTest("zstd executable is unavailable")
        session_id = "import-concat"
        session_dir = self.home / "sessions" / "concat" / session_id
        session_dir.mkdir(parents=True)
        first = {
            "type": "session",
            "version": 4,
            "id": session_id,
            "cwd": "/concat",
        }
        second = self.user(1, "from concatenated frame", "user")
        chunks = []
        for record in (first, second):
            completed = subprocess.run(
                [ZSTD, "-q", "-c"],
                input=(json.dumps(record) + "\n").encode(),
                capture_output=True,
                check=True,
            )
            chunks.append(completed.stdout)
        path = session_dir / "session.v4.jsonl.zstd"
        path.write_bytes(b"".join(chunks))
        self.write_registry({"/missing/source": {"kind": "single", "format": "codex", "dshId": session_id}})
        result = load_session(inventory(self.home)[0])
        self.assertEqual(result["messages"][0]["text"], "from concatenated frame")

    def test_source_path_is_provenance_only(self) -> None:
        session_id = "import-no-source-read"
        self.write_session(session_id, [self.user(1, "safe", "user")])
        missing = str(Path(self.temp.name) / "would-fail-if-opened.jsonl")
        self.write_registry({missing: {"kind": "single", "format": "codex", "dshId": session_id}})
        result = load_session(inventory(self.home)[0])
        self.assertEqual(result["sourcePath"], missing)
        self.assertFalse(Path(missing).exists())

    def test_reject_unknown_registry_version_schema_and_session_root_version(self) -> None:
        self.write_registry({}, version=2)
        with self.assertRaises(RegistryError):
            inventory(self.home)

        (self.home / "dsh-chat-import" / "imports.json").write_text(
            json.dumps({"version": 1, "imports": [], "unexpected": True}), encoding="utf-8"
        )
        with self.assertRaises(RegistryError):
            inventory(self.home)

        session_id = "import-bad-version"
        session_dir = self.home / "sessions" / "bad" / session_id
        session_dir.mkdir(parents=True)
        (session_dir / "session.v4.jsonl").write_text(
            json.dumps({"type": "session", "version": 5, "id": session_id}) + "\n", encoding="utf-8"
        )
        self.write_registry({"/source": {"kind": "single", "format": "codex", "dshId": session_id}})
        with self.assertRaises(SourceFormatError):
            inventory(self.home)

    def test_reject_invalid_json_and_incomplete_zstd_stream(self) -> None:
        session_id = "import-invalid-json"
        session_dir = self.home / "sessions" / "bad" / session_id
        session_dir.mkdir(parents=True)
        (session_dir / "session.v4.jsonl").write_text(
            json.dumps({"type": "session", "version": 4, "id": session_id}) + "\n{bad\n", encoding="utf-8"
        )
        self.write_registry({"/source": {"kind": "single", "format": "codex", "dshId": session_id}})
        with self.assertRaises(SourceFormatError):
            inventory(self.home)

        if not ZSTD:
            return
        self.temp.cleanup()
        self.setUp()
        session_id = "import-incomplete-zstd"
        path = self.write_session(session_id, [self.user(1, "ok", "user")], compressed=True)
        path.write_bytes(path.read_bytes()[:-3])
        self.write_registry({"/source": {"kind": "single", "format": "codex", "dshId": session_id}})
        with self.assertRaises(SourceFormatError):
            inventory(self.home)

    def test_duplicate_session_files_are_rejected(self) -> None:
        session_id = "import-duplicate"
        self.write_session(session_id, [self.user(1, "raw", "user")], workspace_dir="one")
        self.write_session(session_id, [self.user(1, "other", "user")], workspace_dir="two")
        self.write_registry({"/source": {"kind": "single", "format": "codex", "dshId": session_id}})
        with self.assertRaises(DuplicateSessionError):
            inventory(self.home)


if __name__ == "__main__":
    unittest.main()
