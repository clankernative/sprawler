//! End-to-end: run the real `sprawler` binary. Each test skips (with a note) when the analyzer
//! plugin or toolchain it needs is not installed.
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap()
}

fn on_path(tool: &str) -> bool {
    std::env::var_os("PATH").is_some_and(|p| std::env::split_paths(&p).any(|d| d.join(tool).is_file()))
}

/// The C# plugin: SPRAWLER_PLUGIN_PATH, else the usual local build location.
fn csharp_plugin_dir() -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("SPRAWLER_PLUGIN_PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    if let Some(h) = std::env::var_os("HOME") {
        dirs.push(PathBuf::from(h).join(".cache/sprawler/plugins/csharp/bin"));
    }
    dirs.into_iter().find(|d| d.join("sprawler-analyzer-csharp").is_file())
}

fn sprawler(args: &[&str], plugin_path: Option<&Path>) -> (i32, Value, String) {
    let mut c = Command::new(env!("CARGO_BIN_EXE_sprawler"));
    c.args(args).env("SPRAWLER_CONFIG_DIR", std::env::temp_dir().join("sprawler-cli-test-config"));
    if let Some(p) = plugin_path {
        c.env("SPRAWLER_PLUGIN_PATH", p);
    }
    let o = c.output().unwrap();
    let json = serde_json::from_slice(&o.stdout).unwrap_or(Value::Null);
    (o.status.code().unwrap_or(-1), json, String::from_utf8_lossy(&o.stderr).into_owned())
}

#[test]
fn csharp_fixture_roles_links_and_findings() {
    let Some(plugins) = csharp_plugin_dir() else {
        eprintln!("skipped: sprawler-analyzer-csharp not built (see plugins/analyzer-csharp)");
        return;
    };
    if !on_path("dotnet") {
        eprintln!("skipped: dotnet not installed");
        return;
    }
    let fixture = repo().join("tests/fixtures/csharp-layered");
    let dir = std::env::temp_dir().join(format!("sprawler-cli-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let prof = dir.join("fixture.toml");
    std::fs::write(&prof, format!("extends = \"dotnet\"\nname = \"fixture\"\nroot = \"{}\"\n", fixture.display())).unwrap();
    let out = dir.join("atlas.json");
    let (code, _, err) = sprawler(&["scan", "--profile", prof.to_str().unwrap(), "-o", out.to_str().unwrap()], Some(&plugins));
    assert_eq!(code, 0, "{err}");
    let a: Value = serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
    let role = |id: &str| a["modules"].as_array().unwrap().iter().find(|m| m["id"] == id).map(|m| m["role"].clone());
    for (f, r) in [
        ("Api/Controllers/OrdersController.cs", "endpoint"),
        ("Api/Program.cs", "composition"),
        ("Core/OrderService.cs", "service"),
        ("Core/IOrderRepository.cs", "abstraction"),
        ("Core/CreateOrderRequest.cs", "contract"),
        ("Core/Order.cs", "entity"), // found via DbSet<Order> in another project
        ("Infra/ShopDb.cs", "persistence"),
        ("Infra/OrderRepository.cs", "persistence"),
    ] {
        assert_eq!(role(f), Some(Value::from(r)), "{f}");
    }
    let edges: Vec<(String, String)> =
        a["edges"].as_array().unwrap().iter().map(|e| (e["source"].as_str().unwrap().into(), e["target"].as_str().unwrap().into())).collect();
    for pair in [("Api/Controllers/OrdersController.cs", "Core/OrderService.cs"), ("Api/Api.csproj", "Core/Core.csproj")] {
        assert!(edges.contains(&(pair.0.into(), pair.1.into())), "missing link {pair:?}");
    }
    let rules: Vec<(&str, &str)> = a["violations"].as_array().unwrap().iter().map(|v| (v["rule"].as_str().unwrap(), v["source"].as_str().unwrap())).collect();
    assert!(rules.contains(&("endpoint-to-db", "Api/Controllers/OrdersController.cs")));
    assert!(rules.contains(&("inner-knows-edge", "Api/OrderView.cs")));
    assert!(a["violations"].as_array().unwrap().iter().all(|v| v["why"].is_string()), "every finding explains itself");
    assert_eq!(a["score"]["label"], "ARCHITECTURE HEALTH");
    assert!(a["score"]["evidence"]["csharp"]["resolution"].as_f64().unwrap() > 0.9);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn sprawler_passes_its_own_check() {
    let bin = Path::new(env!("CARGO_BIN_EXE_sprawler")).parent().unwrap().join("sprawler-analyzer-rust");
    if !bin.is_file() || !on_path("graphify") {
        eprintln!("skipped: needs `cargo build` (for sprawler-analyzer-rust) and graphify on PATH");
        return;
    }
    let (code, j, err) = sprawler(&["check", repo().to_str().unwrap(), "--fail-on", "minor", "--json"], None);
    assert_eq!(code, 0, "self-check failed: {j:#}\n{err}");
    assert_eq!(j["ok"], true);
}

#[test]
fn no_config_is_a_setup_error() {
    let empty = std::env::temp_dir().join(format!("sprawler-empty-{}", std::process::id()));
    std::fs::create_dir_all(&empty).unwrap();
    let (code, _, err) = sprawler(&["check", empty.to_str().unwrap()], None);
    assert_eq!(code, 2);
    assert!(err.contains("nothing to map"), "{err}");
    let _ = std::fs::remove_dir_all(&empty);
}

fn analyzer_fixture(name: &str, fixture: &str, expected: &[(&str, &str)]) {
    let bin = Path::new(env!("CARGO_BIN_EXE_sprawler")).parent().unwrap().join(format!("sprawler-analyzer-{name}"));
    if !bin.is_file() {
        eprintln!("skipped: sprawler-analyzer-{name} not built");
        return;
    }
    let root = repo().join("tests/fixtures").join(fixture).canonicalize().unwrap();
    let mut files = Vec::new();
    fn collect(dir: &Path, root: &Path, out: &mut Vec<String>) {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect(&path, root, out);
            } else {
                out.push(path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/"));
            }
        }
    }
    collect(&root, &root, &mut files);
    files.sort();
    let request = serde_json::json!({"protocol":"sprawler.analyzer/1","root":root,"files":files,"options":{},"tests":[]});
    let output = Command::new(bin).arg("analyze").stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).spawn().unwrap();
    let mut child = output;
    serde_json::to_writer(child.stdin.as_mut().unwrap(), &request).unwrap();
    drop(child.stdin.take());
    let result = child.wait_with_output().unwrap();
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    let value: Value = serde_json::from_slice(&result.stdout).unwrap();
    let edges: Vec<(String, String)> =
        value["edges"].as_array().unwrap().iter().map(|e| (e["source"].as_str().unwrap().into(), e["target"].as_str().unwrap().into())).collect();
    for (source, target) in expected {
        assert!(edges.contains(&(source.to_string(), target.to_string())), "{name}: missing {source} -> {target}; got {edges:?}");
    }
}

#[test]
fn typescript_fixture_has_native_import_edges() {
    analyzer_fixture("typescript", "ts-layered", &[("src/api/handler.ts", "src/core/model.ts"), ("src/infra/store.ts", "src/core/model.ts")]);
}

#[test]
fn python_fixture_has_package_and_relative_edges() {
    analyzer_fixture("python", "python-layered", &[("src/shop/api.py", "src/shop/core.py"), ("src/shop/infra.py", "src/shop/core.py")]);
}

#[test]
fn go_fixture_has_identifier_resolved_package_edges() {
    analyzer_fixture("go", "go-layered", &[("cmd/server/main.go", "internal/infra/store.go"), ("internal/infra/store.go", "internal/core/model.go")]);
}
