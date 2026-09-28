# Changelog

## 0.3.1

- **Rust analyzer:** code under `#[cfg(test)]` (inline test modules, `#[cfg(test)] use`, files
  declared by `#[cfg(test)] mod x;`) no longer produces production dependencies, with or without
  Graphify. Production edges in the same file keep their line numbers. If you use
  `check --baseline`, removed findings show as "fixed"; rerun `sprawler baseline .` to refresh it.
- **Release:** an Intel Mac (`x86_64-apple-darwin`) archive again; only version tags (`v1.2.3`)
  trigger a release, so moving the `v0.3` tag doesn't.

## 0.3.0 — first public release

- **Core:** one `sprawler` binary with the 3D map built in. Scans a workspace, judges every
  dependency against a TOML profile, and scores it (policy, structure, or both) with an explicit
  confidence; the grade is withheld when the analyzers can't see enough.
- **Findings you can act on:** a FIX / IMPROVE / CHECK inbox, each finding with its `why`, and a
  self-contained fix prompt for an agent (`sprawler prompts`). `sprawler check` gates CI.
- **Analyzer plugins** (protocol `sprawler.analyzer/1`): Rust (native module resolution, optional
  Graphify symbols), Roc, TypeScript/JavaScript, Python, Go, and C# (Roslyn). `sprawler plugin
  add/list/remove/test`.
- **Rules packs:** `ddd-hexagonal`, with `cqrs` and `vertical-slices` add-ons, and the
  `clankernative` platform pack. Profiles `extends` a list of packs. `sprawler pack add/list/remove`.
- **No profile needed to start:** plugins publish structure-only defaults (Rust crates, Roc
  packages as contexts). `sprawler profile init` writes a starting profile; `sprawler profile
  explain` shows why each file lands where it does; `sprawler profile validate` checks it.
- **Views:** Interfaces (ports and their implementers) and Use cases (entry point inward),
  configured in `[views]`. Contract seams, commit history replay, achievements.
- **Agent-first:** every command has `--json`; `AGENTS.md` describes setup, mapping the
  architecture with the developer, and triaging findings.
