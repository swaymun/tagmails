use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
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
mod service;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_RELAY: &str = "https://tagmails-relay-dev.saimun-shahee.workers.dev";

/// What a relay watcher needs. `workspace: None` means project routing: the
/// relay picks one of this machine's published projects (or a scratch folder)
/// for each new email thread.
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
            .env("TAGMAILS_DEVICE_TOKEN_FILE", token_file);
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
    // Defaults set with `tagmails start --model/--effort/--speed`. A default
    // saved on the website overrides them.
    let config = load_config();
    let defaults = &config["defaults"];
    if defaults.is_object() {
        catalog["defaults"] = defaults.clone();
    }
    // The most this machine allows (everything, unless locked with
    // --max-access / --max-claude-permission); a website choice is capped here.
    catalog["limits"] = json!({
        "access": max_access(&config),
        "claudePermission": max_claude_permission(&config),
        "defaultAccess": config["access"].as_str().unwrap_or("read"),
        "defaultClaudePermission": config["claudePermission"].as_str().unwrap_or("acceptEdits"),
    });
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

fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), Box<dyn Error>> {
    let temporary = path.with_extension("tmp");
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    options.mode(0o600);
    options.open(&temporary)?.write_all(bytes)?;
    fs::rename(temporary, path)?;
    Ok(())
}

/// Resolve the folder for a claimed job. A fixed workspace always wins. With
/// project routing, the relay's choice must be a folder this machine published;
/// anything else runs in a private per-thread scratch folder.
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
    let scratch = paths::scratch_dir().join(thread);
    create_private_dir(&scratch)?;
    Ok(scratch.canonicalize()?)
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

fn pair_relay(base: &str, code: &str, path: &Path, name: &str) -> Result<(), Box<dyn Error>> {
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
        .json(&json!({"code":code,"token":token,"name":name.trim()}))
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

fn workspace_file_bytes(workspace: &Path, name: &str) -> Result<Vec<u8>, Box<dyn Error>> {
    const MAX_FILE_BYTES: u64 = 24_000_000;
    let root = workspace.canonicalize()?;
    let source = root.join(name).canonicalize()?;
    if !source.starts_with(&root) || !source.is_file() {
        return Err("Requested file is outside the selected workspace or is not a file".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(source)?
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("Requested file is empty or exceeds 24 MB".into());
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
    if let Some(summary) = result["summary"].as_str() {
        lines.push(summary.to_owned());
    }
    for field in ["details", "checks"] {
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
    let response: Value = client
        .post(format!(
            "{}/api/device/artifacts?jobId={job_id}&leaseId={lease_id}",
            base.trim_end_matches('/')
        ))
        .bearer_auth(token)
        .header("Content-Type", mime_type)
        .header("Content-Length", bytes.len().to_string())
        .header("X-TagMails-Filename", filename)
        .header("X-TagMails-Upload-Id", upload_id)
        .body(bytes)
        .send()?
        .error_for_status()?
        .json()?;
    if response["id"] != upload_id {
        return Err("Relay returned a different file ID".into());
    }
    Ok(())
}

/// The website's choice when it is within this machine's maximum, otherwise
/// the machine's own default (from `tagmails start --access ...`), never
/// above the maximum.
fn chosen<'a>(choice: Option<&'a str>, default: &'a str, max: &'a str, order: &[&'a str]) -> &'a str {
    let rank = |value: &str| order.iter().position(|item| *item == value);
    let top = rank(max).unwrap_or(order.len() - 1);
    match choice {
        Some(choice) if rank(choice).is_some_and(|wanted| wanted <= top) => choice,
        _ if rank(default).is_some_and(|value| value <= top) => default,
        _ => order[top],
    }
}

fn max_access(config: &Value) -> &str {
    config["maxAccess"].as_str().filter(|value| ACCESS_ORDER.contains(value)).unwrap_or("full")
}

fn max_claude_permission(config: &Value) -> &str {
    config["maxClaudePermission"].as_str().filter(|value| CLAUDE_ORDER.contains(value)).unwrap_or("bypassPermissions")
}

const ACCESS_ORDER: [&str; 3] = ["read", "write", "full"];
const CLAUDE_ORDER: [&str; 5] = ["readonly", "manual", "acceptEdits", "auto", "bypassPermissions"];

fn relay_iteration(client: &Client, settings: &Settings) -> Result<bool, Box<dyn Error>> {
    let base = settings.relay.as_str();
    let token = settings.token.as_str();
    let response = relay_post(client, base, "/api/device/claim", token, json!({}))?;
    if response["claimed"] != true {
        return Ok(false);
    }
    let mut claim = verified_claim(&response, token)?;
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
    let config = load_config();
    let access = chosen(claim["permissions"]["codexAccess"].as_str(), settings.access.as_str(),
        max_access(&config), &ACCESS_ORDER).to_owned();
    let access = access.as_str();
    let claude_permission = chosen(
        claim["permissions"]["claudePermission"].as_str(),
        settings.claude_permission.as_str(),
        max_claude_permission(&config),
        &CLAUDE_ORDER,
    )
    .to_owned();
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
            if let Err(error) = relay_post(
                client,
                base,
                "/api/device/started",
                token,
                json!({"jobId":job_id,"leaseId":lease_id}),
            ) {
                eprintln!("Status reaction could not be queued: {error}");
            }
            relay_result(&claim, base, access, &claude_permission, workspace)?
        }
    };
    if result["state"] == "completed" && wants_answer_file(&claim) {
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
            let mut skipped = Vec::new();
            for (name, required) in names {
                let bytes = if valid_workspace_name(&name) {
                    workspace_file_bytes(workspace, &name)
                } else {
                    Err("not a simple relative path".into())
                };
                let filename = Path::new(&name).file_name().and_then(|value| value.to_str()).unwrap_or("file");
                let id = upload_id(&lease_id, ids.len());
                let uploaded = bytes.and_then(|bytes| {
                    upload_file(client, base, token, &job_id, &lease_id, &id, filename, workspace_file_type(filename), bytes)
                });
                match uploaded {
                    Ok(()) => ids.push(id),
                    Err(error) if required => {
                        eprintln!("Requested file could not be exported: {error}");
                        result["state"] = json!("failed");
                        result["summary"] = json!("The requested file was missing, empty, outside the selected workspace, or over 24 MB.");
                        result["checks"] = json!(["No file was uploaded. Local edits from this turn may remain."]);
                        ids.clear();
                        break;
                    }
                    Err(error) => {
                        eprintln!("{name} could not be attached: {error}");
                        skipped.push(name);
                    }
                }
            }
            if !ids.is_empty() {
                result["artifactIds"] = json!(ids);
            }
            if !skipped.is_empty() {
                if let Some(checks) = result["checks"].as_array_mut() {
                    checks.push(json!(format!("Could not attach: {}", skipped.join(", "))));
                }
            }
        }
    }
    if let Some(object) = result.as_object_mut() {
        object.remove("attach");
    }
    let completion = relay_post(
        client,
        base,
        "/api/device/complete",
        token,
        json!({"jobId":job_id,"leaseId":lease_id,"result":result}),
    )?;
    if completion["completed"] != true {
        return Err("Relay did not acknowledge the completion".into());
    }
    println!(
        "{job_id}: {} result stored in the relay",
        result["state"].as_str().unwrap_or("unknown")
    );
    Ok(true)
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

fn run_relay(settings: &Settings, once: bool) -> Result<(), Box<dyn Error>> {
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
    let probe_folder = match &settings.workspace {
        Some(workspace) => workspace.clone(),
        None => {
            create_private_dir(&paths::scratch_dir())?;
            paths::scratch_dir()
        }
    };
    if settings.workspace.is_some() {
        // A pinned machine must not keep receiving project choices from an
        // earlier routing session.
        if let Err(error) = relay_post(
            &client,
            &settings.relay,
            "/api/device/projects",
            &settings.token,
            json!({"projects":[]}),
        ) {
            eprintln!("Could not clear the published project list: {error}");
        }
    }
    let mut next_model_probe = Instant::now();
    let mut next_project_probe = Instant::now();
    loop {
        if Instant::now() >= next_model_probe {
            next_model_probe = Instant::now() + Duration::from_secs(120);
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
        let claimed = match relay_iteration(&client, settings) {
            Ok(false) if once => {
                println!("No queued relay mail.");
                false
            }
            Ok(claimed) => claimed,
            Err(error) if once => return Err(error),
            Err(error) => {
                eprintln!("Relay unavailable: {error}");
                false
            }
        };
        if once {
            return Ok(());
        }
        if !claimed {
            thread::sleep(Duration::from_secs(15));
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn website_permissions_never_exceed_the_machine_limit() {
        // By default every level is allowed; the website picks, else the start flag.
        assert_eq!(chosen(Some("full"), "write", "full", &ACCESS_ORDER), "full");
        assert_eq!(chosen(None, "write", "full", &ACCESS_ORDER), "write");
        assert_eq!(chosen(Some("bogus"), "read", "full", &ACCESS_ORDER), "read");
        assert_eq!(chosen(Some("bypassPermissions"), "acceptEdits", "bypassPermissions", &CLAUDE_ORDER), "bypassPermissions");
        // A machine locked with --max-access never goes above it.
        assert_eq!(chosen(Some("full"), "write", "write", &ACCESS_ORDER), "write");
        assert_eq!(chosen(None, "full", "write", &ACCESS_ORDER), "write");
        assert_eq!(max_access(&json!({})), "full");
        assert_eq!(max_claude_permission(&json!({"maxClaudePermission": "auto"})), "auto");
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
        assert!(pair_relay(&base, &code, &file, "Mac").is_ok());
        let original = fs::read_to_string(&file).unwrap();
        assert!(valid_device_token(original.trim()));
        assert!(pair_relay(&base, &code, &file, "Mac").is_ok());
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
        assert_eq!(
            workspace_file_bytes(&workspace, "inside.txt").unwrap(),
            b"safe"
        );
        assert!(workspace_file_bytes(&workspace, "../outside.txt").is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("outside.txt"), workspace.join("link.txt"))
                .unwrap();
            assert!(workspace_file_bytes(&workspace, "link.txt").is_err());
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
        let scratch = job_workspace(&settings, &claim(json!({"kind":"scratch"}))).unwrap();
        assert!(scratch.ends_with("scratch/thread-1"));
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
                 [--max-access read|write|full]
                 [--max-claude-permission manual|accept-edits|auto|bypass]
                                                   Save settings and run in the background
  tagmails status                                  Show settings, connection and service state
  tagmails stop                                    Stop the background service
  tagmails logs                                    Follow the service log
  tagmails open <thread-id>                        Open an email thread's agent session
  tagmails run [--once]                            Run in the foreground (what the service runs)
  tagmails uninstall                               Remove the background service
  tagmails --version

--access and --claude-permission set this machine's default permission. Permissions
chosen on tagmails.com override it, up to --max-access / --max-claude-permission
(everything by default).

--model, --effort and --speed set this machine's default for emails that don't ask for
one; a default saved on tagmails.com overrides them.

Pairing codes come from https://tagmails.com/setup. By default TagMails picks one of
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

fn load_config() -> Value {
    fs::read(paths::config_file())
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
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
    let config = load_config();
    Ok(Settings {
        relay: configured_relay(&config),
        token: read_token(&paths::token_file())?,
        access: config["access"].as_str().unwrap_or("read").to_owned(),
        workspace: config["workspace"].as_str().map(PathBuf::from),
        routing_context: config["routingContext"].as_str().unwrap_or("full").to_owned(),
        claude_permission: config["claudePermission"].as_str().unwrap_or("acceptEdits").to_owned(),
    })
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
    let mut config = load_config();
    let relay = option(args, "--relay")?.unwrap_or_else(|| configured_relay(&config));
    let name = option(args, "--name")?.unwrap_or_else(default_device_name);
    create_private_dir(&paths::config_dir())?;
    pair_relay(&relay, code, &paths::token_file(), &name)?;
    config["relay"] = json!(relay);
    config["deviceName"] = json!(name);
    save_config(&config)?;
    println!("Next: tagmails start");
    Ok(())
}

fn command_start(args: &[String]) -> Result<(), Box<dyn Error>> {
    let mut config = load_config();
    read_token(&paths::token_file())?;
    if let Some(access) = option(args, "--access")? {
        if !["read", "write", "full"].contains(&access.as_str()) {
            return Err("--access must be read, write, or full".into());
        }
        config["access"] = json!(access);
    }
    if config["access"].is_null() {
        config["access"] = json!("read");
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
    }
    if let Some(max) = option(args, "--max-access")? {
        if !ACCESS_ORDER.contains(&max.as_str()) {
            return Err("--max-access must be read, write, or full".into());
        }
        config["maxAccess"] = json!(max);
    }
    if let Some(max) = option(args, "--max-claude-permission")? {
        let mode = match max.as_str() {
            "manual" => "manual",
            "accept-edits" | "acceptEdits" => "acceptEdits",
            "auto" => "auto",
            "bypass" | "bypassPermissions" => "bypassPermissions",
            _ => return Err("--max-claude-permission must be manual, accept-edits, auto or bypass".into()),
        };
        config["maxClaudePermission"] = json!(mode);
    }
    if let Some(context) = option(args, "--routing-context")? {
        if !["full", "files"].contains(&context.as_str()) {
            return Err("--routing-context must be full or files".into());
        }
        config["routingContext"] = json!(context);
    }
    let mut defaults = config["defaults"].as_object().cloned().unwrap_or_default();
    if let Some(model) = option(args, "--model")? {
        let valid = !model.is_empty()
            && model.len() <= 80
            && model.chars().all(|c| c.is_ascii_alphanumeric() || "-._".contains(c));
        if !valid {
            return Err("--model must be a model id such as gpt-6-sol or claude-sonnet-5-5".into());
        }
        defaults.insert("model".into(), json!(model));
    }
    if let Some(effort) = option(args, "--effort")? {
        if !["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].contains(&effort.as_str()) {
            return Err("--effort must be none, minimal, low, medium, high, xhigh, max or ultra".into());
        }
        defaults.insert("effort".into(), json!(effort));
    }
    if let Some(speed) = option(args, "--speed")? {
        if !["standard", "fast", "ultrafast"].contains(&speed.as_str()) {
            return Err("--speed must be standard, fast or ultrafast".into());
        }
        defaults.insert("speed".into(), json!(speed));
    }
    if args.iter().any(|arg| arg == "--clear-defaults") {
        defaults.clear();
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
    config["relay"] = json!(configured_relay(&config));
    save_config(&config)?;
    paths::adapters_dir()?;
    println!("{}", service::start(&service_binary()?)?);
    match config["workspace"].as_str() {
        Some(workspace) => println!("Access: {} in {workspace}", config["access"].as_str().unwrap_or("read")),
        None => println!(
            "Access: {} in the project folder chosen for each email (or a private scratch folder).",
            config["access"].as_str().unwrap_or("read")
        ),
    }
    println!("Send an email to your agent address to try it.");
    Ok(())
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
    println!("  Access      Codex {}, Claude {}", config["access"].as_str().unwrap_or("read"),
        config["claudePermission"].as_str().unwrap_or("acceptEdits"));
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
    let defaults = &config["defaults"];
    if defaults.is_object() {
        let part = |key: &str| defaults[key].as_str().unwrap_or("-").to_owned();
        println!("  Default     {} {} {} (tagmails.com overrides)", part("model"), part("effort"), part("speed"));
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
    let mut command = if cfg!(target_os = "macos") {
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

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("pair") => command_pair(&args),
        Some("start") => command_start(&args),
        Some("stop") => service::stop().map(|message| println!("{message}")),
        Some("status") => command_status(),
        Some("logs") => command_logs(),
        Some("open") => command_open(&args),
        Some("uninstall") => service::uninstall().map(|message| println!("{message}")),
        Some("run") => settings_from_config()
            .and_then(|settings| run_relay(&settings, args.iter().any(|arg| arg == "--once"))),
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
        return pair_relay(&base, code, &token_file, &name);
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
    run_relay(&settings, once)
}
