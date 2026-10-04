//! `sprawler.analyzer/1`: the JSON contract between Sprawler and analyzer plugins.
pub const PROTOCOL: &str = "sprawler.analyzer/1";

/// Keys of the optional `modules[].metrics` object: per-file code-health facts (see docs/PROTOCOL.md).
/// The core keeps these and drops anything else an analyzer puts there.
pub const METRICS: [&str; 11] = ["cc", "ccMax", "ccFn", "ccLine", "fnMax", "fnName", "fnLine", "fns", "nest", "todo", "comments"];
