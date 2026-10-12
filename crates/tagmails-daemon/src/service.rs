// Background service management: a launchd agent on macOS and a systemd user
// unit on Linux. Without a systemd user session (containers), `tagmails run`
// runs as a detached process tracked by a pid file.

use crate::paths;
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

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
        "[Unit]\nDescription=Tagmails email agent\nAfter=network-online.target\nWants=network-online.target\n\n\
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

/// Whether a systemd user manager answers. `--version` works without one, so
/// ask it something: containers have systemctl but no user bus.
pub fn has_systemd() -> bool {
    Command::new("systemctl")
        .args(["--user", "show-environment"])
        .output()
        .is_ok_and(|output| output.status.success())
}

fn pid_file() -> PathBuf {
    paths::data_dir().join("tagmails.pid")
}

/// The detached `tagmails run` from the pid file, if it is still running.
fn background_pid() -> Option<String> {
    let pid = fs::read_to_string(pid_file()).ok()?.trim().to_owned();
    if pid.is_empty() || !pid.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    // A reused pid belongs to some other program; only signal our own
    // `tagmails run`. If that can't be verified, treat the pid as stale.
    let cmdline = fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    is_tagmails_run(&cmdline).then_some(pid)
}

fn is_tagmails_run(cmdline: &[u8]) -> bool {
    let mut args = cmdline.split(|byte| *byte == 0);
    let program = args.next().map(|arg| Path::new(std::str::from_utf8(arg).unwrap_or("")).file_name().is_some_and(|name| name == "tagmails"));
    program == Some(true) && args.next() == Some(b"run".as_slice())
}

fn stop_background() -> bool {
    let Some(pid) = background_pid() else {
        let _ = fs::remove_file(pid_file());
        return false;
    };
    let _ = quiet(Command::new("kill").arg(&pid));
    for _ in 0..50 {
        if background_pid().is_none() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    let _ = fs::remove_file(pid_file());
    true
}

#[cfg(unix)]
extern "C" {
    fn setsid() -> i32;
}

/// Run `tagmails run` in its own session, detached from this terminal, with
/// output appended to the log files.
#[cfg(unix)]
fn start_background(binary: &Path) -> Result<String, Box<dyn Error>> {
    use std::os::unix::process::CommandExt;
    stop_background();
    let logs = paths::log_dir();
    fs::create_dir_all(&logs)?;
    let append = |name: &str| fs::OpenOptions::new().create(true).append(true).open(logs.join(name));
    let mut command = Command::new(binary);
    command
        .arg("run")
        .current_dir(paths::home())
        .stdin(Stdio::null())
        .stdout(append("tagmails.log")?)
        .stderr(append("tagmails.error.log")?);
    // SAFETY: setsid is async-signal-safe and touches no memory.
    unsafe {
        command.pre_exec(|| {
            setsid();
            Ok(())
        });
    }
    let child = command.spawn()?;
    write_private(&pid_file(), &format!("{}\n", child.id()))?;
    Ok(format!(
        "Started Tagmails in the background (pid {}). Logs: {}\n\
No systemd user session here, so it won't restart after a reboot; run `tagmails start` again then.",
        child.id(),
        logs.display()
    ))
}

#[cfg(not(unix))]
fn start_background(_binary: &Path) -> Result<String, Box<dyn Error>> {
    Err("No supported service manager found. Run `tagmails run` under your own supervisor.".into())
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
        // bootout returns before launchd finishes unloading, and an early
        // bootstrap then fails with EIO, so wait for the label to disappear.
        let _ = quiet(Command::new("launchctl").args(["bootout", &format!("{domain}/{LABEL}")]));
        for _ in 0..50 {
            let loaded = Command::new("launchctl")
                .args(["print", &format!("{domain}/{LABEL}")])
                .output()
                .is_ok_and(|output| output.status.success());
            if !loaded {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        write_private(&file, &launchd_plist(binary, &logs, &path_env))?;
        let mut output = quiet(Command::new("launchctl").args(["bootstrap", &domain]).arg(&file))?;
        for _ in 0..3 {
            if output.status.success() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_secs(1));
            output = quiet(Command::new("launchctl").args(["bootstrap", &domain]).arg(&file))?;
        }
        if !output.status.success() {
            return Err(format!(
                "launchd did not start Tagmails: {}",
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
                "systemd did not start Tagmails: {}",
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
    start_background(binary)
}

pub fn stop() -> Result<String, Box<dyn Error>> {
    if cfg!(target_os = "macos") {
        let domain = format!("gui/{}", uid()?);
        let _ = quiet(Command::new("launchctl").args(["bootout", &format!("{domain}/{LABEL}")]));
        return Ok("Stopped Tagmails. It will not start at login until `tagmails start`.".into());
    }
    if has_systemd() {
        quiet(Command::new("systemctl").args(["--user", "disable", "--now", UNIT]))?;
        return Ok("Stopped Tagmails.".into());
    }
    Ok(if stop_background() { "Stopped Tagmails." } else { "Tagmails was not running." }.into())
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
    Ok(format!("{message}\nRemoved the Tagmails service file.").trim().to_owned())
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
    match background_pid() {
        Some(pid) => format!("running (pid {pid}, background process)"),
        None => "not running".into(),
    }
}

/// Whether logs go to files (launchd or a background process) rather than journald.
pub fn logs_in_files() -> bool {
    cfg!(target_os = "macos") || !has_systemd()
}

pub fn log_hint() -> String {
    if logs_in_files() {
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
            Path::new("/Users/a&b/Library/Logs/Tagmails"),
            "/opt/homebrew/bin:/usr/bin",
        );
        assert!(plist.contains("<string>/opt/homebrew/bin/tagmails</string><string>run</string>"));
        assert!(plist.contains("/Users/a&amp;b/Library/Logs/Tagmails/tagmails.log"));
        assert!(!plist.contains("TAGMAILS_DEVICE_TOKEN"));
    }

    #[test]
    fn systemd_unit_quotes_the_binary() {
        let unit = systemd_unit(Path::new("/home/me/my apps/tagmails"), "/usr/bin:/bin");
        assert!(unit.contains("ExecStart=\"/home/me/my apps/tagmails\" run"));
        assert!(unit.contains("Environment=\"PATH=/usr/bin:/bin\""));
        assert!(unit.contains("WantedBy=default.target"));
    }

    #[test]
    fn only_a_tagmails_run_pid_is_ours() {
        assert!(super::is_tagmails_run(b"/root/.local/bin/tagmails\0run\0"));
        assert!(!super::is_tagmails_run(b"npm\0run\0dev\0"));
        assert!(!super::is_tagmails_run(b"/usr/bin/node\0tagmails\0run\0"));
        assert!(!super::is_tagmails_run(b"tagmails\0status\0"));
    }
}
