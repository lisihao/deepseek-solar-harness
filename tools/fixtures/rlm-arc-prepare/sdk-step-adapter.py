#!/usr/bin/env python3
"""Explicit arc-agi 0.9.9 step facade for the pinned Prime ARC broker.

The pinned broker calls ``LocalEnvironmentWrapper.action1()`` through
``action7()``.  arc-agi 0.9.9 exposes the same operations through
``LocalEnvironmentWrapper.step(GameAction, data=...)`` instead.  This adapter
changes only that method dispatch after constructing the unmodified broker;
the broker's action budget, batch handling, reset policy, and terminal logic
remain the author's code.
"""

from __future__ import annotations

import argparse
import importlib.util
import inspect
import json
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

from arcengine import GameAction


def _load_broker_module(source: Path) -> ModuleType:
    path = source / "arc3_local_broker.py"
    spec = importlib.util.spec_from_file_location("pinned_prime_arc3_local_broker", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load pinned broker: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _check_step_signature(env: Any) -> dict[str, Any]:
    step = getattr(type(env), "step", None)
    if step is None:
        raise RuntimeError("arc-agi environment has no step method")
    signature = inspect.signature(step)
    names = list(signature.parameters)
    if names[:4] != ["self", "action", "data", "reasoning"]:
        raise RuntimeError(f"unexpected step signature: {signature}")
    return {"signature": str(signature), "parameters": names}


class StepFacade:
    """Expose the action methods expected by the pinned broker."""

    def __init__(self, environment: Any) -> None:
        self._environment = environment
        self.step_signature = _check_step_signature(environment)

    def reset(self) -> Any:
        return self._environment.reset()

    def _simple(self, action: GameAction) -> Any:
        return self._environment.step(action)

    def action1(self) -> Any:
        return self._simple(GameAction.ACTION1)

    def action2(self) -> Any:
        return self._simple(GameAction.ACTION2)

    def action3(self) -> Any:
        return self._simple(GameAction.ACTION3)

    def action4(self) -> Any:
        return self._simple(GameAction.ACTION4)

    def action5(self) -> Any:
        return self._simple(GameAction.ACTION5)

    def action6(self, x: int, y: int) -> Any:
        return self._environment.step(GameAction.ACTION6, data={"x": x, "y": y})

    def action7(self) -> Any:
        return self._simple(GameAction.ACTION7)


def run_spy() -> dict[str, Any]:
    """Exercise every facade action without importing or running a game."""

    calls: list[dict[str, Any]] = []

    class SpyEnvironment:
        def reset(self) -> str:
            calls.append({"method": "reset"})
            return "reset"

        def step(self, action: GameAction, data: dict[str, Any] | None = None, reasoning: dict[str, Any] | None = None) -> str:
            calls.append({"method": "step", "action": action.name, "actionValue": action.value, "data": data, "reasoning": reasoning})
            return action.name

    facade = StepFacade(SpyEnvironment())
    facade.reset()
    facade.action1()
    facade.action2()
    facade.action3()
    facade.action4()
    facade.action5()
    facade.action6(17, 42)
    facade.action7()
    expected_actions = ["ACTION1", "ACTION2", "ACTION3", "ACTION4", "ACTION5", "ACTION6", "ACTION7"]
    actual_actions = [call["action"] for call in calls if call["method"] == "step"]
    action6 = next(call for call in calls if call.get("action") == "ACTION6")
    passed = (
        calls[0] == {"method": "reset"}
        and actual_actions == expected_actions
        and action6["data"] == {"x": 17, "y": 42}
        and all(call["reasoning"] is None for call in calls if call["method"] == "step")
    )
    return {"passed": passed, "stepSignature": facade.step_signature, "calls": calls, "coordinates": action6["data"]}


def run_broker(args: argparse.Namespace) -> None:
    source = Path(args.source).resolve()
    module = _load_broker_module(source)
    broker = module.Broker(Path(args.corpus), args.game)
    original_environment = broker.handle.env
    broker.handle.env = StepFacade(original_environment)
    module.serve(broker, Path(args.socket))


def main() -> int:
    parser = argparse.ArgumentParser(description="explicit arc-agi step facade for the pinned Prime ARC broker")
    parser.add_argument("--spy", action="store_true")
    parser.add_argument("--source")
    parser.add_argument("--corpus")
    parser.add_argument("--game")
    parser.add_argument("--socket")
    args = parser.parse_args()
    if args.spy:
        if any(value is not None for value in (args.source, args.corpus, args.game, args.socket)):
            parser.error("--spy cannot be combined with broker paths")
        result = run_spy()
        print(json.dumps(result, separators=(",", ":")))
        return 0 if result["passed"] else 1
    if not all((args.source, args.corpus, args.game, args.socket)):
        parser.error("broker mode requires --source, --corpus, --game, and --socket")
    run_broker(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

