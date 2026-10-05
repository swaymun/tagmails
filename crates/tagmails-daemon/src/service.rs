// Background service management: a launchd agent on macOS and a systemd user
// unit on Linux. Other Unix systems can run `tagmails run` under their own
// supervisor.

use crate::paths;
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const LABEL: &str = "com.tagmails.daemon";
const UNIT: &str = "tagmails.service";

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn service_path() -> String {
    // launchd and systemd start with a minimal PATH. Keep the caller's PATH so
    // the service finds the same node, codex and claude binaries.
    std::env::var("PATH").unwrap_or_else(|_| "/usr/local/bin:/usr/bin:/bin".into())
}

fn quiet(command: &mut Command) -> Result<std::process::Output, Box<dyn Error>> {
    Ok(command.output()?)
}

fn uid() -> Result<String, Box<dyn Error>> {
    let output = Command::new("id").arg("-u").output()?;
    let uid = String::from_utf8(output.stdout)?.trim().to_owned();
    if uid.is_empty() || !uid.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("Could not read the current user ID".into());
    }
    Ok(uid)
}

fn write_private(path: &Path, contents: &str) -> Result<(), Box<dyn Error>> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, contents)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

pub fn launchd_plist(binary: &Path, logs: &Path, path_env: &str) -> String {
    let home = paths::home();
    let string = |value: &str| format!("<string>{}</string>", escape_xml(value));
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key>{label}
  <key>ProgramArguments</key><array>{binary}{run}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>WorkingDirectory</key>{home}
  <key>EnvironmentVariables</key><dict>
    <key>HOME</key>{home}
    <key>PATH</key>{path}
  </dict>
  <key>StandardOutPath</key>{stdout}
  <key>StandardErrorPath</key>{stderr}
</dict></plist>
"#,
        label = string(LABEL),
        binary = string(&binary.display().to_string()),
        run = string("run"),
        home = string(&home.display().to_string()),
        path = string(path_env),
        stdout = string(&logs.join("tagmails.log").display().to_string()),
        stderr = string(&logs.join("tagmails.error.log").display().to_string()),
    )
}

pub fn systemd_unit(binary: &Path, path_env: &str) -> String {
    // systemd unit values are not shell-parsed; quote the binary path for spaces.
    format!(
        "[Unit]\nDescription=TagMails email agent\nAfter=network-online.target\nWants=network-online.target\n\n\
[Service]\nExecStart=\"{}\" run\nRestart=always\nRestartSec=10\nEnvironment=\"PATH={}\"\n\n\
[Install]\nWantedBy=default.target\n",
        binary.display(),
        path_env.replace('"', ""),
    )
}

fn launchd_file() -> PathBuf {
    paths::home().join(format!("Library/LaunchAgents/{LABEL}.plist"))
}

fn systemd_file() -> PathBuf {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| paths::home().join(".config"));
    base.join("systemd/user").join(UNIT)
}

fn has_systemd() -> bool {
    Command::new("systemctl")
        .args(["--user", "--version"])
        .output()
        .is_ok_and(|output| output.status.success())
}

/// Install (or replace) the background service and start it.
pub fn start(binary: &Path) -> Result<String, Box<dyn Error>> {
    let path_env = service_path();
    if cfg!(target_os = "macos") {
        let logs = paths::log_dir();
        fs::create_dir_all(&logs)?;
        let file = launchd_file();
        let domain = format!("gui/{}", uid()?);
        // Replacing our own agent is safe: it only reloads the same label.
        let _ = quiet(Command::new("launchctl").args(["bootout", &format!("{domain}/{LABEL}")]));
        write_private(&file, &launchd_plist(binary, &logs, &path_env))?;
        let output = quiet(Command::new("launchctl").args(["bootstrap", &domain]).arg(&file))?;
        if !output.status.success() {
            return Err(format!(
                "launchd did not start TagMails: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )
            .into());
        }
        return Ok(format!("Started launchd agent {LABEL}. Logs: {}", logs.display()));
    }
    if has_systemd() {
        write_private(&systemd_file(), &systemd_unit(binary, &path_env))?;
        quiet(Command::new("systemctl").args(["--user", "daemon-reload"]))?;
        let output = quiet(Command::new("systemctl").args(["--user", "enable", "--now", UNIT]))?;
        if !output.status.success() {
            return Err(format!(
                "systemd did not start TagMails: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )
            .into());
        }
        let _ = quiet(Command::new("systemctl").args(["--user", "restart", UNIT]));
        return Ok(format!(
            "Started systemd user service {UNIT}. Logs: journalctl --user -u tagmails -f\n\
To keep it running after you log out: loginctl enable-linger \"$USER\""
        ));
    }
    Err("No supported service manager found. Run `tagmails run` under your own supervisor (for example tmux or your init system).".into())
}

pub fn stop() -> Result<String, Box<dyn Error>> {
    if cfg!(target_os = "macos") {
        let domain = format!("gui/{}", uid()?);
        let _ = quiet(Command::new("launchctl").args(["bootout", &format!("{domain}/{LABEL}")]));
        return Ok("Stopped TagMails. It will not start at login until `tagmails start`.".into());
    }
    if has_systemd() {
        quiet(Command::new("systemctl").args(["--user", "disable", "--now", UNIT]))?;
        return Ok("Stopped TagMails.".into());
    }
    Err("No supported service manager found.".into())
}

pub fn uninstall() -> Result<String, Box<dyn Error>> {
    let message = stop().unwrap_or_default();
    for file in [launchd_file(), systemd_file()] {
        if file.exists() {
            fs::remove_file(&file)?;
        }
    }
    if has_systemd() {
        let _ = quiet(Command::new("systemctl").args(["--user", "daemon-reload"]));
    }
    Ok(format!("{message}\nRemoved the TagMails service file.").trim().to_owned())
}

/// A one-line description of the service state.
pub fn status() -> String {
    if cfg!(target_os = "macos") {
        let Ok(uid) = uid() else { return "unknown".into() };
        let Ok(output) = Command::new("launchctl")
            .args(["print", &format!("gui/{uid}/{LABEL}")])
            .output()
        else {
            return "unknown".into();
        };
        if !output.status.success() {
            return if launchd_file().exists() { "stopped".into() } else { "not installed".into() };
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let pid = text
            .lines()
            .find_map(|line| line.trim().strip_prefix("pid = "))
            .map(str::to_owned);
        return match pid {
            Some(pid) => format!("running (pid {pid})"),
            None => "loaded, not running".into(),
        };
    }
    if has_systemd() {
        let state = Command::new("systemctl")
            .args(["--user", "is-active", UNIT])
            .output()
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
            .unwrap_or_else(|_| "unknown".into());
        return if state == "inactive" && !systemd_file().exists() {
            "not installed".into()
        } else {
            state
        };
    }
    "no service manager".into()
}

pub fn log_hint() -> String {
    if cfg!(target_os = "macos") {
        format!("tail -f \"{}\"", paths::log_dir().join("tagmails.log").display())
    } else {
        "journalctl --user -u tagmails -f".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launchd_plist_runs_the_binary_and_escapes_paths() {
        let plist = launchd_plist(
            Path::new("/opt/homebrew/bin/tagmails"),
            Path::new("/Users/a&b/Library/Logs/TagMails"),
            "/opt/homebrew/bin:/usr/bin",
        );
        assert!(plist.contains("<string>/opt/homebrew/bin/tagmails</string><string>run</string>"));
        assert!(plist.contains("/Users/a&amp;b/Library/Logs/TagMails/tagmails.log"));
        assert!(!plist.contains("TAGMAILS_DEVICE_TOKEN"));
    }

    #[test]
    fn systemd_unit_quotes_the_binary() {
        let unit = systemd_unit(Path::new("/home/me/my apps/tagmails"), "/usr/bin:/bin");
        assert!(unit.contains("ExecStart=\"/home/me/my apps/tagmails\" run"));
        assert!(unit.contains("Environment=\"PATH=/usr/bin:/bin\""));
        assert!(unit.contains("WantedBy=default.target"));
    }
}
