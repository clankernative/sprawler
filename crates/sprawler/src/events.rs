//! Event log (driven adapter): the town events of a `sprawler serve` session (`sprawler_domain::events`),
//! stamped with an increasing `id` and a time `t`, the newest [`CAP`] kept, persisted as JSON lines.
use std::collections::HashSet;
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};

/// How many events the log keeps (in memory and on disk).
pub const CAP: usize = 1000;

pub struct EventLog {
    path: Option<PathBuf>,
    cap: usize,
    events: Vec<Value>,
    /// The id of the newest event ever logged (ids keep increasing after trimming).
    pub last: u64,
}

impl EventLog {
    /// A log persisted at `path` (loaded when it exists), or in memory only.
    pub fn open(path: Option<PathBuf>, cap: usize) -> EventLog {
        let mut events: Vec<Value> = Vec::new();
        if let Some(text) = path.as_ref().and_then(|p| std::fs::read(p).ok()) {
            events = String::from_utf8_lossy(&text).lines().filter_map(|l| serde_json::from_str(l).ok()).filter(Value::is_object).collect();
        }
        if events.len() > cap {
            events.drain(..events.len() - cap);
        }
        let last = events.iter().filter_map(|e| e["id"].as_u64()).max().unwrap_or(0);
        EventLog { path, cap, events, last }
    }

    /// `(time of the newest logged event, commit shas already logged)`: where a restarted server
    /// picks up, so commits made while it was down are reported once.
    pub fn resume_point(&self) -> (Option<i64>, HashSet<String>) {
        let t = self.events.last().and_then(|e| e["t"].as_i64());
        let mut shas = HashSet::new();
        for e in self.events.iter().filter(|e| e["kind"] == "commit") {
            for c in std::iter::once(e).chain(e["sample"].as_array().into_iter().flatten()) {
                if let Some(s) = c["sha"].as_str() {
                    shas.insert(s.to_string());
                }
            }
        }
        (t, shas)
    }

    /// Stamp and append events (at time `t`, default now); returns them as stored.
    pub fn append(&mut self, events: Vec<Value>, t: Option<i64>) -> Vec<Value> {
        if events.is_empty() {
            return Vec::new();
        }
        let t = t.unwrap_or_else(|| SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64));
        let stamped: Vec<Value> = events
            .into_iter()
            .map(|e| {
                self.last += 1;
                let mut m = Map::new();
                m.insert("id".into(), json!(self.last));
                m.insert("t".into(), json!(t));
                if let Value::Object(o) = e {
                    m.extend(o);
                }
                Value::Object(m)
            })
            .collect();
        self.events.extend(stamped.iter().cloned());
        let trim = self.events.len() > self.cap;
        if trim {
            self.events.drain(..self.events.len() - self.cap);
        }
        if let Some(path) = &self.path {
            // events must never break a scan: a write that fails is skipped
            let _ = Self::persist(path, if trim { &self.events } else { &stamped }, trim);
        }
        stamped
    }

    fn persist(path: &PathBuf, events: &[Value], rewrite: bool) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let body: String = events.iter().map(|e| format!("{e}\n")).collect();
        if rewrite {
            let tmp = path.with_extension("jsonl.tmp");
            std::fs::write(&tmp, body)?;
            std::fs::rename(&tmp, path)
        } else {
            std::fs::OpenOptions::new().create(true).append(true).open(path)?.write_all(body.as_bytes())
        }
    }

    /// `{"events": [...], "last": id}`: events newer than `since`, only the newest `limit` if given.
    pub fn since(&self, since: u64, limit: Option<usize>) -> Value {
        let mut ev: Vec<&Value> = self.events.iter().filter(|e| e["id"].as_u64().unwrap_or(0) > since).collect();
        if let Some(n) = limit.filter(|n| *n > 0) {
            if ev.len() > n {
                ev.drain(..ev.len() - n);
            }
        }
        json!({"events": ev, "last": self.last})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persist_cap_and_since() {
        let dir = std::env::temp_dir().join(format!("sprawler-events-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let p = dir.join("events.jsonl");
        let mut log = EventLog::open(Some(p.clone()), 5);
        log.append((0..4).map(|i| json!({"kind": "k", "sev": "info", "n": i})).collect(), Some(1));
        log.append((4..7).map(|i| json!({"kind": "k", "sev": "info", "n": i})).collect(), Some(2));
        assert_eq!(log.events.iter().map(|e| e["id"].as_u64().unwrap()).collect::<Vec<_>>(), [3, 4, 5, 6, 7]);
        let mut again = EventLog::open(Some(p.clone()), 5);
        assert_eq!(again.last, 7);
        let ids = |v: &Value| v["events"].as_array().unwrap().iter().map(|e| e["id"].as_u64().unwrap()).collect::<Vec<_>>();
        assert_eq!(ids(&again.since(5, None)), [6, 7]);
        assert_eq!(ids(&again.since(0, Some(2))), [6, 7]);
        again.append(vec![json!({"kind": "commit", "sev": "info", "sha": "abc"})], None);
        let s = again.since(7, None);
        assert_eq!((ids(&s), s["last"].as_u64()), (vec![8], Some(8)));
        assert_eq!(s["events"][0]["kind"], "commit");
        let (t, shas) = again.resume_point();
        assert_eq!(t, again.events.last().unwrap()["t"].as_i64());
        assert!(shas.contains("abc"));
        // appended without a rewrite: a third open sees all of it
        assert_eq!(EventLog::open(Some(p), 5).last, 8);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
