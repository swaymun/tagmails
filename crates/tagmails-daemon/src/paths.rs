// Where TagMails keeps its files on a Unix machine.
//
// macOS and Linux share the config location so an existing pilot token at
// ~/.config/tagmails/device-token keeps working. Data and logs follow each
// platform's convention.

use std::env;
use std::path::{Path, PathBuf};

pub fn home() -> PathBuf {
    env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .expect("HOME must be an absolute path")
}

fn xdg(name: &str, fallback: &str) -> PathBuf {
    env::var_os(name)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| home().join(fallback))
}

pub fn config_dir() -> PathBuf {
    if let Some(dir) = env::var_os("TAGMAILS_CONFIG_DIR") {
        return PathBuf::from(dir);
    }
    xdg("XDG_CONFIG_HOME", ".config").join("tagmails")
}

pub fn data_dir() -> PathBuf {
    if let Some(dir) = env::var_os("TAGMAILS_DATA_DIR") {
        return PathBuf::from(dir);
    }
    if cfg!(target_os = "macos") {
        home().join("Library/Application Support/TagMails")
    } else {
        xdg("XDG_DATA_HOME", ".local/share").join("tagmails")
    }
}

pub fn log_dir() -> PathBuf {
    if cfg!(target_os = "macos") {
        home().join("Library/Logs/TagMails")
    } else {
        xdg("XDG_STATE_HOME", ".local/state").join("tagmails")
    }
}

pub fn config_file() -> PathBuf {
    config_dir().join("config.json")
}

pub fn token_file() -> PathBuf {
    config_dir().join("device-token")
}

pub fn projects_file() -> PathBuf {
    data_dir().join("projects.json")
}

pub fn scratch_dir() -> PathBuf {
    data_dir().join("scratch")
}

fn has_adapters(dir: &Path) -> bool {
    dir.join("codex-runner.mjs").is_file()
}

/// The Node adapters ship beside the binary: `<prefix>/bin/tagmails` and
/// `<prefix>/libexec/tagmails/*.mjs` (Homebrew and install.sh), or inside a
/// source checkout at `target/<profile>/tagmails` and `agent/`.
pub fn adapters_dir() -> Result<PathBuf, String> {
    if let Some(dir) = env::var_os("TAGMAILS_ADAPTERS_DIR").map(PathBuf::from) {
        return if has_adapters(&dir) {
            Ok(dir)
        } else {
            Err(format!("TAGMAILS_ADAPTERS_DIR has no adapters: {}", dir.display()))
        };
    }
    let exe = env::current_exe()
        .and_then(|path| path.canonicalize())
        .map_err(|error| format!("Could not locate the tagmails binary: {error}"))?;
    let bin = exe.parent().ok_or("tagmails binary has no parent folder")?;
    let candidates = [
        bin.parent().map(|prefix| prefix.join("libexec/tagmails")),
        bin.parent()
            .and_then(Path::parent)
            .map(|root| root.join("agent")),
    ];
    candidates
        .into_iter()
        .flatten()
        .find(|dir| has_adapters(dir))
        .ok_or_else(|| {
            "Agent adapters are missing. Reinstall TagMails, or set TAGMAILS_ADAPTERS_DIR.".into()
        })
}
