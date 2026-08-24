# dsh-rlm-strategy-local

English | [中文](README.zh.md)

Deterministic baseline RLM Provider. Automatic mode enables bounded node-local recursion only for explicit recursive/decomposition work, synthesis, or very large tasks. Strategy `1.1.0` assigns deliberately different analysis lenses to parallel leaves and requires coverage-checked synthesis so duplicate leaves cannot masquerade as added quality.

## Model Experience

Indirectly, through the bounded recursion plan applied to the selected node.

#### KV Cache effect

Enabling recursion adds bounded instructions to the sealed node request and changes its request prefix.

## Known Limitations and Deferred Work

- The baseline uses deterministic task signals rather than semantic classification.
- Its maximum depth, children, and turns are fixed safety bounds, not adaptive budgets.
- RLM is a quality hypothesis, not a guaranteed improvement; automatic policy must retain recorded evaluation evidence and may keep a task direct when no measured lift exists.
