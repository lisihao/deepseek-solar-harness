# ChatGPT Web source, release and installed-package alignment

The default branch contains the complete `incubator/chatgpt-web/` source tree for `@lisihao/dsh-solar-chatgpt-web@0.1.0-dev.1`, including the inline-code submission-receipt repair. The source was taken unchanged from the published release commit `dacea6eac926f58bb65b683d56b028a4eaecfa57`. The existing preview remains under `incubator/`; this integration does not publish a stable Discover market entry.

The release archive remains `lisihao-dsh-solar-chatgpt-web-0.1.0-dev.1.tgz`, SHA-256 `d74d6d99ba9670e9bebea0f83d0f34ac3656c4c82ff25014a8cdaf1d53fe4e71`. The default branch's `distribution/plugins/catalog.json` retains that exact release commit, version and archive identity. The previously published tag and assets are not rewritten.

## Included development dependencies

The Web production imports of Native Collaboration and Native Resident are type-only. The integration includes the workflow contract, store and validation modules needed by Web's existing conversation tests, their existing tests, and the optional Resident predecessor-reference type field. It preserves the existing native plugin entrypoints and runtime engine. These supporting declarations do not activate the larger Collaboration UI or predecessor-output runtime work from the separate development branch. The optional peer services retain their separately distributed package/runtime acceptance boundaries.

The root build adds Web's server, operator and browser entrypoints and TypeScript declarations. It uses the same Web build settings as the released source and retains the existing native build entries. The dependency lock and published-baseline scratch CLI probe are checked in with the source.

## Reproduce the comparison

Install the locked development dependencies, then run:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm verify:web-release
```

`verify:web-release` compares every regular file in the catalogued archive with the current built package, including all JavaScript, source maps, declarations and metadata. It checks the archive SHA-256 and package name/version and fails on the first missing or differing file. It reads files without extracting or installing them. This is an explicit release-alignment check; ordinary in-progress behavior changes can differ from the last release until their own release is prepared.

To compare an existing local install as a third target, use the installed package directory:

```sh
python3 tools/check-chatgpt-web-alignment.py --installed ~/.dsh/profiles/desktop/node_modules/@lisihao/dsh-solar-chatgpt-web
```

On 2026-10-23 the default-branch integration build and the existing MacBook install each matched all 55 files in the released package. Repacking the integration build also reproduced the complete published tarball SHA-256 exactly. The integrated full gate passed 341 tests, build/types, the built-package published-baseline CLI probes, curated-package checks and homepage/installer checks. A modified-build negative control was rejected. The complete Web source tree is also compared with the release commit before merge and against the remote default branch after merge.

The same installed archive previously completed one explicitly approved ordinary-conversation request returning `PURGE_UI_OK`, with the right sidebar usable and no Purge environment notice. That acceptance applies to the unchanged archive bytes. This source-only integration does not reinstall the App or make another model call, and does not establish full Insight workflow acceptance.
