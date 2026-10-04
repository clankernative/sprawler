mod atlas;
mod cli;
mod demo;
mod discover;
mod events;
mod history;
mod local;
mod metrics;
mod plugins;
mod ports;
mod profile;
mod prompts;
mod scan;
mod seams;
mod serve;
mod views;
mod walk;
mod wip;

fn main() -> std::process::ExitCode {
    cli::run()
}
