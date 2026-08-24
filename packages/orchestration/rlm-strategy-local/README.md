# dsh-rlm-strategy-local

English | [中文](README.zh.md)

Deterministic baseline RLM Provider. Automatic mode combines task/phase signals with the selected quality, speed, economy, or balanced objective; explicit Standard and RLM choices always override it. Strategy `1.3.0` uses Prime's one-level recursion default, assigns deliberately different analysis lenses to parallel leaves, and requires coverage-checked synthesis so duplicate leaves cannot masquerade as added quality.

The package also ships a keyless quality-evaluation contract. Reusable blind fixtures store two anonymous arms per case while a separate reveal-key file maps those arms to direct and RLM execution only after outputs are frozen. Daily development evaluates recorded fixtures without invoking a model; a release candidate may replace one pair with the single approved real-subscription blind run.

## Model Experience

Indirectly, through the bounded recursion plan applied to the selected node.

#### KV Cache effect

Enabling recursion adds bounded instructions to the sealed node request and changes its request prefix.

## Known Limitations and Deferred Work

- The baseline uses deterministic task, phase, and optimization signals rather than semantic classification or unproven quality claims.
- Its maximum depth, children, and turns are fixed safety bounds, not adaptive budgets.
- RLM is a quality hypothesis, not a guaranteed improvement; automatic policy must retain recorded evaluation evidence and may keep a task direct when no measured lift exists.
- The deterministic scorer checks explicit acceptance facts and budget envelopes. It does not replace an independent human or model judge for open-ended writing quality.
