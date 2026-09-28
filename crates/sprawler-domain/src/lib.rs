//! Sprawler's domain core.
//!
//! Pure and deterministic: facts + policy in, findings + scores out. This crate must never touch
//! the filesystem, the network, processes or the clock — those live in adapter crates. That keeps
//! the core easy to test, and portable (e.g. to Roc) without redesign.

pub mod classify;
pub mod glob;
pub mod inbox;
pub mod judge;
