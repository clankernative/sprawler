# Contributing to Sprawler

Thanks for helping. Sprawler is a small Rust core plus separately installable analyzer plugins and
TOML rules packs. Most contributions fit one of those three places.

## Build and test

You need Rust 1.85 or newer. The C# plugin also needs the .NET SDK; the UI needs Node 22.

```sh
cargo build --workspace
cargo test --workspace
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
./target/debug/sprawler check . --fail-on minor     # Sprawler checks its own architecture
```

CI runs all of these on Linux and macOS (Windows too, not yet blocking). A pull request should pass
them locally first.

## Where things go

| Change | Where | Notes |
|---|---|---|
| Scoring, judging, findings | `crates/sprawler-domain` | Pure: no files, processes, network or clock. A test enforces it |
| CLI, server, scanning | `crates/sprawler` | Follows `ddd-hexagonal`: the atlas use case depends only on `ports.rs` |
| Plugin contract | `crates/sprawler-protocol`, `protocol/`, `docs/PROTOCOL.md` | Change all three together |
| A language | `plugins/analyzer-<name>` | Reports facts only, never policy |
| Architecture policy | `packs/architectures/`, `packs/platforms/` | TOML; every rule needs a `why` |
| The 3D UI | `web/src` | Run `cd web && npm ci && npm run build` and commit `crates/sprawler/web_dist` |

`sprawler.toml` encodes this repo's own rules. Don't loosen a rule to make the self-check pass; if a
finding is wrong, fix the map or the code and say why in the pull request.

## Adding an analyzer plugin

A plugin is an executable named `sprawler-analyzer-<name>` that answers `describe` and `analyze`
over JSON (see `docs/PROTOCOL.md`). Add a small fixture under `tests/fixtures/` and make sure

```sh
./target/debug/sprawler plugin test ./target/debug/sprawler-analyzer-<name> --dir tests/fixtures/<fixture>
```

passes. `describe` may publish `defaults`, a structure-only profile fragment used when a repo has
no profile.

## Adding or changing a pack

Packs are merged through `extends` (a list, left to right; a rule with the same `id` replaces the
earlier one). Rules are applied in order and the first match wins, so check that overlapping
rules keep their order. When you change a pack, compare an atlas before and after on a real repo
and describe any finding that moved.

## Commits and pull requests

- Keep formatting-only changes in their own commit.
- Describe what changed, how you verified it, and anything you could not verify.
- UI changes: include a screenshot.

By contributing you agree that your contribution is licensed under the MIT license (see `LICENSE`).
