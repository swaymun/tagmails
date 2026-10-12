use base64::{engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD}, Engine};
use reqwest::blocking::Client;
use ring::hmac;
use ring::rand::{SecureRandom, SystemRandom};
use serde_json::{json, Value};
use std::env;
use std::error::Error;
use std::fs;
use std::fs::OpenOptions;
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path};
use std::process::{Command, Stdio};
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant};

mod paths;
mod push;
mod service;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_RELAY: &str = "https://tagmails-relay-dev.saimun-shahee.workers.dev";

/// What a relay watcher needs. `workspace: None` means project routing: the
/// relay picks one of this machine's published projects (or a chat folder)
/// for each new email thread.
#[derive(Clone)]
struct Settings {
    relay: String,
    token: String,
    access: String,
    workspace: Option<PathBuf>,
    /// "full" shares recent session requests to help routing; "files" does not.
    routing_context: String,
    /// Claude Code permission mode: manual, acceptEdits, auto or bypassPermissions.
    claude_permission: String,
}

fn post(client: &Client, base: &str, path: &str, body: Value) -> Result<Value, Box<dyn Error>> {
    let response = client
        .post(format!("{}{path}", base.trim_end_matches('/')))
        .json(&body)
        .send()?
        .error_for_status()?;
    Ok(response.json()?)
}

fn attachment_evidence(
    client: &Client,
    base: &str,
    claim: &Value,
) -> Result<Vec<String>, Box<dyn Error>> {
    let mut evidence = Vec::new();
    if let Some(attachments) = claim["request"]["attachments"].as_array() {
        for attachment in attachments {
            let path = attachment["path"]
                .as_str()
                .ok_or("Attachment has no path")?;
            if !path.starts_with("/api/attachment?") {
                return Err("Attachment path is outside the local lab".into());
            }
            let bytes = client
                .get(format!("{base}{path}"))
                .send()?
                .error_for_status()?
                .bytes()?;
            let expected = attachment["size"]
                .as_u64()
                .ok_or("Attachment has no size")?;
            if bytes.len() as u64 != expected {
                return Err("Downloaded attachment size did not match the claim".into());
            }
            let name = attachment["name"].as_str().unwrap_or("attachment");
            evidence.push(format!(
                "Read {name} ({expected} bytes) from the local lab."
            ));
        }
    }
    Ok(evidence)
}

fn mock_result(claim: &Value, attachment_evidence: Vec<String>) -> Value {
    let body = claim["request"]["body"].as_str().unwrap_or("");
    let model = claim["model"]["id"].as_str().unwrap_or("unresolved model");
    let effort = claim["model"]["effort"]
        .as_str()
        .unwrap_or("default effort");
    let short_request: String = body
        .lines()
        .filter(|line| !line.trim_start().starts_with("Model:"))
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(100)
        .collect();

    if let Some(error) = claim["model"]["error"].as_str() {
        return json!({"state":"needs_clarification","summary":error,"checks":["No model was called."]});
    }
    if !claim["approved"].as_bool().unwrap_or(false)
        && ["deploy", "publish", "purchase", "merge", "send an email"]
            .iter()
            .any(|word| body.to_lowercase().contains(word))
    {
        return json!({"state":"needs_approval","summary":"This simulated task needs the owner's approval before an external action.","details":[format!("Requested route: {model} ({effort})")],"checks":["No external action occurred."]});
    }
    if body.contains("[simulate:fail]") {
        return json!({"state":"failed","summary":"The Rust mock daemon stopped at the requested failure fixture.","checks":["No model was called and no files changed."]});
    }

    let summary = if claim["fixture"].as_str() == Some("incident") {
        "Synthetic investigation: trace the attachment bytes from inbound mail through persisted storage to the authenticated viewer.".to_string()
    } else {
        format!("Synthetic response to: {short_request}")
    };
    let mut details = vec![
        format!("Selected route: {model} ({effort})."),
        "The local Rust process claimed this queued email and returned a structured result."
            .to_string(),
    ];
    details.extend(attachment_evidence);
    json!({
        "state": "completed",
        "summary": summary,
        "details": details,
        "checks": ["No model was called and no files changed in this prototype."]
    })
}

fn agent_result(
    claim: &Value,
    base: &str,
    runtime: &str,
    workspace: &Path,
    claude_permission: &str,
    relay_token_file: Option<&Path>,
) -> Result<Value, Box<dyn Error>> {
    let file = match runtime {
        "codex-readonly" | "codex-write" | "codex-full" => "codex-runner.mjs",
        "claude-readonly" | "claude-write" => "claude-runner.mjs",
        _ => return Err("Unsupported local agent runtime".into()),
    };
    let runner = paths::adapters_dir()?.join(file);
    let mut command = Command::new("node");
    command.arg(runner).env("TAGMAILS_LAB_URL", base);
    // Relay runs renew their lease and fetch attachments from the relay with
    // the device token; without these the adapter talks to the local lab.
    if let Some(token_file) = relay_token_file {
        command
            .env("TAGMAILS_RELAY_URL", base)
            .env("TAGMAILS_DEVICE_TOKEN_FILE", token_file)
            .env("TAGMAILS_DEVICE_KEY_FILE", paths::device_key_file());
    }
    let mut child = command
        .env("TAGMAILS_RUNTIME", runtime)
        .env("TAGMAILS_WORKSPACE", workspace)
        .env("TAGMAILS_CLAUDE_PERMISSION", claude_permission)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    child
        .stdin
        .take()
        .ok_or("Local agent adapter stdin unavailable")?
        .write_all(claim.to_string().as_bytes())?;
    let output = child.wait_with_output()?;
    if !output.stderr.is_empty() {
        eprint!("{}", String::from_utf8_lossy(&output.stderr));
    }
    if !output.status.success() {
        return Err("Local agent adapter process failed".into());
    }
    let result: Value = serde_json::from_slice(&output.stdout)?;
    Ok(result)
}

fn runtime_label(runtime: &str) -> &'static str {
    match runtime {
        "codex-write" => "codex-app-server-write",
        "codex-full" => "codex-app-server-full",
        "codex-readonly" => "codex-app-server-readonly",
        "claude-write" => "claude-cli-write",
        _ => "claude-cli-readonly",
    }
}

fn relay_post(
    client: &Client,
    base: &str,
    path: &str,
    token: &str,
    body: Value,
) -> Result<Value, Box<dyn Error>> {
    let response = client
        .post(format!("{}{path}", base.trim_end_matches('/')))
        .bearer_auth(token)
        .json(&body)
        .send()?
        .error_for_status()?;
    Ok(response.json()?)
}

/// Tells the relay a run is starting. False only when the relay refuses: the
/// device was revoked (401/403) or the lease expired or moved (409). Then no
/// agent may start. A network error or an older relay still runs the job;
/// lease renewal catches a lost lease within its window.
fn lease_still_held(client: &Client, base: &str, token: &str, job_id: &str, lease_id: &str) -> bool {
    match relay_post(client, base, "/api/device/started", token, json!({"jobId":job_id,"leaseId":lease_id})) {
        Ok(_) => true,
        Err(error) => {
            let status = error.downcast_ref::<reqwest::Error>().and_then(reqwest::Error::status).map(|status| status.as_u16());
            if matches!(status, Some(401 | 403 | 409)) {
                return false;
            }
            eprintln!("Run start could not be reported: {error}");
            true
        }
    }
}

/// Runs the sealing-key helper (agent/device-key.mjs). The private key stays
/// in its file; only the helper reads it.
fn device_key(args: &[&str], input: Option<&[u8]>, relay: Option<&str>) -> Result<Vec<u8>, Box<dyn Error>> {
    let mut command = Command::new("node");
    command
        .arg(paths::adapters_dir()?.join("device-key.mjs"))
        .args(args)
        .env("TAGMAILS_DEVICE_KEY_FILE", paths::device_key_file());
    if let Some(base) = relay {
        let token_file = env::var("TAGMAILS_DEVICE_TOKEN_FILE").map(PathBuf::from).unwrap_or_else(|_| paths::token_file());
        command.env("TAGMAILS_RELAY_URL", base).env("TAGMAILS_DEVICE_TOKEN_FILE", token_file);
    }
    let mut child = command
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    if let Some(bytes) = input {
        child.stdin.take().ok_or("Device key helper stdin unavailable")?.write_all(bytes)?;
    }
    let output = child.wait_with_output()?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned().into());
    }
    Ok(output.stdout)
}

/// Creates this machine's sealing key if needed (`generate` replaces it) and
/// returns its public half.
fn device_public_key(command: &str) -> Result<String, Box<dyn Error>> {
    create_private_dir(&paths::config_dir())?;
    let file = paths::device_key_file();
    let output: Value = serde_json::from_slice(&device_key(&[command, &file.display().to_string()], None, None)?)?;
    output["publicKey"].as_str().map(str::to_owned).ok_or_else(|| "Device key helper returned no public key".into())
}

/// Registers this machine's public key so the relay stores its mail sealed.
/// A machine paired before 0.2.24 gets a key here on its first start.
fn register_device_key(client: &Client, settings: &Settings) -> Result<(), Box<dyn Error>> {
    let public_key = device_public_key("ensure")?;
    let response = relay_post(client, &settings.relay, "/api/device/key", &settings.token, json!({"publicKey": public_key}))?;
    if response["saved"] != true {
        return Err("Relay did not save the device key".into());
    }
    Ok(())
}

fn run_adapter_json(
    script: &str,
    workspace: &Path,
    routing_context: &str,
) -> Result<Value, Box<dyn Error>> {
    let output = Command::new("node")
        .arg(paths::adapters_dir()?.join(script))
        .env("TAGMAILS_WORKSPACE", workspace)
        .env("TAGMAILS_ROUTING_CONTEXT", routing_context)
        .current_dir(workspace)
        .output()?;
    if !output.status.success() {
        return Err(format!(
            "{script} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )
        .into());
    }
    Ok(serde_json::from_slice(&output.stdout)?)
}

fn publish_model_catalog(
    client: &Client,
    base: &str,
    token: &str,
    workspace: &Path,
) -> Result<(), Box<dyn Error>> {
    // Either CLI may be missing; publish whatever this machine has.
    let codex = run_adapter_json("codex-models.mjs", workspace, "files");
    let claude = run_adapter_json("claude-models.mjs", workspace, "files");
    if let (Err(codex_error), Err(claude_error)) = (&codex, &claude) {
        return Err(format!("no models found (Codex: {codex_error}; Claude: {claude_error})").into());
    }
    let mut catalog = json!({
        "models": codex.ok().map(|value| value["models"].clone()).unwrap_or(json!([])),
        "claudeModels": claude.ok().map(|value| value["models"].clone()).unwrap_or(json!([])),
    });
    // Defaults set with `tagmails start` or `tagmails set` (--model/--effort/--speed).
    // A default saved on the website overrides them.
    if let Some(on) = reactions_choice() {
        catalog["reactions"] = json!(on);
    }
    let defaults = effective_defaults(&load_config());
    if defaults.is_object() {
        catalog["defaults"] = defaults;
    }
    let response = relay_post(client, base, "/api/device/models", token, catalog)?;
    if response["saved"] != true {
        return Err("Relay did not save the model catalog".into());
    }
    Ok(())
}

/// Publish this machine's recent Codex and Claude project folders so the relay
/// can route a new email to the right one. The local copy is the allow-list a
/// claim must match before an agent runs in that folder.
fn publish_project_inventory(
    client: &Client,
    base: &str,
    token: &str,
    routing_context: &str,
) -> Result<usize, Box<dyn Error>> {
    let scratch = paths::scratch_dir();
    create_private_dir(&scratch)?;
    let inventory = run_adapter_json("project-inventory.mjs", &scratch, routing_context)?;
    let count = inventory["projects"].as_array().map_or(0, Vec::len);
    let file = paths::projects_file();
    create_private_dir(file.parent().ok_or("Projects file has no folder")?)?;
    write_private_file(&file, &serde_json::to_vec_pretty(&inventory)?)?;
    let response = relay_post(client, base, "/api/device/projects", token, inventory)?;
    if response["saved"] != true {
        return Err("Relay did not save the project list".into());
    }
    Ok(count)
}

fn create_private_dir(path: &Path) -> Result<(), Box<dyn Error>> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

/// Writes through a fresh temporary file, then renames it into place. The
/// temporary name is unpredictable and created exclusively, so a symlink an
/// agent planted in a writable folder (config/email) is never followed.
fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), Box<dyn Error>> {
    let parent = path.parent().ok_or("Settings file has no folder")?;
    if fs::symlink_metadata(parent)?.file_type().is_symlink() {
        return Err(format!("{} is a symlink; refusing to write settings through it", parent.display()).into());
    }
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos();
    let name = path.file_name().and_then(|name| name.to_str()).unwrap_or("settings");
    let temporary = parent.join(format!(".{name}.{}.{nonce:x}.tmp", std::process::id()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let written = options.open(&temporary).and_then(|mut file| file.write_all(bytes));
    if let Err(error) = written.and_then(|()| fs::rename(&temporary, path)) {
        let _ = fs::remove_file(&temporary);
        return Err(error.into());
    }
    Ok(())
}

/// Resolve the folder for a claimed job. A fixed workspace always wins. With
/// project routing, the relay's choice must be a folder this machine published;
/// anything else runs in the thread's chat folder (see chat_folder).
fn job_workspace(settings: &Settings, claim: &Value) -> Result<PathBuf, Box<dyn Error>> {
    if let Some(workspace) = &settings.workspace {
        return Ok(workspace.clone());
    }
    if claim["workspace"]["kind"] == "project" {
        let requested = claim["workspace"]["path"]
            .as_str()
            .ok_or("Relay project choice has no path")?;
        let inventory: Value = serde_json::from_slice(&fs::read(paths::projects_file())?)?;
        let allowed = inventory["projects"]
            .as_array()
            .is_some_and(|projects| projects.iter().any(|project| project["path"] == requested));
        let path = Path::new(requested);
        if !allowed || !path.is_absolute() || !path.is_dir() {
            return Err("Relay chose a folder this machine did not publish".into());
        }
        return Ok(path.canonicalize()?);
    }
    let thread = claim["threadId"].as_str().unwrap_or("");
    if thread.is_empty()
        || !thread
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("Claim has an invalid thread ID".into());
    }
    chat_folder(claim, thread)
}

/// Where an email with no matching project runs: the folder the Codex app uses
/// for chats without a project (~/Documents/Codex/<date>/<subject>), or for
/// Claude Code, or when that folder doesn't exist, ~/.tagmails/chats/<date>/<subject>.
/// A thread keeps its folder, so replies continue where the first email ran.
/// Jobs run on several threads; the thread-to-folder map is read and rewritten whole.
static CHAT_FOLDERS: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn chat_folder(claim: &Value, thread: &str) -> Result<PathBuf, Box<dyn Error>> {
    let _guard = CHAT_FOLDERS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let map_file = paths::data_dir().join("chat-folders.json");
    let mut map: Value = fs::read(&map_file)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    if let Some(saved) = map[thread].as_str().map(PathBuf::from) {
        if saved.is_dir() {
            return Ok(saved.canonicalize()?);
        }
    }
    let claude = claim["model"]["id"].as_str().is_some_and(|id| id.starts_with("claude-"));
    let codex_chats = paths::home().join("Documents").join("Codex");
    let base = if !claude && codex_chats.is_dir() {
        codex_chats
    } else {
        paths::home().join(".tagmails").join("chats")
    };
    let day = base.join(today());
    let slug = chat_slug(claim["request"]["subject"].as_str().unwrap_or(""));
    let mut folder = day.join(&slug);
    let mut suffix = 2;
    while folder.exists() {
        folder = day.join(format!("{slug}-{suffix}"));
        suffix += 1;
    }
    fs::create_dir_all(&folder)?;
    let folder = folder.canonicalize()?;
    map[thread] = json!(folder.display().to_string());
    create_private_dir(&paths::data_dir())?;
    fs::write(&map_file, serde_json::to_vec(&map)?)?;
    Ok(folder)
}

fn today() -> String {
    Command::new("date")
        .arg("+%Y-%m-%d")
        .output()
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .filter(|day| day.len() == 10)
        .unwrap_or_else(|| "today".into())
}

/// A short folder name from the subject, like the Codex app's chat folders.
fn chat_slug(subject: &str) -> String {
    let mut slug = String::new();
    for character in subject.to_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character);
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
        if slug.len() >= 40 {
            break;
        }
    }
    let slug = slug.trim_matches('-').to_owned();
    if slug.is_empty() { "email".into() } else { slug }
}

fn verified_claim(response: &Value, token: &str) -> Result<Value, Box<dyn Error>> {
    let payload = response["payload"]
        .as_str()
        .ok_or("Relay claim has no signed payload")?;
    let signature = response["signature"]
        .as_str()
        .ok_or("Relay claim has no signature")?;
    let bytes = URL_SAFE_NO_PAD.decode(payload)?;
    let signature_bytes = URL_SAFE_NO_PAD.decode(signature)?;
    hmac::verify(
        &hmac::Key::new(hmac::HMAC_SHA256, token.as_bytes()),
        &bytes,
        &signature_bytes,
    )
    .map_err(|_| "Relay claim signature is invalid")?;
    Ok(serde_json::from_slice(&bytes)?)
}

fn validate_relay_base(base: &str) -> Result<(), Box<dyn Error>> {
    let url = reqwest::Url::parse(base)?;
    let local = matches!(url.host_str(), Some("127.0.0.1" | "localhost"));
    if (url.scheme() != "https" && !(url.scheme() == "http" && local && url.port().is_some()))
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Relay URL must be HTTPS, or an explicit localhost HTTP port".into());
    }
    Ok(())
}

fn valid_device_token(token: &str) -> bool {
    token.strip_prefix("tm_dev_").is_some_and(|secret| {
        secret.len() == 43
            && secret
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    })
}

fn device_is_paired(client: &Client, base: &str, token: &str) -> Result<bool, Box<dyn Error>> {
    let response = client
        .get(format!("{}/api/device/status", base.trim_end_matches('/')))
        .bearer_auth(token)
        .send()?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Ok(false);
    }
    let status: Value = response.error_for_status()?.json()?;
    if status["paired"] != true {
        return Err("Relay returned an invalid device status".into());
    }
    Ok(true)
}

fn pair_relay(base: &str, code: &str, path: &Path, name: &str, public_key: Option<&str>) -> Result<(), Box<dyn Error>> {
    validate_relay_base(base)?;
    if !code.starts_with("tm_pair_")
        || code.len() != 35
        || !code[8..]
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("Pairing code is invalid".into());
    }
    if !path.is_absolute() {
        return Err("Device token file must be an absolute path".into());
    }
    let token_file = path.display().to_string();
    if name.trim().is_empty() || name.len() > 80 {
        return Err("Device name must be 1-80 characters".into());
    }
    let client = Client::builder().timeout(Duration::from_secs(10)).build()?;
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.file_type().is_file() {
                return Err("Existing device token path is not a regular file".into());
            }
            #[cfg(unix)]
            if metadata.permissions().mode() & 0o077 != 0 {
                return Err("Existing device token file must be owner-only".into());
            }
            let existing = fs::read_to_string(path)?;
            let token = existing.trim();
            if !valid_device_token(token) {
                return Err("Existing device token file is invalid".into());
            }
            return match device_is_paired(&client, base, token) {
                Ok(true) => {
                    println!("Existing device token is active on this relay. Confirm its account in TagMails setup.");
                    Ok(())
                }
                Ok(false) => Err("Existing device token is not active on this relay. Move it aside and create a new pairing code before retrying.".into()),
                Err(error) => Err(format!("Could not check the existing device token; it was kept for recovery: {error}").into()),
            };
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let mut secret = [0u8; 32];
    SystemRandom::new()
        .fill(&mut secret)
        .map_err(|_| "Could not generate a device token")?;
    let token = format!("tm_dev_{}", URL_SAFE_NO_PAD.encode(secret));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(path)?;
    file.write_all(format!("{token}\n").as_bytes())?;
    file.sync_all()?;
    let sent = client
        .post(format!("{}/api/device/pair", base.trim_end_matches('/')))
        .json(&match public_key {
            Some(key) => json!({"code":code,"token":token,"name":name.trim(),"publicKey":key}),
            None => json!({"code":code,"token":token,"name":name.trim()}),
        })
        .send();
    let (rejected, reason) = match sent {
        Ok(response) => {
            let status = response.status();
            if status.is_success()
                && response
                    .json::<Value>()
                    .is_ok_and(|body| body["paired"] == true)
            {
                println!("Device paired. Token saved at {token_file}.");
                return Ok(());
            }
            (status.is_client_error(), format!("Relay returned {status}"))
        }
        Err(error) => (false, error.to_string()),
    };
    match device_is_paired(&client, base, &token) {
        Ok(true) => println!(
            "Device pairing confirmed after an interrupted response. Token saved at {token_file}."
        ),
        Ok(false) if rejected => {
            fs::remove_file(path)?;
            return Err(format!("Pairing was rejected ({reason}); token file removed").into());
        }
        Ok(false) => {
            return Err(format!("Pairing could not be confirmed ({reason}); token file kept for recovery. Retry this command after the relay is reachable.").into());
        }
        Err(error) => {
            return Err(format!("Pairing could not be confirmed ({reason}); token file kept for recovery. Status check failed: {error}").into());
        }
    }
    Ok(())
}

/// Codex runs with the machine's access setting; Claude Code with its own
/// permission mode (the runner reads TAGMAILS_CLAUDE_PERMISSION).
fn relay_runtime(
    model: &str,
    access: &str,
    claude_permission: &str,
) -> Result<&'static str, Box<dyn Error>> {
    if !["read", "write", "full"].contains(&access) {
        return Err("TAGMAILS_WORKSPACE_ACCESS must be read, write, or full".into());
    }
    if model.starts_with("claude-") {
        return match claude_permission {
            "readonly" | "manual" => Ok("claude-readonly"),
            "acceptEdits" | "auto" | "bypassPermissions" => Ok("claude-write"),
            _ => Err("Claude permission must be manual, acceptEdits, auto or bypassPermissions".into()),
        };
    }
    match (model.starts_with("gpt-"), access) {
        (true, "read") => Ok("codex-readonly"),
        (true, "write") => Ok("codex-write"),
        (true, "full") => Ok("codex-full"),
        _ => Err("Relay claim has an unsupported model or access mode".into()),
    }
}

fn relay_result(
    claim: &Value,
    base: &str,
    access: &str,
    claude_permission: &str,
    workspace: &Path,
) -> Result<Value, Box<dyn Error>> {
    if let Some(error) = claim["model"]["error"].as_str() {
        return Ok(
            json!({"runtime":"tagmails-router","state":"needs_clarification","summary":error}),
        );
    }
    let model = claim["model"]["id"].as_str().unwrap_or("");
    let runtime = relay_runtime(model, access, claude_permission)?;
    let token_file = env::var("TAGMAILS_DEVICE_TOKEN_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| paths::token_file());
    Ok(match agent_result(claim, base, runtime, workspace, claude_permission, Some(&token_file)) {
        Ok(result) => result,
        Err(error) => {
            eprintln!("Local agent adapter failed: {error}");
            json!({"runtime":runtime_label(runtime),"state":"failed","summary":"The local agent adapter could not complete this turn."})
        }
    })
}

fn wants_answer_file(claim: &Value) -> bool {
    claim["request"]["fromOwner"] == true
        && claim["request"]["body"]
            .as_str()
            .and_then(|body| body.lines().next())
            .map(|line| line.trim_end() == "TagMails-Attach: answer.txt")
            .unwrap_or(false)
}

fn requested_workspace_file(claim: &Value) -> Result<Option<String>, &'static str> {
    if claim["request"]["fromOwner"] != true {
        return Ok(None);
    }
    let Some(line) = claim["request"]["body"]
        .as_str()
        .and_then(|body| body.lines().next())
    else {
        return Ok(None);
    };
    let Some(name) = line.strip_prefix("TagMails-File:") else {
        return Ok(None);
    };
    let name = name.trim();
    if !valid_workspace_name(name) {
        return Err("TagMails-File needs a relative workspace path with a simple filename.");
    }
    Ok(Some(name.to_owned()))
}

/// A relative path inside the workspace whose filename is plain ASCII.
fn valid_workspace_name(name: &str) -> bool {
    let path = Path::new(name);
    let valid_path = !name.is_empty()
        && !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)));
    let valid_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|value| {
            value.len() <= 120
                && value != "."
                && value != ".."
                && value.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b' ')
                })
        });
    valid_path && valid_name
}

/// Upload IDs must be UUIDs and stable across retries: the first file reuses
/// the lease ID, later ones flip its last byte by their index.
fn upload_id(lease_id: &str, index: usize) -> String {
    if index == 0 || lease_id.len() != 36 {
        return lease_id.to_owned();
    }
    let last = u8::from_str_radix(&lease_id[34..], 16).unwrap_or(0) ^ (index as u8);
    format!("{}{last:02x}", &lease_id[..34])
}

/// Most file bytes one reply can carry: the relay sends files in the email itself.
const EMAIL_FILE_BYTES: u64 = 3_500_000;

/// A non-empty regular file inside the workspace, opened now, and its size.
/// It is opened before the relay is asked where it goes, and read later from
/// this handle, so a process in the workspace can't swap in a symlink to a
/// file outside it (or a FIFO) after the check.
fn workspace_file(workspace: &Path, name: &str) -> Result<(fs::File, u64), Box<dyn Error>> {
    let root = workspace.canonicalize()?;
    let source = root.join(name).canonicalize()?;
    if !source.starts_with(&root) || !source.is_file() {
        return Err("Requested file is outside the selected workspace or is not a file".into());
    }
    let file = fs::File::open(&source)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || source.canonicalize()? != source {
        return Err("Requested file changed while it was being checked".into());
    }
    if metadata.len() == 0 {
        return Err("Requested file is empty".into());
    }
    Ok((file, metadata.len()))
}

fn read_capped(file: &fs::File, size: u64) -> Result<Vec<u8>, Box<dyn Error>> {
    if size > EMAIL_FILE_BYTES {
        return Err("File exceeds 3.5 MB".into());
    }
    let mut bytes = Vec::new();
    file.take(EMAIL_FILE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 != size {
        return Err("File changed while it was being sent".into());
    }
    Ok(bytes)
}

fn workspace_file_type(name: &str) -> &'static str {
    match Path::new(name).extension().and_then(|value| value.to_str()) {
        Some("txt") => "text/plain",
        Some("md") => "text/markdown",
        Some("csv") => "text/csv",
        Some("html") => "text/html",
        Some("pdf") => "application/pdf",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("mp4") => "video/mp4",
        Some("zip") => "application/zip",
        _ => "application/octet-stream",
    }
}

fn answer_file(result: &Value) -> Vec<u8> {
    let mut lines = Vec::new();
    // The full answer the email shows; summary and details are only its preview.
    let answer = result["answer"].as_str().filter(|answer| !answer.trim().is_empty());
    if let Some(text) = answer.or(result["summary"].as_str()) {
        lines.push(text.to_owned());
    }
    let fields: &[&str] = if answer.is_some() { &["checks"] } else { &["details", "checks"] };
    for field in fields.iter().copied() {
        if let Some(items) = result[field].as_array() {
            for item in items {
                if let Some(text) = item.as_str() {
                    lines.push(text.to_owned());
                }
            }
        }
    }
    format!("{}\n", lines.join("\n\n")).into_bytes()
}

fn upload_file(
    client: &Client,
    base: &str,
    token: &str,
    job_id: &str,
    lease_id: &str,
    upload_id: &str,
    filename: &str,
    mime_type: &str,
    bytes: Vec<u8>,
) -> Result<(), Box<dyn Error>> {
    let sha256: String = ring::digest::digest(&ring::digest::SHA256, &bytes)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    // The shared client times out after 10 s; a large file on a slow uplink needs longer.
    let seconds = 60 + bytes.len() as u64 / 250_000;
    let response: Value = client
        .post(format!(
            "{}/api/device/artifacts?jobId={job_id}&leaseId={lease_id}",
            base.trim_end_matches('/')
        ))
        .timeout(Duration::from_secs(seconds))
        .bearer_auth(token)
        .header("Content-Type", mime_type)
        .header("Content-Length", bytes.len().to_string())
        .header("X-TagMails-Filename", filename)
        .header("X-TagMails-Upload-Id", upload_id)
        .header("X-TagMails-SHA256", sha256)
        .body(bytes)
        .send()?
        .error_for_status()?
        .json()?;
    if response["id"] != upload_id {
        return Err("Relay returned a different file ID".into());
    }
    Ok(())
}

/// TagMails' recommended permissions, used until `tagmails start --access ...`
/// or `--claude-permission ...` chooses others. Only the machine sets these.
const DEFAULT_ACCESS: &str = "write";
const DEFAULT_CLAUDE_PERMISSION: &str = "auto";

fn relay_iteration(client: &Client, settings: &Settings) -> Result<bool, Box<dyn Error>> {
    match claim_next(client, settings, &[])? {
        Some(claim) => run_claim(client, settings, claim).map(|()| true),
        None => Ok(false),
    }
}

/// Claim the next job, skipping project folders other running jobs are using.
fn claim_next(client: &Client, settings: &Settings, busy: &[String]) -> Result<Option<Value>, Box<dyn Error>> {
    let token = settings.token.as_str();
    let response = relay_post(client, &settings.relay, "/api/device/claim", token, json!({"busyFolders": busy}))?;
    if response["pendingSends"] == true {
        // Replies the relay held sealed to this machine; it opens and returns them.
        match device_key(&["send-pending"], None, Some(&settings.relay)) {
            Ok(_) => println!("Sent held replies."),
            Err(error) => eprintln!("Held replies could not be sent: {error}"),
        }
    }
    if response["claimed"] != true {
        return Ok(None);
    }
    let claim = verified_claim(&response, token)?;
    if claim["sealed"] != true {
        return Ok(Some(claim));
    }
    // The request is sealed to this machine's key; open it locally.
    match device_key(&["open-claim"], Some(claim.to_string().as_bytes()), None)
        .and_then(|bytes| Ok(serde_json::from_slice::<Value>(&bytes)?))
    {
        Ok(opened) => Ok(Some(opened)),
        Err(error) => {
            eprintln!("Sealed email could not be opened: {error}");
            let result = json!({"runtime":"tagmails-router","state":"failed","summary":"This computer could not open the sealed email. If it was paired again, ask the sender to resend it."});
            relay_post(client, &settings.relay, "/api/device/complete", token, json!({
                "jobId": claim["jobId"], "leaseId": claim["leaseId"], "result": result, "subject": "", "files": [],
            }))?;
            Ok(None)
        }
    }
}

/// The project folder a claim will run in, if the relay chose one.
fn claim_folder(claim: &Value) -> Option<String> {
    (claim["workspace"]["kind"] == "project").then(|| claim["workspace"]["path"].as_str().map(str::to_owned)).flatten()
}

fn run_claim(client: &Client, settings: &Settings, mut claim: Value) -> Result<(), Box<dyn Error>> {
    let base = settings.relay.as_str();
    let token = settings.token.as_str();
    let job_id = claim["jobId"]
        .as_str()
        .ok_or("Claim has no job ID")?
        .to_owned();
    let lease_id = claim["leaseId"]
        .as_str()
        .ok_or("Claim has no lease ID")?
        .to_owned();
    claim["claimId"] = json!(lease_id);
    claim["claimed"] = json!(true);
    let access = settings.access.as_str();
    let claude_permission = settings.claude_permission.as_str();
    let file_request = requested_workspace_file(&claim);
    let workspace = job_workspace(settings, &claim);
    let mut result = match (&file_request, &workspace) {
        (Err(message), _) => {
            json!({"runtime":"tagmails-router","state":"needs_clarification","summary":message})
        }
        (_, Err(error)) => {
            eprintln!("{job_id}: {error}");
            json!({"runtime":"tagmails-router","state":"failed","summary":"This machine could not open the project folder chosen for this email. Reply with the folder name, or run `tagmails status` on the machine to check its project list."})
        }
        (Ok(_), Ok(workspace)) => {
            println!(
                "{job_id}: running {} in {} (Codex {access}, Claude {claude_permission})",
                claim["model"]["id"].as_str().unwrap_or("unknown model"),
                workspace.display()
            );
            if !lease_still_held(client, base, token, &job_id, &lease_id) {
                eprintln!("{job_id}: the relay revoked this computer or replaced the lease; not running it");
                return Ok(());
            }
            // Only the owner's own reply may show their instructions; a
            // participant run never reports them, even if they changed meanwhile.
            let owner = claim["request"]["fromOwner"] == true;
            let instructions = owner.then(owner_instructions).flatten();
            let mut result = relay_result(&claim, base, access, claude_permission, workspace)?;
            if let Some(note) = owner.then(|| instructions_change_note(&instructions, &owner_instructions())).flatten() {
                // Its own field, so the reply always shows it (checks can be folded away).
                result["instructionsNotice"] = json!(note.chars().take(300).collect::<String>());
            }
            result
        }
    };
    // Sealed mail: files ride along with the completion so the relay never stores them.
    let sealed = claim["sealed"] == true;
    let mut inline_files: Vec<Value> = Vec::new();
    if result["state"] == "completed" && wants_answer_file(&claim) {
        if sealed {
            inline_files.push(json!({"name":"answer.txt","mimeType":"text/plain","content":STANDARD.encode(answer_file(&result))}));
        } else {
            upload_file(
                client,
                base,
                token,
                &job_id,
                &lease_id,
                &lease_id,
                "answer.txt",
                "text/plain",
                answer_file(&result),
            )?;
            result["artifactIds"] = json!([lease_id]);
        }
    } else if result["state"] == "completed" {
        if let Ok(workspace) = &workspace {
            // Files the owner asked for (TagMails-File:) must arrive; files the
            // agent chose to attach (TagMails-Attach:) are best effort.
            let mut names: Vec<(String, bool)> = Vec::new();
            if let Ok(Some(name)) = &file_request {
                names.push((name.clone(), true));
            }
            for name in result["attach"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                if names.len() < 5 && !names.iter().any(|(existing, _)| existing == name) {
                    names.push((name.to_owned(), false));
                }
            }
            let mut ids = Vec::new();
            let mut unsent: Vec<Value> = Vec::new();
            let mut skipped = Vec::new();
            for (name, required) in names {
                let filename = Path::new(&name).file_name().and_then(|value| value.to_str()).unwrap_or("file").to_owned();
                let mime_type = workspace_file_type(&filename);
                let file = if valid_workspace_name(&name) {
                    workspace_file(workspace, &name)
                } else {
                    Err("not a simple relative path".into())
                };
                // The relay decides whether a mail-safe file fits in the email; a
                // file over the whole reply's budget never does. An older relay
                // without the route endpoint just takes the upload.
                let route = file.as_ref().ok().map(|(_, size)| {
                    if *size > EMAIL_FILE_BYTES {
                        return json!({"route": "none", "reason": "too-large"});
                    }
                    relay_post(client, base, "/api/device/file-route", token,
                        json!({"jobId": job_id, "leaseId": lease_id, "name": filename, "mimeType": mime_type, "size": size}))
                        .unwrap_or_else(|_| json!({"route": "relay"}))
                });
                let sent: Result<(), Box<dyn Error>> = match (file, route) {
                    (Err(error), _) => Err(error),
                    (Ok(_), Some(route)) if route["route"] == "none" => {
                        let reason = route["reason"].as_str().unwrap_or("failed").to_owned();
                        unsent.push(json!({"name": filename, "reason": reason}));
                        if required { Err(format!("not sent ({reason})").into()) } else { Ok(()) }
                    }
                    (Ok((file, size)), _) if sealed => read_capped(&file, size).map(|bytes| {
                        inline_files.push(json!({"name": filename, "mimeType": mime_type, "content": STANDARD.encode(bytes)}));
                    }),
                    (Ok((file, size)), _) => {
                        let id = upload_id(&lease_id, ids.len());
                        read_capped(&file, size)
                            .and_then(|bytes| upload_file(client, base, token, &job_id, &lease_id, &id, &filename, mime_type, bytes))
                            .map(|()| ids.push(id))
                    }
                };
                match sent {
                    Ok(()) => {}
                    Err(error) if required => {
                        eprintln!("Requested file could not be exported: {error}");
                        result["state"] = json!("failed");
                        result["summary"] = json!("The requested file was missing, empty, outside the selected workspace, or too large to send by email (3.5 MB of files per reply).");
                        result["checks"] = json!(["No file was uploaded. Local edits from this turn may remain."]);
                        ids.clear();
                        unsent.clear();
                        inline_files.clear();
                        break;
                    }
                    Err(error) => {
                        eprintln!("{name} could not be attached: {error}");
                        skipped.push(name);
                    }
                }
            }
            if !unsent.is_empty() {
                result["unsentFiles"] = json!(unsent);
            }
            if !ids.is_empty() {
                result["artifactIds"] = json!(ids);
            }
            if !skipped.is_empty() {
                push_check(&mut result, format!("Could not attach: {}", skipped.join(", ")));
            }
        }
    }
    if let Some(object) = result.as_object_mut() {
        object.remove("attach");
    }
    let mut body = json!({"jobId":job_id,"leaseId":lease_id,"result":result});
    if sealed {
        // The relay sends the reply from this request; it can't read the stored mail.
        body["subject"] = claim["request"]["subject"].clone();
        body["files"] = json!(inline_files);
    }
    let bytes = body.to_string().len() as u64;
    let completion: Value = client
        .post(format!("{}/api/device/complete", base.trim_end_matches('/')))
        .timeout(Duration::from_secs(30 + bytes / 250_000))
        .bearer_auth(token)
        .json(&body)
        .send()?
        .error_for_status()?
        .json()?;
    if completion["completed"] != true {
        return Err("Relay did not acknowledge the completion".into());
    }
    println!(
        "{job_id}: {} result stored in the relay",
        result["state"].as_str().unwrap_or("unknown")
    );
    Ok(())
}

fn read_token(path: &Path) -> Result<String, Box<dyn Error>> {
    let data = fs::read_to_string(path).map_err(|error| {
        format!("No device token at {} ({error}). Run `tagmails pair <code>` first.", path.display())
    })?;
    let token = data.trim();
    if !valid_device_token(token) {
        return Err("Device token file is invalid".into());
    }
    Ok(token.to_owned())
}

/// Tell the relay this machine takes no project choices (a pinned workspace).
fn clear_published_projects(client: &Client, settings: &Settings) {
    if let Err(error) = relay_post(client, &settings.relay, "/api/device/projects", &settings.token, json!({"projects":[]})) {
        eprintln!("Could not clear the published project list: {error}");
    }
}

/// `reload` re-reads config.json and email/defaults.json before each claim, so
/// `tagmails start` flags and `tagmails set` apply without a restart. The
/// legacy environment interface passes false.
fn run_relay(settings: &Settings, once: bool, reload: bool) -> Result<(), Box<dyn Error>> {
    validate_relay_base(&settings.relay)?;
    if !["read", "write", "full"].contains(&settings.access.as_str()) {
        return Err("Access must be read, write, or full".into());
    }
    if let Some(workspace) = &settings.workspace {
        if !workspace.is_absolute() || !workspace.is_dir() {
            return Err("Workspace must be an existing absolute directory".into());
        }
    }
    let client = Client::builder().timeout(Duration::from_secs(10)).build()?;
    if !once {
        match &settings.workspace {
            Some(workspace) => println!(
                "TagMails {VERSION} watching {} ({} access in {}).",
                settings.relay,
                settings.access,
                workspace.display()
            ),
            None => println!(
                "TagMails {VERSION} watching {} ({} access, project routing).",
                settings.relay, settings.access
            ),
        }
    }
    // Scratch is also the model probe folder after a switch to project routing.
    create_private_dir(&paths::scratch_dir())?;
    if settings.workspace.is_some() {
        // A pinned machine must not keep receiving project choices from an
        // earlier routing session.
        clear_published_projects(&client, settings);
    }
    if let Err(error) = register_device_key(&client, settings) {
        eprintln!("Sealing key unavailable; this machine's mail keeps relay-key storage: {error}");
    }
    let mut settings = settings.clone();
    let mut seen_config = read_config()?;
    let mut config_error: Option<String> = None;
    // Model defaults and the reactions choice ride the model-catalog publish.
    let mut seen_defaults = (effective_defaults(&seen_config), reactions_choice());
    let mut next_model_probe = Instant::now();
    let mut next_project_probe = Instant::now();
    let push = (!once).then(|| push::Push::start(&settings.relay, &settings.token));
    // Jobs run in parallel across threads and folders (the relay keeps each
    // thread in order and skips folders named busy). A pinned workspace runs one at a time.
    let max_jobs = |settings: &Settings| if settings.workspace.is_some() { 1 } else {
        env::var("TAGMAILS_MAX_JOBS").ok().and_then(|value| value.parse().ok()).filter(|n| (1..=8).contains(n)).unwrap_or(3)
    };
    let mut running: std::collections::HashMap<String, Option<String>> = std::collections::HashMap::new();
    let (done_sender, done_receiver) = std::sync::mpsc::channel::<String>();
    loop {
        if reload && !once {
            // A half-written or broken file keeps the settings already running.
            let config = match read_config() {
                Ok(config) => {
                    config_error = None;
                    config
                }
                Err(error) => {
                    if config_error.as_ref() != Some(&error) {
                        eprintln!("Keeping the current settings: {error}");
                    }
                    config_error = Some(error);
                    seen_config.clone()
                }
            };
            let defaults = (effective_defaults(&config), reactions_choice());
            if defaults != seen_defaults {
                next_model_probe = Instant::now();
                seen_defaults = defaults;
            }
            if config != seen_config {
                let pinned = settings.workspace.clone();
                apply_machine_settings(&mut settings, &config);
                if settings.workspace.as_ref().is_some_and(|workspace| !workspace.is_dir()) {
                    eprintln!("Ignoring the saved workspace: it is not a folder");
                    settings.workspace = pinned.clone();
                }
                if settings.workspace != pinned || config["routingContext"] != seen_config["routingContext"] {
                    match &settings.workspace {
                        Some(_) => clear_published_projects(&client, &settings),
                        None => next_project_probe = Instant::now(),
                    }
                }
                println!("Settings reloaded (Codex {}, Claude {}).", settings.access, settings.claude_permission);
                seen_config = config;
            }
        }
        if Instant::now() >= next_model_probe {
            next_model_probe = Instant::now() + Duration::from_secs(120);
            let probe_folder = match &settings.workspace {
                Some(workspace) => workspace.clone(),
                None => paths::scratch_dir(),
            };
            match publish_model_catalog(&client, &settings.relay, &settings.token, &probe_folder) {
                Ok(()) => next_model_probe = Instant::now() + Duration::from_secs(3600),
                Err(error) => eprintln!("Model catalog refresh unavailable: {error}"),
            }
        }
        if settings.workspace.is_none() && Instant::now() >= next_project_probe {
            next_project_probe = Instant::now() + Duration::from_secs(120);
            match publish_project_inventory(
                &client,
                &settings.relay,
                &settings.token,
                &settings.routing_context,
            ) {
                Ok(count) => {
                    if !once {
                        println!("Published {count} project folders.");
                    }
                    next_project_probe = Instant::now() + Duration::from_secs(900);
                }
                Err(error) => eprintln!("Project list refresh unavailable: {error}"),
            }
        }
        if once {
            if !relay_iteration(&client, &settings)? {
                println!("No queued relay mail.");
            }
            return Ok(());
        }
        while let Ok(finished) = done_receiver.try_recv() {
            running.remove(&finished);
        }
        let mut claimed = false;
        if running.len() < max_jobs(&settings) {
            let busy: Vec<String> = running.values().flatten().cloned().collect();
            match claim_next(&client, &settings, &busy) {
                Ok(Some(claim)) => {
                    claimed = true;
                    let job_id = claim["jobId"].as_str().unwrap_or("").to_owned();
                    running.insert(job_id.clone(), claim_folder(&claim));
                    let (client, settings) = (client.clone(), settings.clone());
                    let (done, waker) = (done_sender.clone(), push.as_ref().map(push::Push::waker));
                    thread::spawn(move || {
                        if let Err(error) = run_claim(&client, &settings, claim) {
                            eprintln!("{job_id}: {error}");
                        }
                        let _ = done.send(job_id);
                        if let Some(waker) = waker {
                            let _ = waker.send(());
                        }
                    });
                }
                Ok(None) => {}
                Err(error) => eprintln!("Relay unavailable: {error}"),
            }
        }
        if !claimed {
            match (&push, running.len() >= max_jobs(&settings)) {
                // At capacity, only a finished job frees a slot.
                (_, true) => {
                    if let Ok(finished) = done_receiver.recv_timeout(push::POLL_EVERY) {
                        running.remove(&finished);
                    }
                }
                (Some(push), false) => push.wait(),
                (None, false) => thread::sleep(push::POLL_EVERY),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn chat_folders_use_a_short_subject_name() {
        assert_eq!(chat_slug("Re: Travel guide scripts!"), "re-travel-guide-scripts");
        assert_eq!(chat_slug("   "), "email");
        assert_eq!(chat_slug(&"a".repeat(80)).len(), 40);
    }

    #[test]
    fn set_by_email_changes_only_model_defaults_and_start_takes_them_back() {
        let args = |list: &[&str]| list.iter().map(|arg| arg.to_string()).collect::<Vec<_>>();
        for flag in ["--access", "--claude-permission", "--projects", "--workspace", "--routing-context", "--relay", "--name"] {
            let error = set_email_defaults(&args(&["set", "--model", "gpt-6-sol", flag, "full"])).unwrap_err();
            assert_eq!(error.to_string(), "Permissions and folders change only with `tagmails start` in a terminal.");
        }
        assert!(set_email_defaults(&args(&["set", "--effort", "huge"])).is_err());
        assert!(set_email_defaults(&args(&["set", "--model", "gpt 6; rm"])).is_err());

        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let root = env::temp_dir().join(format!("tagmails-set-test-{nonce}"));
        env::set_var("TAGMAILS_CONFIG_DIR", &root);
        let mut config = json!({"access": "write", "defaults": {"model": "gpt-6-luna", "effort": "low"}});
        save_config(&config).unwrap();
        // Email defaults start from the terminal ones and win over them.
        set_email_defaults(&args(&["set", "--model", "claude-sonnet-5-5"])).unwrap();
        assert_eq!(effective_defaults(&config), json!({"model": "claude-sonnet-5-5", "effort": "low"}));
        assert_eq!(load_config(), config);
        #[cfg(unix)]
        assert_eq!(fs::metadata(paths::email_settings_dir()).unwrap().permissions().mode() & 0o777, 0o700);
        // An invalid email file is ignored.
        fs::write(paths::email_defaults_file(), r#"{"model":"x y"}"#).unwrap();
        assert_eq!(effective_defaults(&config), config["defaults"]);
        // --clear-defaults by email removes only the email file.
        set_email_defaults(&args(&["set", "--speed", "fast"])).unwrap();
        set_email_defaults(&args(&["set", "--clear-defaults"])).unwrap();
        assert!(!paths::email_defaults_file().exists());
        // A model choice in the terminal replaces the one set by email.
        set_email_defaults(&args(&["set", "--model", "claude-sonnet-5-5"])).unwrap();
        apply_start_flags(&mut config, &args(&["start", "--model", "gpt-6-sol"])).unwrap();
        assert!(!paths::email_defaults_file().exists());
        assert_eq!(effective_defaults(&config)["model"], "gpt-6-sol");
        // Other start flags leave it alone.
        set_email_defaults(&args(&["set", "--model", "claude-sonnet-5-5"])).unwrap();
        apply_start_flags(&mut config, &args(&["start", "--access", "full"])).unwrap();
        assert_eq!(effective_defaults(&config)["model"], "claude-sonnet-5-5");
        // A broken config.json is an error, never the broader defaults (write access, project routing).
        let saved = fs::read(paths::config_file()).unwrap();
        fs::write(paths::config_file(), b"{\"access\": \"read\",").unwrap();
        assert!(read_config().unwrap_err().contains("not a valid settings file"));
        assert!(settings_from_config().is_err(), "the service must not start on the defaults");
        fs::write(paths::config_file(), &saved).unwrap();
        assert_eq!(read_config().unwrap(), load_config());
        // A symlink an agent plants among the email settings is never followed into config.json.
        #[cfg(unix)]
        {
            let before = fs::read(paths::config_file()).unwrap();
            for name in ["defaults.tmp", ".defaults.json.tmp"] {
                std::os::unix::fs::symlink(paths::config_file(), paths::email_settings_dir().join(name)).unwrap();
            }
            set_email_defaults(&args(&["set", "--model", "gpt-6-luna"])).unwrap();
            assert_eq!(fs::read(paths::config_file()).unwrap(), before);
            assert_eq!(effective_defaults(&config)["model"], "gpt-6-luna");
        }
        // Standing instructions: set, shown in replies when a run changes them, cleared.
        assert!(set_email_defaults(&args(&["set"])).is_err());
        let before = owner_instructions();
        assert_eq!(before, None);
        set_email_defaults(&args(&["set", "--instructions", "Put files too large for email in my Google Drive."])).unwrap();
        let after = owner_instructions();
        assert_eq!(after.as_deref(), Some("Put files too large for email in my Google Drive.\n"));
        assert!(instructions_change_note(&before, &after).unwrap().contains("They now read: \"Put files too large"));
        assert_eq!(instructions_change_note(&after, &after), None);
        assert!(set_email_defaults(&args(&["set", "--instructions", &"x".repeat(MAX_INSTRUCTIONS + 1)])).is_err());
        set_email_defaults(&args(&["set", "--clear-instructions"])).unwrap();
        // Status reactions are off unless the owner turns them on.
        assert_eq!(reactions_choice(), None);
        assert!(set_email_defaults(&args(&["set", "--reactions", "maybe"])).is_err());
        set_email_defaults(&args(&["set", "--reactions", "on"])).unwrap();
        assert_eq!(reactions_choice(), Some(true));
        set_email_defaults(&args(&["set", "--reactions", "off"])).unwrap();
        assert_eq!(reactions_choice(), Some(false));
        assert_eq!(owner_instructions(), None);
        assert!(instructions_change_note(&after, &None).unwrap().contains("cleared"));
        let mut result = json!({"checks": (0..12).map(|index| index.to_string()).collect::<Vec<_>>()});
        push_check(&mut result, "y".repeat(400));
        assert_eq!(result["checks"].as_array().unwrap().len(), 12, "the relay rejects more than 12 checks");
        assert_eq!(result["checks"][11].as_str().unwrap().len(), 300);
        env::remove_var("TAGMAILS_CONFIG_DIR");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recommended_permissions_are_the_default_and_only_the_machine_sets_them() {
        let mut settings = Settings {
            relay: String::new(),
            token: String::new(),
            access: String::new(),
            workspace: None,
            routing_context: String::new(),
            claude_permission: String::new(),
        };
        apply_machine_settings(&mut settings, &json!({}));
        assert_eq!((settings.access.as_str(), settings.claude_permission.as_str()), ("write", "auto"));
        apply_machine_settings(&mut settings, &json!({"access": "full", "claudePermission": "bypassPermissions"}));
        assert_eq!((settings.access.as_str(), settings.claude_permission.as_str()), ("full", "bypassPermissions"));
        // A pre-0.2.20 cap below the saved setting still holds after the upgrade.
        let capped = json!({"access": "full", "maxAccess": "read", "claudePermission": "bypassPermissions", "maxClaudePermission": "manual"});
        apply_machine_settings(&mut settings, &capped);
        assert_eq!((settings.access.as_str(), settings.claude_permission.as_str()), ("read", "manual"));
        apply_machine_settings(&mut settings, &json!({"maxAccess": "read"}));
        assert_eq!(settings.access, "read", "the new default doesn't lift an old cap either");
        // Choosing a permission again in the terminal is what lifts it.
        let mut config = capped.clone();
        let args: Vec<String> = ["start", "--access", "full"].iter().map(|arg| arg.to_string()).collect();
        apply_start_flags(&mut config, &args).unwrap();
        apply_machine_settings(&mut settings, &config);
        assert_eq!((settings.access.as_str(), settings.claude_permission.as_str()), ("full", "manual"));
    }

    #[test]
    fn attached_files_get_distinct_stable_upload_ids() {
        let lease = "11111111-2222-4333-8444-5555555555a0";
        let ids: Vec<String> = (0..5).map(|index| upload_id(lease, index)).collect();
        assert_eq!(ids[0], lease);
        assert_eq!(ids[1], "11111111-2222-4333-8444-5555555555a1");
        assert_eq!(ids.iter().collect::<std::collections::HashSet<_>>().len(), 5);
        assert_eq!(upload_id(lease, 3), ids[3]);
        assert!(valid_workspace_name("scripts/madrid.md"));
        assert!(!valid_workspace_name("../secret.txt"));
        assert!(!valid_workspace_name("/etc/passwd"));
    }

    use super::*;
    use std::net::TcpListener;

    #[test]
    fn a_revoked_device_or_replaced_lease_never_starts_the_agent() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let statuses = ["401 Unauthorized", "409 Conflict", "404 Not Found", "200 OK"];
        let server = thread::spawn(move || {
            for status in statuses {
                let (mut stream, _) = listener.accept().unwrap();
                let mut bytes = [0u8; 4096];
                let length = stream.read(&mut bytes).unwrap();
                assert!(String::from_utf8_lossy(&bytes[..length]).starts_with("POST /api/device/started"));
                let body = if status.starts_with("200") { "{\"started\":true}" } else { "{}" };
                let response = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        let client = Client::new();
        let held: Vec<bool> = (0..4).map(|_| lease_still_held(&client, &base, "tm_dev_x", "job", "lease")).collect();
        // 401 revoked and 409 replaced stop the run; an older relay (404) or success runs it.
        assert_eq!(held, [false, false, true, true]);
        server.join().unwrap();
    }

    #[test]
    fn relay_claim_rejects_tampered_payload() {
        let token = "tm_dev_local_test";
        let bytes = br#"{"jobId":"job-1"}"#;
        let signature = hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, token.as_bytes()), bytes);
        let mut response = json!({
            "payload": URL_SAFE_NO_PAD.encode(bytes),
            "signature": URL_SAFE_NO_PAD.encode(signature.as_ref()),
        });
        assert_eq!(verified_claim(&response, token).unwrap()["jobId"], "job-1");
        response["payload"] = json!(URL_SAFE_NO_PAD.encode(br#"{"jobId":"job-2"}"#));
        assert!(verified_claim(&response, token).is_err());
    }

    #[test]
    fn pairing_recovers_an_interrupted_response_without_creating_a_second_token() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            for expected in ["POST", "GET", "GET"] {
                let (mut stream, _) = listener.accept().unwrap();
                let mut bytes = [0u8; 4096];
                let length = stream.read(&mut bytes).unwrap();
                let request = String::from_utf8_lossy(&bytes[..length]).to_lowercase();
                assert!(request.starts_with(&expected.to_lowercase()));
                if expected == "GET" {
                    assert!(request.contains("authorization: bearer tm_dev_"));
                }
                let response = if expected == "POST" {
                    "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                } else {
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 15\r\nConnection: close\r\n\r\n{\"paired\":true}"
                };
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let file = env::temp_dir().join(format!("tagmails-pair-test-{nonce}"));
        let code = format!("tm_pair_{}", "a".repeat(27));
        assert!(pair_relay(&base, &code, &file, "Mac", None).is_ok());
        let original = fs::read_to_string(&file).unwrap();
        assert!(valid_device_token(original.trim()));
        assert!(pair_relay(&base, &code, &file, "Mac", None).is_ok());
        assert_eq!(fs::read_to_string(&file).unwrap(), original);
        server.join().unwrap();
        fs::remove_file(&file).unwrap();
    }

    #[test]
    fn relay_unknown_model_requests_clarification_without_running_an_agent() {
        let result = relay_result(
            &json!({"model":{"error":"Use Codex, Claude, or Luna."}}),
            "unused",
            "read",
            "manual",
            Path::new("/unused"),
        )
        .unwrap();
        assert_eq!(result["state"], "needs_clarification");
        assert_eq!(result["summary"], "Use Codex, Claude, or Luna.");
    }

    #[test]
    fn relay_write_access_is_explicit_and_model_specific() {
        assert_eq!(relay_runtime("gpt-6-luna", "read", "manual").unwrap(), "codex-readonly");
        assert_eq!(relay_runtime("gpt-6.1-sol", "write", "manual").unwrap(), "codex-write");
        assert_eq!(relay_runtime("gpt-6-sol", "full", "manual").unwrap(), "codex-full");
        // Claude follows its own permission mode, whatever the Codex access is.
        assert_eq!(relay_runtime("claude-opus-5-5", "read", "manual").unwrap(), "claude-readonly");
        assert_eq!(relay_runtime("claude-opus-5-5", "read", "auto").unwrap(), "claude-write");
        assert_eq!(relay_runtime("claude-opus-5-5", "full", "acceptEdits").unwrap(), "claude-write");
        assert!(relay_runtime("claude-opus-5-5", "read", "plan").is_err());
        assert!(relay_runtime("unknown", "write", "manual").is_err());
        assert!(relay_runtime("gpt-6-luna", "broad", "manual").is_err());
    }

    #[test]
    fn answer_file_requires_an_explicit_owner_command_and_contains_only_the_visible_answer() {
        let owner = json!({"request":{"fromOwner":true,
            "body":"TagMails-Attach: answer.txt\nModel: Luna\nSummarize this."}});
        assert!(wants_answer_file(&owner));
        assert!(!wants_answer_file(&json!({"request":{"fromOwner":false,
            "body":"TagMails-Attach: answer.txt\nSummarize this."}})));
        assert!(!wants_answer_file(&json!({"request":{"fromOwner":true,
            "body":"Please summarize.\nTagMails-Attach: answer.txt"}})));
        let result = json!({"summary":"Done.","details":["Found two items."],
            "checks":["No files changed."],"transcript":{"events":[{"text":"Private step"}]}});
        assert_eq!(
            String::from_utf8(answer_file(&result)).unwrap(),
            "Done.\n\nFound two items.\n\nNo files changed.\n"
        );
        // A long answer is exported whole, not its short preview.
        let long = format!("{}END-OF-ANSWER", "word ".repeat(1500));
        let result = json!({"summary":"Preview.","details":["Preview detail."],"answer":long,"checks":["No files changed."]});
        let text = String::from_utf8(answer_file(&result)).unwrap();
        assert!(text.contains("END-OF-ANSWER") && !text.contains("Preview"));
    }

    #[test]
    fn workspace_export_requires_owner_and_a_safe_relative_path() {
        let owner = |body| json!({"request":{"fromOwner":true,"body":body}});
        assert_eq!(
            requested_workspace_file(&owner(
                "TagMails-File: reports/result.pdf\nCreate a report."
            ))
            .unwrap(),
            Some("reports/result.pdf".into())
        );
        assert_eq!(
            requested_workspace_file(&json!({"request":{"fromOwner":false,
                "body":"TagMails-File: report.txt"}}))
            .unwrap(),
            None
        );
        assert_eq!(
            requested_workspace_file(&owner("Please send report.txt\nTagMails-File: report.txt"))
                .unwrap(),
            None
        );
        for name in [
            "",
            "../secret.txt",
            "/tmp/secret.txt",
            "dir/../../secret.txt",
            "file%.txt",
            "dir\\secret.txt",
        ] {
            let request =
                json!({"request":{"fromOwner":true,"body":format!("TagMails-File: {name}")}});
            assert!(requested_workspace_file(&request).is_err());
        }
    }

    #[test]
    fn workspace_export_does_not_follow_a_link_outside_the_workspace() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = env::temp_dir().join(format!("tagmails-file-test-{nonce}"));
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        fs::write(workspace.join("inside.txt"), b"safe").unwrap();
        fs::write(root.join("outside.txt"), b"private").unwrap();
        let (inside, size) = workspace_file(&workspace, "inside.txt").unwrap();
        // Swapped for a link to a private file after the check: the opened file is still what's sent.
        #[cfg(unix)]
        {
            fs::remove_file(workspace.join("inside.txt")).unwrap();
            std::os::unix::fs::symlink(root.join("outside.txt"), workspace.join("inside.txt")).unwrap();
        }
        assert_eq!(read_capped(&inside, size).unwrap(), b"safe");
        assert!(workspace_file(&workspace, "../outside.txt").is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("outside.txt"), workspace.join("link.txt"))
                .unwrap();
            assert!(workspace_file(&workspace, "link.txt").is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn project_routing_runs_only_in_published_folders_or_private_scratch() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = env::temp_dir().join(format!("tagmails-route-test-{nonce}"));
        let project = root.join("project");
        let other = root.join("other");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&other).unwrap();
        env::set_var("TAGMAILS_DATA_DIR", root.join("data"));
        fs::create_dir_all(root.join("data")).unwrap();
        let published = project.canonicalize().unwrap();
        fs::write(
            paths::projects_file(),
            json!({"projects":[{"path":published.display().to_string()}]}).to_string(),
        )
        .unwrap();
        let settings = Settings {
            relay: "https://example.com".into(),
            token: "tm_dev_x".into(),
            access: "read".into(),
            workspace: None,
            routing_context: "full".into(),
            claude_permission: "acceptEdits".into(),
        };
        let claim = |workspace: Value| json!({"threadId":"thread-1","workspace":workspace});
        assert_eq!(
            job_workspace(&settings, &claim(json!({"kind":"project","path":published.display().to_string()}))).unwrap(),
            published
        );
        assert!(job_workspace(&settings, &claim(json!({"kind":"project","path":other.display().to_string()}))).is_err());
        // No project: Claude (or no Codex chats folder) uses ~/.tagmails/chats;
        // a Codex email uses the Codex app's chats folder; a thread keeps its folder.
        let real_home = env::var_os("HOME");
        env::set_var("HOME", &root);
        let chat = |id: &str, thread: &str| json!({"threadId":thread,"workspace":{"kind":"scratch"},
            "model":{"id":id},"request":{"subject":"Travel guide scripts"}});
        let scratch = job_workspace(&settings, &chat("claude-opus-5-5", "thread-1")).unwrap();
        assert!(scratch.starts_with(root.canonicalize().unwrap().join(".tagmails/chats")));
        assert!(scratch.ends_with("travel-guide-scripts"));
        assert_eq!(job_workspace(&settings, &chat("claude-opus-5-5", "thread-1")).unwrap(), scratch);
        fs::create_dir_all(root.join("Documents/Codex")).unwrap();
        let codex = job_workspace(&settings, &chat("gpt-6-sol", "thread-2")).unwrap();
        assert!(codex.starts_with(root.canonicalize().unwrap().join("Documents/Codex")));
        match real_home {
            Some(home) => env::set_var("HOME", home),
            None => env::remove_var("HOME"),
        }
        assert!(job_workspace(&settings, &json!({"threadId":"../escape"})).is_err());
        let fixed = Settings { workspace: Some(other.clone()), ..settings };
        assert_eq!(job_workspace(&fixed, &claim(json!({"kind":"scratch"}))).unwrap(), other);
        env::remove_var("TAGMAILS_DATA_DIR");
        fs::remove_dir_all(root).unwrap();
    }
}

fn run_lab() -> Result<(), Box<dyn Error>> {
    let base = env::var("TAGMAILS_LAB_URL").unwrap_or_else(|_| "http://127.0.0.1:4177".into());
    let url = reqwest::Url::parse(&base)?;
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") || url.port().is_none() {
        return Err("This prototype connects only to an explicit 127.0.0.1 HTTP lab port".into());
    }
    let once = env::args().any(|arg| arg == "--once");
    let runtime = env::var("TAGMAILS_RUNTIME").unwrap_or_else(|_| "mock".into());
    if runtime != "mock"
        && runtime != "codex-readonly"
        && runtime != "codex-write"
        && runtime != "codex-full"
        && runtime != "claude-readonly"
        && runtime != "claude-write"
    {
        return Err(
            "TAGMAILS_RUNTIME must be mock, codex-readonly, codex-write, codex-full, claude-readonly, or claude-write".into(),
        );
    }
    let selected_job = if runtime != "mock" {
        if !once {
            return Err("Local agent prototypes require --once".into());
        }
        let job = env::var("TAGMAILS_JOB_ID")?;
        if !job.starts_with("job-")
            || job.len() == 4
            || !job[4..].chars().all(|ch| ch.is_ascii_digit())
        {
            return Err("TAGMAILS_JOB_ID must name one queued lab job".into());
        }
        let workspace = env::var("TAGMAILS_WORKSPACE")?;
        if !Path::new(&workspace).is_absolute() || !Path::new(&workspace).is_dir() {
            return Err("TAGMAILS_WORKSPACE must be an existing absolute directory".into());
        }
        Some(job)
    } else {
        None
    };
    let client = Client::builder().timeout(Duration::from_secs(10)).build()?;
    println!("TagMails Rust {runtime} daemon polling {base}. Press Ctrl-C to stop.");
    loop {
        match post(&client, &base, "/api/claim", json!({"jobId":selected_job})) {
            Ok(claim) if claim["claimed"] == true => {
                let result = if runtime != "mock" {
                    let workspace = PathBuf::from(env::var("TAGMAILS_WORKSPACE")?);
                    let permission = if runtime == "claude-write" { "acceptEdits" } else { "readonly" };
                    match agent_result(&claim, &base, &runtime, &workspace, permission, None) {
                        Ok(result) => result,
                        Err(error) => {
                            eprintln!("Local agent adapter failed: {error}");
                            json!({"runtime":runtime_label(&runtime),"state":"failed","summary":"The local agent adapter could not complete this turn."})
                        }
                    }
                } else {
                    match attachment_evidence(&client, &base, &claim) {
                        Ok(evidence) => mock_result(&claim, evidence),
                        Err(error) => {
                            eprintln!("Could not read mock attachment: {error}");
                            json!({"state":"failed","summary":"The local worker could not read an attached file.","checks":["No model was called and no files changed."]})
                        }
                    }
                };
                let id = claim["jobId"].as_str().ok_or("Claim has no job ID")?;
                let claim_id = claim["claimId"].as_str().ok_or("Claim has no lease ID")?;
                let completion = post(
                    &client,
                    &base,
                    "/api/complete",
                    json!({"jobId":id,"claimId":claim_id,"result":result}),
                )?;
                println!(
                    "{id}: {}",
                    completion["state"].as_str().unwrap_or("unknown")
                );
            }
            Ok(_) => {
                if once {
                    println!("No queued mail.");
                }
            }
            Err(error) => eprintln!("Lab unavailable: {error}"),
        }
        if once {
            break;
        }
        thread::sleep(Duration::from_secs(2));
    }
    Ok(())
}

const HELP: &str = "TagMails: email your coding agent.

Usage:
  tagmails pair <code> [--name NAME] [--relay URL]   Connect this machine to your account
  tagmails start [--access read|write|full] [--workspace PATH | --projects]
                 [--claude-permission manual|accept-edits|auto|bypass]
                 [--routing-context full|files]
                 [--model ID] [--effort LEVEL] [--speed standard|fast]
                 [--clear-defaults]
                                                   Save settings and run in the background
  tagmails set [--model ID] [--effort LEVEL] [--speed standard|fast] [--clear-defaults]
               [--instructions TEXT] [--clear-instructions] [--reactions on|off]
                                                   Change model defaults or your standing
                                                   instructions without a restart
  tagmails status                                  Show settings, connection and service state
  tagmails stop                                    Stop the background service
  tagmails logs                                    Follow the service log
  tagmails open <thread-id>                        Open an email thread's agent session
  tagmails run [--once]                            Run in the foreground (what the service runs)
  tagmails uninstall                               Remove the background service
  tagmails --version

--access and --claude-permission set what agents may do on this machine; only this
machine sets them. TagMails recommends Codex write and Claude auto (the default).
Full access and bypass apply only after you choose --access full or
--claude-permission bypass here.

--model, --effort and --speed set this machine's default for emails that don't ask for
one. `tagmails set` changes them while the service keeps running (an agent can run it
when you ask by email); permissions and folders change only with `tagmails start` in a
terminal. --instructions are standing instructions every one of your emails follows
(for example where to put files too large for email); a reply says when they change.

Pairing codes come from your relay's site (https://tagmails.com for the hosted service). By default TagMails picks one of
your recent Codex or Claude project folders for each new email (--projects). Use
--workspace to pin every email to one folder instead. To pick the folder, TagMails
shares each project's name, README excerpt, top-level files and, with the default
--routing-context full, the first line of your last few sessions there.";

fn option(args: &[String], name: &str) -> Result<Option<String>, Box<dyn Error>> {
    match args.iter().position(|arg| arg == name) {
        None => Ok(None),
        Some(index) => match args.get(index + 1) {
            Some(value) if !value.starts_with("--") => Ok(Some(value.clone())),
            _ => Err(format!("Pass a value after {name}").into()),
        },
    }
}

/// The saved settings. A missing file is the defaults; an unreadable or
/// malformed one is an error, never the defaults: those are TagMails'
/// recommended permissions and project routing, which can be broader than
/// what the owner chose (`--access read`, a pinned workspace).
fn read_config() -> Result<Value, String> {
    let file = paths::config_file();
    let bytes = match fs::read(&file) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(json!({})),
        Err(error) => return Err(format!("{} could not be read: {error}", file.display())),
    };
    serde_json::from_slice::<Value>(&bytes)
        .ok()
        .filter(Value::is_object)
        .ok_or_else(|| format!("{} is not a valid settings file; fix it or run `tagmails start` with your flags after deleting it", file.display()))
}

/// Settings for display and model defaults, where a broken file means none.
fn load_config() -> Value {
    read_config().unwrap_or_else(|_| json!({}))
}

fn save_config(config: &Value) -> Result<(), Box<dyn Error>> {
    create_private_dir(&paths::config_dir())?;
    write_private_file(&paths::config_file(), &serde_json::to_vec_pretty(config)?)
}

fn configured_relay(config: &Value) -> String {
    env::var("TAGMAILS_RELAY_URL")
        .ok()
        .or_else(|| config["relay"].as_str().map(str::to_owned))
        .unwrap_or_else(|| DEFAULT_RELAY.into())
}

fn default_device_name() -> String {
    let host = Command::new("hostname")
        .arg("-s")
        .output()
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "My computer".into());
    host.chars().take(80).collect()
}

fn settings_from_config() -> Result<Settings, Box<dyn Error>> {
    let config = read_config()?;
    let mut settings = Settings {
        relay: configured_relay(&config),
        token: read_token(&paths::token_file())?,
        access: String::new(),
        workspace: None,
        routing_context: String::new(),
        claude_permission: String::new(),
    };
    apply_machine_settings(&mut settings, &config);
    Ok(settings)
}

/// The settings `tagmails start` saves that a running service picks up
/// without a restart. Relay and token stay as the service started.
/// Before 0.2.20 a machine could cap what the website chose with
/// --max-access / --max-claude-permission. Keep honoring a cap that is lower
/// than the saved setting until `tagmails start` sets that permission again.
fn legacy_capped<'a>(value: &'a str, cap: Option<&'a str>, order: &[&str]) -> &'a str {
    let rank = |item: &str| order.iter().position(|known| *known == item);
    match (rank(value), cap.and_then(|cap| rank(cap).map(|position| (cap, position)))) {
        (Some(wanted), Some((cap, limit))) if wanted > limit => cap,
        _ => value,
    }
}

fn apply_machine_settings(settings: &mut Settings, config: &Value) {
    let access = config["access"].as_str().unwrap_or(DEFAULT_ACCESS);
    settings.access = legacy_capped(access, config["maxAccess"].as_str(), &["read", "write", "full"]).to_owned();
    settings.workspace = config["workspace"].as_str().map(PathBuf::from);
    settings.routing_context = config["routingContext"].as_str().unwrap_or("full").to_owned();
    let claude = config["claudePermission"].as_str().unwrap_or(DEFAULT_CLAUDE_PERMISSION);
    settings.claude_permission = legacy_capped(claude, config["maxClaudePermission"].as_str(),
        &["readonly", "manual", "acceptEdits", "auto", "bypassPermissions"]).to_owned();
}

/// Checks one model default (`model`, `effort` or `speed`) as start and set accept it.
fn check_default(key: &str, value: &str) -> Result<(), String> {
    let valid = match key {
        "model" => {
            !value.is_empty()
                && value.len() <= 80
                && value.chars().all(|c| c.is_ascii_alphanumeric() || "-._".contains(c))
        }
        "effort" => ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].contains(&value),
        "speed" => ["standard", "fast", "ultrafast"].contains(&value),
        _ => false,
    };
    if valid {
        return Ok(());
    }
    Err(match key {
        "model" => "--model must be a model id such as gpt-6-sol or claude-sonnet-5-5".into(),
        "effort" => "--effort must be none, minimal, low, medium, high, xhigh, max or ultra".into(),
        "speed" => "--speed must be standard, fast or ultrafast".into(),
        _ => format!("Unknown default {key}"),
    })
}

/// Applies --clear-defaults, then --model, --effort and --speed. Returns
/// whether any of those flags was passed.
fn apply_default_flags(defaults: &mut serde_json::Map<String, Value>, args: &[String]) -> Result<bool, Box<dyn Error>> {
    let mut given = false;
    if args.iter().any(|arg| arg == "--clear-defaults") {
        defaults.clear();
        given = true;
    }
    for key in ["model", "effort", "speed"] {
        if let Some(value) = option(args, &format!("--{key}"))? {
            check_default(key, &value)?;
            defaults.insert(key.into(), json!(value));
            given = true;
        }
    }
    Ok(given)
}

/// Defaults written by `tagmails set` (email/defaults.json) win while that
/// file is valid; otherwise the ones `tagmails start` saved in config.json.
fn effective_defaults(config: &Value) -> Value {
    let email = fs::read(paths::email_defaults_file())
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .filter(|value| {
            value.as_object().is_some_and(|map| {
                !map.is_empty()
                    && map.iter().all(|(key, value)| value.as_str().is_some_and(|text| check_default(key, text).is_ok()))
            })
        });
    email.unwrap_or_else(|| config["defaults"].clone())
}

fn remove_email_defaults() -> Result<(), Box<dyn Error>> {
    match fs::remove_file(paths::email_defaults_file()) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
        _ => Ok(()),
    }
}

/// Everything `tagmails start` saves. A model default chosen in the terminal
/// replaces one set by email.
fn apply_start_flags(config: &mut Value, args: &[String]) -> Result<(), Box<dyn Error>> {
    if let Some(access) = option(args, "--access")? {
        if !["read", "write", "full"].contains(&access.as_str()) {
            return Err("--access must be read, write, or full".into());
        }
        config["access"] = json!(access);
        // A permission chosen in the terminal replaces any pre-0.2.20 cap.
        config.as_object_mut().map(|map| map.remove("maxAccess"));
    }
    if let Some(permission) = option(args, "--claude-permission")? {
        let mode = match permission.as_str() {
            "manual" => "manual",
            "accept-edits" | "acceptEdits" => "acceptEdits",
            "auto" => "auto",
            "bypass" | "bypassPermissions" => "bypassPermissions",
            _ => return Err("--claude-permission must be manual, accept-edits, auto or bypass".into()),
        };
        config["claudePermission"] = json!(mode);
        config.as_object_mut().map(|map| map.remove("maxClaudePermission"));
    }
    if let Some(context) = option(args, "--routing-context")? {
        if !["full", "files"].contains(&context.as_str()) {
            return Err("--routing-context must be full or files".into());
        }
        config["routingContext"] = json!(context);
    }
    let mut defaults = config["defaults"].as_object().cloned().unwrap_or_default();
    if apply_default_flags(&mut defaults, args)? {
        remove_email_defaults()?;
    }
    config["defaults"] = if defaults.is_empty() { Value::Null } else { json!(defaults) };
    if args.iter().any(|arg| arg == "--projects") {
        config["workspace"] = Value::Null;
    } else if let Some(workspace) = option(args, "--workspace")? {
        let path = PathBuf::from(&workspace);
        let path = if path.is_absolute() { path } else { env::current_dir()?.join(path) };
        if !path.is_dir() {
            return Err(format!("Workspace is not a folder: {}", path.display()).into());
        }
        config["workspace"] = json!(path.canonicalize()?.display().to_string());
    }
    config["relay"] = json!(configured_relay(config));
    Ok(())
}

/// The path the service should start. Homebrew's Cellar path changes on every
/// upgrade, so prefer its stable `bin/tagmails` link.
fn service_binary() -> Result<PathBuf, Box<dyn Error>> {
    let exe = env::current_exe()?;
    let text = exe.display().to_string();
    if let Some(index) = text.find("/Cellar/tagmails/") {
        let stable = PathBuf::from(format!("{}/bin/tagmails", &text[..index]));
        if stable.exists() {
            return Ok(stable);
        }
    }
    Ok(exe)
}

fn command_pair(args: &[String]) -> Result<(), Box<dyn Error>> {
    let code = args
        .iter()
        .skip(1)
        .find(|arg| arg.starts_with("tm_pair_"))
        .ok_or("Pass the pairing code from the setup page: tagmails pair tm_pair_…")?;
    let mut config = read_config()?;
    let relay = option(args, "--relay")?.unwrap_or_else(|| configured_relay(&config));
    let name = option(args, "--name")?.unwrap_or_else(default_device_name);
    create_private_dir(&paths::config_dir())?;
    // A new pairing gets a new sealing key; an existing token keeps its key.
    let public_key = if paths::token_file().exists() {
        None
    } else {
        match device_public_key("generate") {
            Ok(key) => Some(key),
            Err(error) => {
                eprintln!("Could not create a sealing key ({error}); mail for this machine will use relay-key storage until `tagmails start` creates one.");
                None
            }
        }
    };
    pair_relay(&relay, code, &paths::token_file(), &name, public_key.as_deref())?;
    config["relay"] = json!(relay);
    config["deviceName"] = json!(name);
    save_config(&config)?;
    println!("Next: tagmails start");
    Ok(())
}

/// Codex sandboxes read and write runs with bubblewrap on Linux, which most
/// containers (Docker, RunPod) block. Every sandboxed command would then fail,
/// so say so up front. Full access runs unsandboxed and is unaffected.
fn codex_sandbox_problem(access: &str) -> Option<String> {
    if !cfg!(target_os = "linux") || access == "full" {
        return None;
    }
    let output = Command::new("codex").args(["sandbox", "--", "true"]).stdin(Stdio::null()).output().ok()?;
    if output.status.success() {
        return None;
    }
    let reason = String::from_utf8_lossy(&output.stderr).lines().next().unwrap_or("").trim().to_owned();
    Some(format!(
        "Codex's sandbox can't run on this computer{}. Codex emails will fail here. Use a VM or a host that allows unprivileged user namespaces, or run `tagmails start --access full` if this machine is only yours.",
        if reason.is_empty() { String::new() } else { format!(" ({reason})") }
    ))
}

fn command_start(args: &[String]) -> Result<(), Box<dyn Error>> {
    let mut config = read_config()?;
    read_token(&paths::token_file())?;
    apply_start_flags(&mut config, args)?;
    save_config(&config)?;
    paths::adapters_dir()?;
    println!("{}", service::start(&service_binary()?)?);
    let access = config["access"].as_str().unwrap_or(DEFAULT_ACCESS);
    if let Some(problem) = codex_sandbox_problem(access) {
        eprintln!("Warning: {problem}");
    }
    match config["workspace"].as_str() {
        Some(workspace) => println!("Access: {access} in {workspace}"),
        None => println!("Access: {access} in the project folder chosen for each email (or a chat folder when none fits)."),
    }
    println!("Send an email to your agent address to try it.");
    Ok(())
}

/// Change model defaults without restarting the service, so an agent can run
/// it from an email. It writes only email/defaults.json; permissions and
/// folders change only with `tagmails start` in a terminal.
fn set_email_defaults(args: &[String]) -> Result<String, Box<dyn Error>> {
    let mut values = args.iter().skip(1);
    while let Some(arg) = values.next() {
        match arg.as_str() {
            "--model" | "--effort" | "--speed" | "--instructions" | "--reactions" => {
                values.next();
            }
            "--clear-defaults" | "--clear-instructions" => {}
            "--access" | "--claude-permission" | "--projects" | "--workspace" | "--routing-context" | "--relay" | "--name" => {
                return Err("Permissions and folders change only with `tagmails start` in a terminal.".into());
            }
            other => return Err(format!("Unknown option `{other}` for `tagmails set`. Pass --model, --effort, --speed, --clear-defaults, --instructions or --clear-instructions.").into()),
        }
    }
    let mut messages = Vec::new();
    if let Some(value) = option(args, "--reactions")? {
        messages.push(set_reactions(&value)?);
    }
    if let Some(text) = option(args, "--instructions")? {
        messages.push(set_instructions(Some(&text))?);
    } else if args.iter().any(|arg| arg == "--clear-instructions") {
        messages.push(set_instructions(None)?);
    }
    let model_flags = ["--model", "--effort", "--speed", "--clear-defaults"];
    if !args.iter().any(|arg| model_flags.contains(&arg.as_str())) {
        return if messages.is_empty() {
            Err("Pass --model, --effort, --speed, --clear-defaults, --instructions, --clear-instructions or --reactions on|off.".into())
        } else {
            Ok(messages.join(" "))
        };
    }
    let clear = args.iter().any(|arg| arg == "--clear-defaults");
    let mut defaults = if clear {
        serde_json::Map::new()
    } else {
        effective_defaults(&load_config()).as_object().cloned().unwrap_or_default()
    };
    if !apply_default_flags(&mut defaults, args)? {
        return Err("Pass --model, --effort, --speed or --clear-defaults.".into());
    }
    if defaults.is_empty() {
        remove_email_defaults()?;
        messages.push("Cleared the defaults set by email. The service picks this up before its next email.".into());
        return Ok(messages.join(" "));
    }
    create_private_dir(&paths::email_settings_dir())?;
    write_private_file(&paths::email_defaults_file(), &serde_json::to_vec_pretty(&defaults)?)?;
    let part = |key: &str| defaults.get(key).and_then(Value::as_str).unwrap_or("-").to_owned();
    messages.push(format!(
        "Default model {} {} {}. The service picks this up before its next email.",
        part("model"), part("effort"), part("speed")
    ));
    Ok(messages.join(" "))
}

/// Adds a reply check within the relay's limits (12 checks of 300 characters).
fn push_check(result: &mut Value, check: String) {
    let check: String = check.chars().take(300).collect();
    if !result["checks"].is_array() {
        result["checks"] = json!([]);
    }
    if let Some(checks) = result["checks"].as_array_mut() {
        checks.truncate(11);
        checks.push(json!(check));
    }
}

/// Whether the relay sends Gmail status reactions (👀 received, ✅ done):
/// Some(true/false) once the owner chose, None to leave the relay's default (off).
fn reactions_choice() -> Option<bool> {
    match fs::read_to_string(paths::email_reactions_file()).ok()?.trim() {
        "on" => Some(true),
        "off" => Some(false),
        _ => None,
    }
}

fn set_reactions(value: &str) -> Result<String, Box<dyn Error>> {
    if !["on", "off"].contains(&value) {
        return Err("--reactions must be on or off".into());
    }
    create_private_dir(&paths::email_settings_dir())?;
    write_private_file(&paths::email_reactions_file(), format!("{value}\n").as_bytes())?;
    Ok(format!("Gmail status reactions are {value}. The service picks this up before its next email."))
}

/// Longest standing instructions an owner can set; they ride in every prompt.
const MAX_INSTRUCTIONS: usize = 4000;

/// The owner's standing instructions, if any.
fn owner_instructions() -> Option<String> {
    fs::read_to_string(paths::email_instructions_file()).ok().filter(|text| !text.trim().is_empty())
}

/// Replaces (or with None, removes) the owner's standing instructions.
fn set_instructions(text: Option<&str>) -> Result<String, Box<dyn Error>> {
    let Some(text) = text.map(str::trim).filter(|text| !text.is_empty()) else {
        match fs::remove_file(paths::email_instructions_file()) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.into()),
            _ => return Ok("Cleared your TagMails instructions.".into()),
        }
    };
    if text.chars().count() > MAX_INSTRUCTIONS || text.contains('\0') {
        return Err(format!("Instructions must be plain text up to {MAX_INSTRUCTIONS} characters.").into());
    }
    create_private_dir(&paths::email_settings_dir())?;
    write_private_file(&paths::email_instructions_file(), format!("{text}\n").as_bytes())?;
    Ok("Saved your TagMails instructions; every email you send from now on follows them.".into())
}

/// A reply line naming instructions that changed during a run, so a change an
/// email (or text quoted in it) caused is never silent.
fn instructions_change_note(before: &Option<String>, after: &Option<String>) -> Option<String> {
    if before == after {
        return None;
    }
    Some(match after {
        None => "Your TagMails instructions were cleared during this run.".into(),
        Some(text) => {
            let text = text.trim();
            let shown: String = text.chars().take(200).collect();
            let more = if text.chars().count() > 200 { "…" } else { "" };
            format!("Your TagMails instructions changed during this run. They now read: \"{shown}{more}\"")
        }
    })
}

fn found(program: &str) -> String {
    let output = Command::new("sh")
        .arg("-c")
        .arg(format!("command -v {program}"))
        .output();
    match output {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).trim().to_owned()
        }
        _ => "not found".into(),
    }
}

fn command_status() -> Result<(), Box<dyn Error>> {
    let config = load_config();
    let relay = configured_relay(&config);
    let token = read_token(&paths::token_file());
    let connection = match &token {
        Err(_) => "not paired (run `tagmails pair <code>`)".to_owned(),
        Ok(token) => {
            let client = Client::builder().timeout(Duration::from_secs(10)).build()?;
            match device_is_paired(&client, &relay, token) {
                Ok(true) => "paired".into(),
                Ok(false) => "token revoked; create a new pairing code".into(),
                Err(error) => format!("relay unreachable ({error})"),
            }
        }
    };
    let projects = fs::read(paths::projects_file())
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| value["projects"].as_array().map(Vec::len));
    println!("TagMails {VERSION}");
    println!("  Connection  {connection}");
    println!("  Relay       {relay}");
    println!("  Service     {}", service::status());
    let access = legacy_capped(config["access"].as_str().unwrap_or(DEFAULT_ACCESS), config["maxAccess"].as_str(),
        &["read", "write", "full"]);
    let claude = legacy_capped(config["claudePermission"].as_str().unwrap_or(DEFAULT_CLAUDE_PERMISSION),
        config["maxClaudePermission"].as_str(), &["readonly", "manual", "acceptEdits", "auto", "bypassPermissions"]);
    let recommended = if (access, claude) == (DEFAULT_ACCESS, DEFAULT_CLAUDE_PERMISSION) { " (recommended)" } else { "" };
    println!("  Access      Codex {access}, Claude {claude}{recommended}");
    if config["workspace"].is_null() {
        println!("  Routing     {} context", config["routingContext"].as_str().unwrap_or("full"));
    }
    match config["workspace"].as_str() {
        Some(workspace) => println!("  Workspace   {workspace}"),
        None => println!(
            "  Workspace   chosen per email from {} project folders",
            projects.map_or("(not yet listed)".into(), |count| count.to_string())
        ),
    }
    let defaults = &effective_defaults(&config);
    if defaults.is_object() {
        let part = |key: &str| defaults[key].as_str().unwrap_or("-").to_owned();
        let source = if paths::email_defaults_file().exists() { " (set by email)" } else { "" };
        println!("  Default     {} {} {}{source}", part("model"), part("effort"), part("speed"));
    }
    if let Some(problem) = codex_sandbox_problem(config["access"].as_str().unwrap_or(DEFAULT_ACCESS)) {
        println!("  Warning     {problem}");
    }
    println!("  Reactions   {}", if reactions_choice() == Some(true) { "on (Gmail 👀 and ✅)" } else { "off" });
    if let Some(text) = owner_instructions() {
        println!("  Instructions {} characters ({})", text.trim().chars().count(), paths::email_instructions_file().display());
    }
    println!("  Config      {}", paths::config_file().display());
    println!(
        "  Adapters    {}",
        paths::adapters_dir().map_or_else(|error| error, |dir| dir.display().to_string())
    );
    for program in ["node", "codex", "claude"] {
        println!("  {program:<11} {}", found(program));
    }
    println!("  Logs        {}", service::log_hint());
    Ok(())
}

/// Find an email thread's local agent session and resume it in the matching
/// CLI. Sessions live in TagMails' own agent homes, separate from yours.
fn command_open(args: &[String]) -> Result<(), Box<dyn Error>> {
    let thread = args.get(1).ok_or("Pass the thread ID shown on the run page")?;
    let base = paths::home().join(".tagmails");
    let stores = [
        ("codex", base.join("codex-readonly")),
        ("codex", base.join("codex-write")),
        ("codex", base.join("codex-full")),
        ("claude", base.clone()),
    ];
    for (tool, home) in stores {
        let files: Vec<PathBuf> = if tool == "codex" {
            vec![home.join("sessions.json")]
        } else {
            vec![home.join("claude-sessions.json"), home.join("claude-write-sessions.json")]
        };
        for file in files {
            let Some(store) = fs::read(&file)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            else {
                continue;
            };
            let entry = &store["threads"][thread.as_str()];
            let (Some(session), Some(workspace)) =
                (entry["sessionId"].as_str(), entry["workspace"].as_str())
            else {
                continue;
            };
            println!("Opening {tool} session {session} in {workspace}");
            let mut command = Command::new(tool);
            command.current_dir(workspace);
            if tool == "codex" {
                command.env("CODEX_HOME", &home).args(["resume", session]);
            } else {
                command.args(["--resume", session]);
            }
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                return Err(command.exec().into());
            }
            #[cfg(not(unix))]
            {
                command.status()?;
                return Ok(());
            }
        }
    }
    Err(format!("No local session for thread {thread} on this machine.").into())
}

fn command_logs() -> Result<(), Box<dyn Error>> {
    let mut command = if service::logs_in_files() {
        let mut tail = Command::new("tail");
        tail.args(["-n", "100", "-F"])
            .arg(paths::log_dir().join("tagmails.log"))
            .arg(paths::log_dir().join("tagmails.error.log"));
        tail
    } else {
        let mut journal = Command::new("journalctl");
        journal.args(["--user", "-u", "tagmails", "-n", "100", "-f"]);
        journal
    };
    command.status()?;
    Ok(())
}

#[cfg(unix)]
extern "C" {
    fn signal(signum: i32, handler: usize) -> usize;
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    // `tagmails status | head` should end quietly, as other CLIs do. The
    // service keeps Rust's default so a closed socket is an error, not an exit.
    #[cfg(unix)]
    if args.first().map(String::as_str) != Some("run") {
        // SIGPIPE is 13 on macOS and Linux; 0 is SIG_DFL.
        unsafe { signal(13, 0) };
    }
    let result = match args.first().map(String::as_str) {
        Some("pair") => command_pair(&args),
        Some("start") => command_start(&args),
        Some("set") => set_email_defaults(&args).map(|message| println!("{message}")),
        Some("stop") => service::stop().map(|message| println!("{message}")),
        Some("status") => command_status(),
        Some("logs") => command_logs(),
        Some("open") => command_open(&args),
        Some("uninstall") => service::uninstall().map(|message| println!("{message}")),
        Some("run") => settings_from_config()
            .and_then(|settings| run_relay(&settings, args.iter().any(|arg| arg == "--once"), true)),
        Some("--version" | "-V" | "version") => {
            println!("tagmails {VERSION}");
            Ok(())
        }
        Some("--help" | "-h" | "help") => {
            println!("{HELP}");
            Ok(())
        }
        // Pilot installs and smoke scripts configure everything through the
        // environment; keep that interface working.
        _ if env::var("TAGMAILS_RELAY_URL").is_ok() => legacy_relay(&args),
        _ if env::var("TAGMAILS_LAB_URL").is_ok() || args.iter().any(|arg| arg == "--once") => run_lab(),
        None => {
            println!("{HELP}");
            Ok(())
        }
        Some(other) => Err(format!("Unknown command `{other}`. Run `tagmails --help`.").into()),
    };
    if let Err(error) = result {
        eprintln!("tagmails: {error}");
        std::process::exit(1);
    }
}

fn legacy_relay(args: &[String]) -> Result<(), Box<dyn Error>> {
    let base = env::var("TAGMAILS_RELAY_URL")?;
    let token_file = PathBuf::from(env::var("TAGMAILS_DEVICE_TOKEN_FILE")?);
    if let Some(index) = args.iter().position(|arg| arg == "--pair") {
        let code = args.get(index + 1).ok_or("Pass a pairing code after --pair")?;
        let name = env::var("TAGMAILS_DEVICE_NAME").unwrap_or_else(|_| "Mac".into());
        return pair_relay(&base, code, &token_file, &name, None);
    }
    let once = args.iter().any(|arg| arg == "--once");
    if once == args.iter().any(|arg| arg == "--watch") {
        return Err("Relay mode requires exactly one of --once or --watch".into());
    }
    let settings = Settings {
        relay: base,
        token: read_token(&token_file)?,
        access: env::var("TAGMAILS_WORKSPACE_ACCESS").unwrap_or_else(|_| "read".into()),
        workspace: Some(PathBuf::from(env::var("TAGMAILS_WORKSPACE")?)),
        routing_context: "files".into(),
        claude_permission: match env::var("TAGMAILS_WORKSPACE_ACCESS").as_deref() {
            Ok("write") => "acceptEdits".into(),
            _ => "readonly".into(),
        },
    };
    run_relay(&settings, once, false)
}
