# Sprawler analyzer protocol — `sprawler.analyzer/1`

An **analyzer** turns source files into **facts**: modules, symbols, and dependencies with evidence.
It never decides what is good or bad architecture — that is the profile's job (see CONFIG.md).

Analyzers are separate executables, so they can be written in any language. First-party analyzers
live in `plugins/` in this repo; community analyzers use exactly the same contract.

## Discovery

Sprawler looks for executables named `sprawler-analyzer-<name>`:

1. paths listed in the profile: `[analyzers] csharp = "/path/to/sprawler-analyzer-csharp"`
2. `~/.local/share/sprawler/plugins/bin/` (where `sprawler plugin add` installs)
3. `PATH`

`sprawler plugin list --json` shows what was found and what each one claims.

## Commands

Every command writes one JSON document to stdout and exits 0. Human-readable diagnostics go to
stderr. A non-zero exit means the analyzer failed; Sprawler reports it and continues without it.

### `describe`

```sh
sprawler-analyzer-csharp describe
```

```json
{
  "protocol": "sprawler.analyzer/1",
  "name": "csharp",
  "version": "0.1.0",
  "languages": ["csharp"],
  "claims": { "extensions": [".cs"], "files": ["*.csproj"] },
  "precision": "semantic",
  "facts": ["project", "kind", "role"],
  "requires": [
    { "tool": "dotnet", "check": ["dotnet", "--version"], "install": "https://dotnet.microsoft.com/download" }
  ]
}
```

| Field | Meaning |
|---|---|
| `claims` | Files this analyzer wants. Globs match the file name; `extensions` match the suffix |
| `precision` | `semantic` (compiler-accurate) or `syntactic` (parsed, name-matched). When two analyzers claim the same file, `semantic` wins |
| `facts` | Keys it sets on `modules[].facts`, usable in profiles as `when = { … }` and `"@key"` |
| `requires` | External tools. `sprawler doctor` runs `check` and prints `install` when it fails |

### `analyze`

Request on stdin:

```json
{
  "protocol": "sprawler.analyzer/1",
  "root": "/abs/path/to/workspace",
  "files": ["src/Api/OrdersController.cs", "src/Api/Api.csproj"],
  "options": {},
  "tests": ["src/Api.Tests/OrdersTests.cs"],
  "cache_dir": "/abs/path/for/this/analyzer"
}
```

`files` are relative to `root` and already filtered by the profile's include/exclude. `options` is
the profile table `[analyzers.<name>.options]`, passed through unchanged. `tests` (optional) lists
the files the profile classifies as tests, so an analyzer that matches names can avoid linking
production code to test-only symbols.

Response on stdout:

```json
{
  "protocol": "sprawler.analyzer/1",
  "modules": [
    {
      "id": "src/Api/OrdersController.cs",
      "path": "src/Api/OrdersController.cs",
      "lang": "cs",
      "symbols": { "types": 1, "functions": 0, "methods": 2 },
      "sample": [["type", "OrdersController", 10]],
      "facts": { "project": "Api", "kind": "web", "role": "endpoint" },
      "evidence": ["derives from ControllerBase"],
      "generated": false,
      "resolution": [812, 3],
      "metrics": { "cc": 14, "ccMax": 6, "ccFn": "Create", "ccLine": 31, "fnMax": 24, "fnName": "Create",
                   "fnLine": 31, "fns": 3, "nest": 4, "todo": 0, "comments": 0.08 }
    }
  ],
  "edges": [
    { "source": "src/Api/OrdersController.cs", "target": "src/Core/OrderService.cs",
      "relations": ["calls", "uses"], "weight": 4, "line": 12 }
  ],
  "declared": [["src/Api/Api.csproj", "src/Core/Core.csproj"]],
  "unknown": { "unresolved": 3, "dropped": 0, "phantoms": [] },
  "externals": [["Microsoft.AspNetCore.Mvc", 14]],
  "stats": { "resolved": 812, "unresolved": 3 },
  "warnings": ["2 project(s) are not restored; run dotnet restore"]
}
```

| Field | Meaning |
|---|---|
| `modules[].id` | Stable id. Normally the relative path; virtual modules (no file) use any unique string |
| `modules[].path` | Relative path, or `null` for a virtual module |
| `modules[].virtual` | `true` for modules with no file (e.g. generated handles). Placed with `anchor` |
| `modules[].anchor` | For virtual modules: the module whose tier/context it belongs to |
| `modules[].facts` | Values the profile may classify on. Never tiers or layers directly |
| `modules[].evidence` | Short, human-readable reasons for the facts (shown in the UI) |
| `modules[].resolution` | `[resolved, unresolved]` name lookups in this file, when the analyzer can tell |
| `modules[].metrics` | Optional code-health facts for the file (below). Informational only: never part of the score |
| `edges[]` | Module → module dependencies. `line` is the first occurrence in `source` |
| `declared` | Dependencies declared by a build system (Cargo, `ProjectReference`), as module-id pairs |
| `unknown` | What the analyzer could not see. Lowers confidence; never silently dropped |
| `resolution` | Optional, for semantic analyzers: `{lang, resolved, unresolved, unrestored, projects, failed}` name lookups. Scales confidence by that language's share of files; reported under `score.evidence.<name>`. Don't also count these in `unknown` |
| `warnings` | Shown in `report`, `check` and the UI |

### `modules[].metrics`

Optional, per file. Language-specific measurement belongs in the analyzer; the core adds git churn,
authors and age, and judges smells against limits from the profile (`[smells]`, see CONFIG.md).

| Key | Meaning |
|---|---|
| `cc` | Approximate cyclomatic complexity of the whole file: 1 + decision points (`if`, loops, match arms, `case`, `catch`, `&&`, `\|\|`, …) |
| `ccMax`, `ccFn`, `ccLine` | The most complex function: its complexity, name and first line (`ccMax` = `cc` when there are no functions) |
| `fnMax`, `fnName`, `fnLine` | The longest function: its length in lines, name and first line |
| `fns` | Number of functions |
| `nest` | Deepest indentation, in indent units (a tab or four spaces) |
| `todo` | `TODO` / `FIXME` / `HACK` / `XXX` markers |
| `comments` | Share of lines that are comments, 0..1 |

Function boundaries should be real ones (brace matching, or indentation for Roc and Python), and
keywords inside strings and comments must not count. Rust's `?` is not a branch; Roc's `->` is a type
arrow. Rust plugins can use `sprawler_analyzer_kit::metrics::file_metrics(text, lang)`. Unknown keys are dropped.

Only include files you actually analyzed. A file you claim but cannot parse should appear in
`warnings`, not be dropped silently.

## Rules for analyzer authors

- **Facts, not policy.** Report "derives from ControllerBase", not "violates layering".
- **Deterministic.** Same files in, same JSON out (sort your arrays).
- **Honest about gaps.** Count what you couldn't resolve in `unknown`; confidence depends on it.
- **Read-only.** Never write into `root`. Use `cache_dir` for anything you need to keep.

## Conformance

```sh
sprawler plugin test ./sprawler-analyzer-mine
```

checks `describe`, validates `analyze` output against `protocol/analyzer-v1.schema.json`, and runs
the analyzer twice to confirm the output is deterministic.
