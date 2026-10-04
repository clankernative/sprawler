# Sprawler for agents

Sprawler maps how a codebase connects and checks it against the architecture rules in a TOML
profile. Everything the 3D UI shows is available from the CLI as JSON. Exit codes are stable:
`0` ok · `1` check failed / nothing matched · `2` usage or setup error.

## Set it up in a repository

```sh
sprawler doctor --json                 # what is installed; every missing piece has a `fix` command
sprawler setup <DIR> --json            # dry run: what discovery found + the config it would write
sprawler check <DIR> --json            # first result
```

- Read `setup --json` → `analyzers[]`. For each `installed: false`, run its `install` command
  (`sprawler plugin add <name>`, from a Sprawler checkout or with `--from DIR`).
  Analyzers are per language: `roc`, `rust` (Graphify optional, for symbol counts:
  `uv tool install graphifyy`), `csharp` (needs the .NET SDK; run `dotnet restore` in the solution
  for full name resolution), `typescript` (native imports), `python` (heuristic package roots), and
  `go` (module/package imports).
- A repo with no profile still works: the installed plugins' defaults map it (for Rust, each crate
  is a context; for Roc, each package). That score is **structure only** — cycles, tangle, hubs.
  It says nothing about whether the code follows the team's design. For that, write a profile.
- Discovery also recognises a Clankernative workspace (`sdk/main.roc` declaring `platform "…"`)
  and `.csproj` projects, and builds a profile from the matching pack.
- Config lookup order: `--profile FILE` → `DIR/sprawler.toml` → personal workspace config →
  `DIR/sprawler.workspace.toml` → auto-discovery → plugin defaults.

## Map the architecture (with the developer)

Rules come from design decisions, and only the team knows them. Never invent policy.

1. **Learn the intended design.** Ask the developer which architecture they are aiming for, and
   read what the repo already says: ADRs, a `decisions/` or `docs/` folder, the README, `AGENTS.md`.
2. **Start a profile:** `sprawler profile init <DIR> --architecture ddd-hexagonal` (add
   `--add cqrs` and/or `--add vertical-slices` if they use those patterns). It writes a commented
   `sprawler.toml` with one `[[map]]` entry per folder; layers are guesses from folder names.
3. **Correct the map with the developer.** Each `[[map]]` entry says which files are which layer
   and bounded context. Put specific entries before broad ones (first match wins).
4. **Record their design decisions as `[[rules]]`**, each with a `why` in their words.
5. **Check it:** `sprawler profile validate <DIR> --json` (fix every error; treat warnings as
   bugs), then `sprawler profile explain <DIR>`. Any entry marked **fallback** places files that
   no specific entry claimed; confirm each of those files really belongs in that layer.
6. `sprawler check <DIR> --json` and walk the developer through the first findings.

Packs are TOML files a profile `extends` (a list, merged left to right):

| Pack | What it adds |
|---|---|
| `ddd-hexagonal` | Layers core, port, application, driving/driven adapters, root; dependencies point inward |
| `cqrs` | Command and query layers; reads never import writes |
| `vertical-slices` | Slices never import siblings; `shared` never knows its slices |
| `clankernative` | The Clankernative platform: tiers, SDK/host seams, operations view (extends the three above) |

`sprawler pack list` shows installed, built-in and available packs; `sprawler pack add <name|path>`
installs one (from a checkout of github.com/clankernative/sprawler-packs: `--from DIR` or
`SPRAWLER_PACKS_SOURCE`). A profile overrides anything from a pack: a rule with the same `id` replaces it.

## Read the results

| Command | Use it for |
|---|---|
| `sprawler check DIR --json` | Score, findings (rule, severity, `why`, file:line), and the FIX / IMPROVE / CHECK inbox |
| `sprawler report DIR --json` | Everything above plus per-context scores and contract seams |
| `sprawler profile explain DIR [--file F] --json` | Which `[[map]]` entry placed a file, its layer's allowed dependencies, rules and findings |
| `sprawler scan DIR -o atlas.json` | The full atlas (schema `sprawler.atlas/1`): modules, edges, history, views |
| `sprawler prompts DIR --rule R` / `--index N` | A self-contained fix prompt per finding |
| `sprawler serve DIR` | The 3D map for a human, at http://127.0.0.1:8766 |

Before trusting a score, read `score.confidence`, `score.withheld` and `score.policyCoverage`.
A high score with low coverage means the rules check little; `withheld: true` means the grade
is `?` because the analyzers could not see enough.

## Fix findings

First decide **whether the code is wrong or the map is wrong**:

1. `sprawler check DIR --json` → pick from `inbox` in order (`fix` before `improve` before `check`).
2. `sprawler profile explain DIR --file <each file in the finding>`. Is each file in the layer it
   should be? A file placed by a *fallback* entry is the usual suspect. Example: a use case
   "calls a driven adapter", but the target does no I/O — it is a calculation mapped as an adapter.
3. **Map wrong:** give the file a specific `[[map]]` entry, confirm with the developer, re-check.
4. **Code wrong:** `sprawler prompts DIR --index N` for the full prompt (what is wrong, where, the
   code, allowed dependencies, a direction, and a "done when"). Change the code; preserve
   behaviour. Never rename or move files just to change their classification.
5. If the dependency is correct by the team's design, say so and explain why. Exempting it
   (`severity = "ok"` on a rule, or loosening `[allow]`) is a policy change: ask the developer
   first, and write the reason in the rule's `why`.
6. Re-run `check`; the finding should be gone and nothing new should appear.

## Gate CI

```sh
sprawler check .                            # fail on major or critical findings (the default)
sprawler check . --fail-on minor            # stricter: fail on any finding
sprawler check . --fail-on none             # report only; never fail on findings
sprawler check . --min-score 80             # fail below a score (or when the grade is withheld)
```

Unhandled contract seams always fail `check`.

## Write an analyzer plugin

A plugin is an executable named `sprawler-analyzer-<name>` that answers `describe` and
`analyze` over JSON on stdin/stdout (`docs/PROTOCOL.md`, schema in `protocol/`). It reports facts
only — never policy. `describe` may publish `defaults`: a structure-only profile fragment used
when a repo has no profile (map entries can match on the facts the plugin reports, e.g.
`ctx = "@crate"`). Put it on `SPRAWLER_PLUGIN_PATH` or `PATH`, then:

```sh
sprawler plugin test ./sprawler-analyzer-mine --dir <a repo in that language>
sprawler plugin list
```

`plugin test` must pass: valid describe, well-formed modules and edges, identical output on two runs.

## Working on Sprawler itself

- Sprawler follows `ddd-hexagonal` (see `sprawler.toml`). `crates/sprawler-domain` is pure: no
  filesystem, processes, network or clock. The atlas use case (`atlas.rs`, `views.rs`, `seams.rs`,
  `prompts.rs`, `wip.rs`, `metrics.rs`) depends only on `ports.rs` and the domain; `local.rs` implements the port.
- `crates/sprawler-protocol` is the plugin contract. Plugins in `plugins/` depend only on it (and
  `plugins/analyzer-kit`).
- `sprawler check . --fail-on minor` on this repo must pass. Don't loosen a rule to pass it.
- `cargo test` and `cargo build` before committing.
