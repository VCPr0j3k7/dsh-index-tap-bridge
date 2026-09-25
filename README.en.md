# dsh-index-tap-bridge

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%5E22.19.0%20%7C%7C%20%3E%3D24-339933.svg)](./package.json)

**English** | [简体中文](./README.md)

A compatibility layer for DeepSeek Harness (DSH) that makes the `tapIndex` injection channel
effective in the official Harness desktop shell, so third-party plugins that depend on it work
there as well.

It installs as a standalone bundle into a DSH profile. No changes to the source of the target
plugin are required.

---

## Contents

- [Background](#background)
- [Requirements](#requirements)
- [Installation](#installation)
- [Uninstallation](#uninstallation)
- [How It Works](#how-it-works)
- [Translation Rules](#translation-rules)
- [Activation Criteria](#activation-criteria)
- [Testing](#testing)
- [Known Limitations](#known-limitations)
- [License](#license)

## Background

`@deepseek-ai/dsh-host-webserver` exposes two channels for injecting content into `index.html`:

| Channel | Primary users | Official desktop shell |
| --- | --- | --- |
| Structured injection rows (`webserver/index-inject` event) | Official plugins (e.g. `dsh-client-modules`) | Works |
| Index transforms (`tapIndex(html => html)`) | Many third-party plugins | **Does not work** |

The cause is that the official desktop shell does not render the Host's `index.html`:

1. The window loads the SPA bundled with the shell (custom scheme `dsh-app://app/`, assets served
   from `dsh-web-frontend/dist`);
2. Once the Host has booted, it reports the result of `collectIndexInjections()` over IPC exactly
   once, and the shell applies each injection row according to its `kind`;
3. Transforms registered through `tapIndex` are executed only inside `renderIndex()`, and
   `renderIndex()` is triggered only when the Host renders the index itself — a path the desktop
   shell never takes.

The resulting symptom is that the plugin loads with no errors and is shown as enabled in the plugin
list, yet the `<script>` / `<style>` it injects is never loaded.

> Source comment on `applyIndexTaps()` in `@deepseek-ai/dsh-host-webserver`:
> *"the escape hatch for markup no IndexInjection row expresses"*

## Requirements

| Item | Requirement |
| --- | --- |
| Node.js | `^22.19.0 \|\| >=24` |
| DeepSeek Harness | Verified against the official desktop build `0.1.7-rc.2` |

## Installation

```bash
# Install into a given profile (web is the profile dsh creates on first run)
dsh plugin --profile web add github:VCPr0j3k7/dsh-index-tap-bridge
```

The official Harness desktop shell uses the `desktop` profile:

```bash
dsh plugin --profile desktop add github:VCPr0j3k7/dsh-index-tap-bridge
```

There is no need to edit `dsh.profile.bundles` manually. After pnpm finishes, `dsh plugin` runs
`reconcilePlugins()`, which appends every dependency declaring `dsh.bundle.patch` to the bundle
layer stack automatically.

To confirm it was registered:

```bash
dsh --profile web --dump-config      # the output should contain index-tap-bridge
```

The target harness must be **restarted** after installation. The desktop shell loads plugins at
startup; a running instance does not hot-reload them.

## Uninstallation

```bash
dsh plugin --profile desktop rm dsh-index-tap-bridge
```

Once the dependency is removed, `reconcilePlugins()` also cleans up the corresponding entry in
`dsh.profile.bundles`; if any residue remains, remove that entry manually. A harness restart is
required here as well.

## How It Works

At the moment the `webserver/index-inject` event is emitted (by which point all plugins have been
loaded and all taps registered):

1. Read `webServer.indexTaps` (the implementation of `tapIndex()` pushes onto this array; see the
   official implementation);
2. Run each transform against a minimal skeleton HTML document and extract the markup it **adds**;
3. Translate the added markup into structured injection rows and push them onto the injection table;
4. Deduplicate by `kind` and payload so that nothing is pushed twice.

The process is transparent to the original plugin: its transforms remain in `indexTaps`, and the
path taken by the browser and by `dsh web` through `renderIndex()` is unchanged. The bridge is
active only inside the desktop shell — see [Activation Criteria](#activation-criteria).

## Translation Rules

| Original markup | Translated to |
| --- | --- |
| `<script src="U">` | `{ kind: 'script-src', src: 'U' }` |
| `<script>inline code</script>` | `{ kind: 'script', text, placement }` |
| `<style>…</style>` | `{ kind: 'style', text }` |
| `<link>`, `div`, `span`, `template`, `noscript`, `iframe`, `meta` | `{ kind: 'html', placement, html }` |

A `<script>` must be mapped separately to `script` / `script-src` and cannot be carried by an
`html` row: the desktop frontend applies `html` rows with `insertAdjacentHTML()`, and a `<script>`
inserted that way will not execute.

## Activation Criteria

The criterion is whether the first two entries of `process.argv` contain `dsh-desktop-host`, which
is exactly how the official shell spawns the Host. This is currently the only signal that reliably
distinguishes whether the Host's index will be rendered — using Electron or `--expose-internals`
characteristics instead would also match self-contained shells (which load the Host URL themselves
and take the `renderIndex()` path), causing duplicate injection.

For troubleshooting, the decision can be overridden:

| Environment variable | Value | Effect |
| --- | --- | --- |
| `DSH_INDEX_TAP_BRIDGE` | `on` | Force enable |
| `DSH_INDEX_TAP_BRIDGE` | `off` | Force disable |

## Testing

```bash
npm test
```

`test/check.mjs` is a pure logic self-check (23 cases) that does not depend on the DSH runtime. It
covers the translation branches, dropping of empty payloads, order preservation, reporting of
untranslatable markup, and the desktop shell check. All 23 pass.

End-to-end verification: after installing and restarting the desktop shell, plugins that previously
failed to display their widgets should start working; if a plugin emits logs, the assets it injects
can be observed being requested.

## Known Limitations

- **Only translatable markup is translated.** If a `tapIndex` transform **modifies** existing markup
  rather than adding to it, the change cannot be translated. Such markup is listed via
  `console.warn` and is never silently ignored.
- **If the official implementation renames the `indexTaps` field, the bridge will silently stop
  working** (there is an `Array.isArray` guard, so no error is thrown). It would then need to be
  reimplemented by wrapping `tapIndex()`.
- **Markup such as `<canvas>` is never forced into an `html` row**: `insertAdjacentHTML` cannot
  express the semantics of replacing an existing node, so forcing a translation would produce
  incorrect results. Such markup is explicitly reported as untranslated.
- **The plugin library toggle in the official desktop shell rewrites `dsh.profile.bundles`**
  (it calls `sanitizeProfile(...)` internally to strip non-official bundles). If the bridge stops
  working, the first thing to check is whether its entry is still present in `bundles`.

## License

[MIT](./LICENSE)
