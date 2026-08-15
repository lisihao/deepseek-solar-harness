#!/usr/bin/env python3
"""Run the governance bundle against a real DeepSeek-Solar-Harness checkout."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
PLUGIN = ROOT / "plugins" / "deepseek-solar-harness-governance"


def run(argv: list[str], *, cwd: Path, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        argv,
        cwd=cwd,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=120,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip()
        raise RuntimeError(f"{argv!r} failed with exit {result.returncode}: {detail}")
    return result


def package_tarball() -> Path:
    result = run(["npm", "pack", "--json"], cwd=PLUGIN)
    payload = json.loads(result.stdout)
    filename = payload[0]["filename"]
    return (PLUGIN / filename).resolve()


def installed_plugin_root(home: Path, profile: str) -> Path:
    candidates = (
        home / "profiles" / profile / "node_modules" / "@lisihao" / "dsh-code-harness-governance",
        home / "profiles" / "node_modules" / "@lisihao" / "dsh-code-harness-governance",
    )
    for candidate in candidates:
        if candidate.is_dir():
            return candidate.resolve()
    raise RuntimeError(f"installed governance plugin not found under {home}")


def cordis_probe(dsh_root: Path, plugin_root: Path) -> dict[str, object]:
    index_uri = (plugin_root / "index.js").resolve().as_uri()
    invariant_uri = (plugin_root / "invariant.js").resolve().as_uri()
    project = ROOT.as_posix()
    source = f"""
import {{ Context }} from '@deepseek-ai/cordis';
import Session from '@deepseek-ai/dsh-session';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import Invariants from '@deepseek-ai/dsh-invariants';
import * as Governance from {json.dumps(index_uri)};
import * as GovernanceInvariant from {json.dumps(invariant_uri)};
const ctx = new Context();
await ctx.plugin(Session);
await ctx.plugin(SystemPrompt);
await ctx.plugin(Tools);
await ctx.plugin(Invariants);
await ctx.plugin(Governance);
await ctx.plugin(GovernanceInvariant);
const tools = ctx.tools.schemas().map(item => item.name).filter(name => name.startsWith('governance_'));
const session = ctx.sessions.create(undefined, {{ meta: {{ cwd: {json.dumps(project)} }} }});
const agent = {{ session }};
let invariantRejectedForgery = false;
try {{
  session.append('governance/completion-accepted', {{
    workId: 'forged', runId: 'forged', gitHead: 'forged',
    attestationSha256: 'forged', acceptedAt: new Date().toISOString(),
  }});
}} catch {{ invariantRejectedForgery = true; }}
const pushDenied = Boolean(ctx.governance.guardExecution({{
  name: 'bash', arguments: {{ command: 'git push origin main' }}, agent,
}}));
const trace = ctx.governance.trace(agent, 20);
const denied = trace.events.find(event =>
  event.type === 'governance/milestone-evaluated'
  && event.kind === 'delivery'
  && event.decision === 'denied'
  && event.reasonCode === 'missing-acceptance');
if (tools.length !== 5 || !invariantRejectedForgery || !pushDenied || denied === undefined) process.exit(2);
console.log(JSON.stringify({{ tools, invariantRejectedForgery, pushDenied, trace }}));
"""
    result = run(
        ["node", "--import", "tsx/esm", "--input-type=module", "-e", source],
        cwd=dsh_root,
    )
    return json.loads(result.stdout)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dsh-root", required=True, help="Authoritative DeepSeek-Solar-Harness source checkout")
    args = parser.parse_args()
    dsh_root = Path(args.dsh_root).expanduser().resolve()
    if not (dsh_root / "apps" / "cli" / "src" / "bin.ts").is_file():
        raise RuntimeError(f"not a DeepSeek-Solar-Harness source checkout: {dsh_root}")

    tarball = package_tarball()
    with tempfile.TemporaryDirectory(prefix="dsh-governance-host-") as home_text:
        home = Path(home_text)
        environment = dict(os.environ)
        environment["DSH_HOME"] = str(home)
        run(
            ["pnpm", "dsh", "plugin", "--profile", "governed-code", "add", str(tarball)],
            cwd=dsh_root,
            env=environment,
        )
        environment["DSH_COMMAND_JSON"] = json.dumps(
            [
                "node",
                "--import",
                "tsx/esm",
                str(dsh_root / "apps" / "cli" / "src" / "bin.ts"),
            ]
        )
        admitted = run(
            [
                "node",
                str(PLUGIN / "bin" / "dsh-governed.mjs"),
                "--profile",
                "governed-code",
                "--dump-config",
            ],
            cwd=dsh_root,
            env=environment,
        )
        for marker in (
            "@deepseek-ai/dsh-invariants",
            "@lisihao/dsh-code-harness-governance",
            "@lisihao/dsh-code-harness-governance/invariant",
            "strict: true",
        ):
            if marker not in admitted.stdout:
                raise RuntimeError(f"governed dump-config missing {marker}")
        installed_root = installed_plugin_root(home, "governed-code")
        cordis = cordis_probe(dsh_root, installed_root)

    evidence = {
        "status": "ok",
        "dsh_root": str(dsh_root),
        "bundle": str(tarball),
        "profile_admission": "ok",
        "installed_plugin": str(installed_root),
        "cordis": cordis,
    }
    print(json.dumps(evidence, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
