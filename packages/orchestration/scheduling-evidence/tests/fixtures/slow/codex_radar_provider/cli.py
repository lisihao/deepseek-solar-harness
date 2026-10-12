"""Test collector that records its pid and never answers, to prove the gateway ends a hung call's process."""

import os
import sys
import time

state_root = sys.argv[sys.argv.index("--state-root") + 1]
os.makedirs(state_root, exist_ok=True)
with open(os.path.join(state_root, "pid"), "w", encoding="utf-8") as handle:
    handle.write(str(os.getpid()))
time.sleep(120)
