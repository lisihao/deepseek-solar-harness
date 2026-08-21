# dsh-rlm-strategy-local

English | [中文](README.zh.md)

Deterministic baseline RLM Provider. Automatic mode enables bounded node-local recursion only for explicit recursive/decomposition work, synthesis, or very large tasks.

## Model Experience

Indirectly, through the bounded recursion plan applied to the selected node.

#### KV Cache effect

Enabling recursion adds bounded instructions to the sealed node request and changes its request prefix.

## Known Limitations and Deferred Work

- The baseline uses deterministic task signals rather than semantic classification.
- Its maximum depth, children, and turns are fixed safety bounds, not adaptive budgets.
