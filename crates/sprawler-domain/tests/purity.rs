//! The domain crate must stay pure: no filesystem, processes, network, environment or clock.
//! That is what keeps it testable and portable (e.g. to Roc).
#[test]
fn domain_does_no_io() {
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let banned = ["std::fs", "std::process", "std::net", "std::env", "std::time", "SystemTime", "Instant::", "std::io"];
    let mut hits = Vec::new();
    for e in std::fs::read_dir(&src).unwrap().flatten() {
        let text = std::fs::read_to_string(e.path()).unwrap();
        for (n, line) in text.lines().enumerate() {
            let code = line.split("//").next().unwrap_or("");
            for b in banned {
                if code.contains(b) {
                    hits.push(format!("{}:{}: {b}", e.path().display(), n + 1));
                }
            }
        }
    }
    assert!(hits.is_empty(), "I/O in the domain crate:\n{}", hits.join("\n"));
}
