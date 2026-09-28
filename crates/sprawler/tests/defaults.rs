//! A repo with no profile: the installed plugins' `defaults` map it (structure only).
use std::path::Path;
use std::process::Command;

use serde_json::Value;

#[test]
fn rust_workspace_without_a_profile_maps_crates_as_contexts() {
    let bin = Path::new(env!("CARGO_BIN_EXE_sprawler"));
    if !bin.parent().unwrap().join("sprawler-analyzer-rust").is_file() {
        eprintln!("skipped: sprawler-analyzer-rust not built (cargo build --workspace)");
        return;
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/rust-workspace");
    let dir = std::env::temp_dir().join(format!("sprawler-defaults-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let out = dir.join("atlas.json");
    let o = Command::new(bin)
        .args(["scan", root.to_str().unwrap(), "-o", out.to_str().unwrap()])
        .env("SPRAWLER_CONFIG_DIR", dir.join("cfg"))
        .env("SPRAWLER_GRAPHIFY", "/usr/bin/false") // native resolution only; no network
        .output()
        .unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    let a: Value = serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
    let place = |id: &str| {
        let m = a["modules"].as_array().unwrap().iter().find(|m| m["id"] == id).unwrap_or_else(|| panic!("no module {id}"));
        (m["ctx"].as_str().unwrap().to_string(), m["layer"].as_str().unwrap().to_string())
    };
    assert_eq!(place("app/src/main.rs"), ("code:shop-app".into(), "root".into()));
    assert_eq!(place("app/src/report.rs"), ("code:shop-app".into(), "code".into()));
    assert_eq!(place("app/tests/orders.rs"), ("code:shop-app".into(), "test".into()));
    assert_eq!(place("core/src/order.rs"), ("code:shop-core".into(), "code".into()));
    let linked = a["edges"].as_array().unwrap().iter().any(|e| e["source"] == "app/src/report.rs" && e["target"] == "core/src/order.rs");
    assert!(linked, "cross-crate link resolved");
}
