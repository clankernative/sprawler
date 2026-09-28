// Record the target triple, so `sprawler plugin add` can download the matching release archive.
fn main() {
    println!("cargo:rustc-env=SPRAWLER_TARGET={}", std::env::var("TARGET").unwrap_or_default());
    println!("cargo:rerun-if-changed=build.rs");
}
