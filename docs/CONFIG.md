# Sprawler configuration reference

Sprawler separates **facts** from **policy**:

- Language analyzers produce facts: files, symbols, dependencies, and (for C#) each file's project,
  project kind and inferred role, with the evidence behind it.
- A TOML **profile** says what those facts mean for *your* architecture: how files group into tiers,
  contexts and layers, which dependencies are allowed, and why.

There are two ways to get a profile:

| | Where | Use when |
|---|---|---|
| **Workspace config** | `DIR/sprawler.workspace.toml` (shared) or `~/.config/sprawler/workspaces/…` (personal) | A Clankernative workspace or a .NET solution; says *where* things are and picks a rules file |
| **Full profile** | any `.toml`, passed with `--profile` | You want your own tiers, layers and rules; usually `extends` a built-in rules file |

Built-in rules files are compiled into `sprawler` (sources in `crates/sprawler/rules/`): `clankernative` (alias `day2`) and `dotnet`.

## Workspace config

Written by `sprawler setup --yes` (add `--shared` for `DIR/sprawler.workspace.toml`). Paths are relative to `root` (or the file's folder).

| Key | Meaning |
|---|---|
| `name`, `title` | Identifier and heading |
| `rules` | Rules file to apply: `clankernative` (default) or `dotnet` |
| `root` | Workspace folder (personal configs only) |
| `platform` | Clankernative platform folder (holds `sdk/` and `crates/`) |
| `apps` | App folders (each has an `App.roc`) |
| `instances` | `instance.json` files |
| `tests` | Acceptance-test crates |
| `label_strip_prefix` / `label_strip_suffix` | Trimmed from context labels, e.g. `["tool-"]`, `["Acme."]` |

## Full profile

### Top level

| Key | Default | Meaning |
|---|---|---|
| `extends` | — | Base rules file (`"dotnet"`, `"clankernative"`, or a path). See *Merging* below |
| `name`, `title` | file name | Identifier and heading |
| `root` | — | Folder to scan (`~` allowed) |
| `repos` | auto | Sibling git repos under `root`, for per-repo HEAD and merged history |
| `include` / `exclude` | `["**"]` / `[]` | Globs relative to `root`. `**`, `*`, `?` |
| `extensions` | `.roc .rs .py .ts` | File types to read. C# needs `.cs` |
| `[analyzers.<name>]` | — | `path = "…"` to use a specific plugin executable; `options = { … }` passed to that plugin unchanged (e.g. `[analyzers.rust.options] min_confidence = 0.8`, `[analyzers.roc.options] package_markers = […]`) |
| `context_label` | `BOUNDED CONTEXTS` | Heading for the context list, e.g. `PROJECTS` |
| `label_strip_prefix` / `_suffix` | `[]` | Trimmed from context labels |

### `[[tiers]]` — concentric rings, inside first

| Key | Meaning |
|---|---|
| `id`, `label`, `blurb`, `color` | Identity and display |
| `depends` | Tiers this tier may depend on. Anything else is a `tier-breach` (major) |
| `cross` | Between contexts of this tier: `allow`, `deny` (→ `context-bleed`, critical) or `declared` (only along declared dependencies, e.g. Cargo, else `undeclared-coupling`) |
| `published` | With `cross = "deny"`: layers other contexts may still use |
| `acyclic` | `false` skips context-cycle detection for this tier |

### `[layers.<id>]` — rings inside each context

| Key | Meaning |
|---|---|
| `label`, `color` | Display |
| `shape` | `icosa`, `dodeca`, `octa`, `tetra`, `box`, `cone`, `sphere` |
| `ring` | 0 = centre of the island, higher = further out |
| `side` | `north` / `south` / `east` / `west`: pins outer rings to one side |
| `test` | Files here are tests: hidden by default, never scored as production |
| `generated` | Files here are generated: excluded from tangle and hub checks |

### `[roles]` — C# role → layer

The C# analyzer gives every file one role: `endpoint`, `ui`, `worker`, `composition`, `persistence`,
`integration`, `service`, `entity`, `config`, `contract`, `abstraction`, `util`, `model`, `migration`,
`test`, or `code` (no recognisable signal). A role maps to the layer of the same name unless listed:

```toml
[roles]
code = "loose"          # unclassified C# → the "loose" layer
integration = "persistence"
```

### `[[map]]` — path → tier, context, layer (first match wins)

| Key | Meaning |
|---|---|
| `glob` | Path pattern. `{ctx}` and `{slice}` capture one path segment |
| `tier` | Tier id |
| `ctx` | Context name; defaults to the `{ctx}` capture |
| `layer` | Layer id |
| `layer_by_ctx` | Override the layer for specific contexts: `{ runtime = "internal" }` |
| `when` | Only match when analyzer facts agree (globs allowed): `{ kind = ["web","exe"] }`, `{ project = "*.Contracts" }` |

Values starting with `@` come from analyzer facts, so they only apply to languages that supply them
(C# today). Without facts, entries using `when` or `@…` never match, so Roc and Rust are unaffected.

| Value | Resolves to |
|---|---|
| `@project` | Owning `.csproj` name |
| `@kind` | `web`, `worker`, `exe`, `apphost`, `library`, `test`, `loose` |
| `@role` | The file's role, through `[roles]` |

```toml
[[map]]
glob = "src/**"
when = { project = "Acme.*.Contracts" }
tier = "shared"
ctx = "@project"
layer = "@role"
```

Unmatched files are `unmapped` and shown as fog.

### `[allow]` — layer → layers it may depend on

Inside one context, a dependency not in the list is a `layer-breach`. `"*"` allows anything.

```toml
[allow]
core = ["core", "kernel"]
command = ["command", "model", "core", "port"]
"*" = ["*"]
```

`[breach_severity]` sets the severity of a `layer-breach` per source layer (`default = "major"`).

### `[[rules]]` — named rules (first match wins)

Checked before tier/layer defaults. Every condition is optional; omitted means "any".

| Key | Meaning |
|---|---|
| `id` | Rule name (shown in the inbox and in `check`) |
| `from_tier`, `to_tier`, `from_layer`, `to_layer` | One id or a list |
| `from_ctx`, `to_ctx` | Context names; globs allowed (`"*.Contracts"`) |
| `same_ctx`, `same_slice` | `true` / `false` |
| `severity` | `critical`, `major`, `minor`, or `ok` (exempts the edge from later rules) |
| `message` | One-line description of the problem |
| `why` | The reason the rule exists; shown with every finding and included in agent fix prompts |

Write `why` for every rule. It is what turns a finding into something a person or agent can act on.

### `[[seams]]` — contract boundaries that are data, not imports

Pairs strings one side emits with the arms the other side handles (e.g. Roc `kind: "…"` records
decoded by a Rust `match`). Mismatches become findings; seams never change the score.

| Key | Meaning |
|---|---|
| `id`, `label`, `note` | Identity |
| `emit` | `[{ glob, pattern }]`: regex with one capture group, the emitted kind |
| `handle` | `[{ file, block, contains?, pattern }]`: `block` locates the handler, `pattern` captures handled kinds (`"a" \| "b"` alternatives allowed) |

### `[scoring]`

| Key | Default | Meaning |
|---|---|---|
| `mode` | `auto` | `policy` (team rules), `structure` (cycles, tangle, hubs only), `combined` (the worse of the two). `auto` = `policy` when rules check ≥ 5% of links, else `structure` |
| `label` | by mode | Score heading, e.g. `ARCHITECTURE HEALTH` |
| `min_confidence` | `0.6` | Below this confidence the grade is withheld (`?`) |
| `boundary` | `false` | Also score each context→context pair once by its worst finding, so thousands of clean in-context links cannot hide coupling across many boundaries |

## Merging (`extends`)

When a profile extends a base:

- Plain keys in the profile replace the base.
- `layers`, `roles`, `allow`, `breach_severity`, `scoring`, `roc` merge key by key.
- `map` entries from the profile come **first** (more specific wins).
- `rules` with the same `id` replace the base rule in place (e.g. set `severity = "ok"` to turn one
  off); new rules are appended.
- `tiers`, if given, replace the base tiers entirely.

## What the score means

The atlas JSON (`sprawler scan`, schema `sprawler.atlas/1`) carries, under `score`:

- `total`, `grade`, `label`, `mode`
- `confidence`: how much of the dependency picture is trusted (dropped or unresolved links, unmapped
  or unclassified files, C# name resolution)
- `withheld`: `true` when confidence is below `scoring.min_confidence`
- `policyCoverage`: share of links at least one rule checks; the rest pass only because nothing forbids them
- `structure`: score from cycles, tangle and hubs alone
- `boundary`: context pairs, and how many break a rule
- `evidence.csharp`: names resolved, unrestored projects, unclassified files

A high score with low coverage or low confidence is not a clean bill of health; the UI and
`sprawler check` show both.
