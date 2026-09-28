mod atlas;
mod cli;
mod discover;
mod history;
mod local;
mod plugins;
mod ports;
mod profile;
mod prompts;
mod scan;
mod seams;
mod serve;
mod views;
mod walk;

fn main() -> std::process::ExitCode {
    cli::run()
}
