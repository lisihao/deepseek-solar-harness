#!/usr/bin/env python3
"""Deterministically validate the shared skill and bundled profiles."""

from __future__ import annotations

import importlib.util
import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SKILL = ROOT / "skill" / "agent-development-governance"
GOVERNANCE_SCRIPT = ROOT / "scripts" / "governance.py"


def fail(message: str) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)


def load_governance():
    spec = importlib.util.spec_from_file_location("governance", GOVERNANCE_SCRIPT)
    if spec is None or spec.loader is None:
        fail("cannot load governance.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_frontmatter() -> None:
    content = (SKILL / "SKILL.md").read_text(encoding="utf-8")
    match = re.match(r"\A---\n(.*?)\n---\n", content, re.DOTALL)
    if not match:
        fail("SKILL.md must start with YAML frontmatter")
    keys = []
    values = {}
    for line in match.group(1).splitlines():
        if not line.strip():
            continue
        if ":" not in line:
            fail(f"invalid frontmatter line: {line}")
        key, value = line.split(":", 1)
        keys.append(key.strip())
        values[key.strip()] = value.strip()
    if keys != ["name", "description"]:
        fail(f"frontmatter keys must be exactly name, description; got {keys}")
    if values["name"] != "agent-development-governance":
        fail("skill name mismatch")
    if len(values["description"]) < 80:
        fail("skill description is too short to trigger reliably")


def validate_openai_metadata() -> None:
    text = (SKILL / "agents" / "openai.yaml").read_text(encoding="utf-8")
    for key in ("display_name:", "short_description:", "default_prompt:"):
        if key not in text:
            fail(f"openai.yaml missing {key}")
    if "$agent-development-governance" not in text:
        fail("default_prompt must explicitly invoke the skill")


def validate_profiles() -> None:
    governance = load_governance()
    references = SKILL / "references"
    for name in ("genesispod-profile.json", "profile-template.json"):
        path = references / name
        profile = json.loads(path.read_text(encoding="utf-8"))
        governance.validate_profile(profile, path)
    schema = json.loads((references / "profile-schema.json").read_text(encoding="utf-8"))
    if schema.get("properties", {}).get("profile_version", {}).get("const") != 1:
        fail("profile schema version mismatch")


def validate_shared_script() -> None:
    linked = SKILL / "scripts" / "governance.py"
    if not linked.is_symlink():
        fail("skill governance.py must be a symlink to the shared Code Harness")
    if linked.resolve() != GOVERNANCE_SCRIPT:
        fail(f"skill harness resolves to wrong target: {linked.resolve()}")


def main() -> None:
    validate_frontmatter()
    validate_openai_metadata()
    validate_profiles()
    validate_shared_script()
    print("Skill, metadata, profiles, schema, and shared Code Harness are valid.")


if __name__ == "__main__":
    main()
