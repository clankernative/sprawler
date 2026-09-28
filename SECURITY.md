# Security

Sprawler runs locally. It reads your source files, runs analyzer plugins as child processes, runs
`git`, and (with `sprawler serve`) listens on `127.0.0.1` only. The core sends nothing over the
network. One exception, in a plugin: if Graphify is not installed, the Rust plugin runs it through
`uvx`, which may download it from PyPI. Install Graphify yourself (`uv tool install graphifyy`), or
set `SPRAWLER_GRAPHIFY` to a command that does not exist to skip it (the Rust plugin then resolves
modules natively and only symbol counts are missing).

Things to be aware of:

- **Plugins are executables.** Sprawler runs any `sprawler-analyzer-<name>` it finds on
  `SPRAWLER_PLUGIN_PATH`, next to the `sprawler` binary, in `~/.local/share/sprawler/plugins/bin`,
  or on `PATH`, and any path a profile names under `[analyzers]`. Only install plugins you trust,
  and review a profile's `[analyzers]` table before scanning with a profile you did not write.
- **Packs and profiles are data**, but their regexes and globs run against your files.

## Reporting a vulnerability

Please report it privately through GitHub's **Report a vulnerability** button on the repository's
Security tab, not in a public issue. Include what you found, how to reproduce it, and the version
(`sprawler --version`). We aim to acknowledge reports within a week.
