use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use reqwest::blocking::Client;
use ring::hmac;
use ring::rand::{SecureRandom, SystemRandom};
use serde_json::{json, Value};
use std::env;
use std::error::Error;
use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

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

fn agent_result(claim: &Value, base: &str, runtime: &str) -> Result<Value, Box<dyn Error>> {
    let file = match runtime {
        "codex-readonly" | "codex-write" => "codex-runner.mjs",
        "claude-readonly" => "claude-runner.mjs",
        _ => return Err("Unsupported local agent runtime".into()),
    };
    let runner = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/mock-inbox")
        .join(file);
    let mut child = Command::new("node")
        .arg(runner)
        .env("TAGMAILS_LAB_URL", base)
        .env("TAGMAILS_RUNTIME", runtime)
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
    if !output.status.success() {
        return Err("Local agent adapter process failed".into());
    }
    let result: Value = serde_json::from_slice(&output.stdout)?;
    Ok(result)
}

fn runtime_label(runtime: &str) -> &'static str {
    match runtime {
        "codex-write" => "codex-app-server-write",
        "codex-readonly" => "codex-app-server-readonly",
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

fn pair_relay(base: &str, code: &str) -> Result<(), Box<dyn Error>> {
    validate_relay_base(base)?;
    if !code.starts_with("tm_pair_")
        || code.len() != 35
        || !code[8..]
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("Pairing code is invalid".into());
    }
    let token_file = env::var("TAGMAILS_DEVICE_TOKEN_FILE")?;
    let path = Path::new(&token_file);
    if !path.is_absolute() {
        return Err("TAGMAILS_DEVICE_TOKEN_FILE must be absolute".into());
    }
    let name = env::var("TAGMAILS_DEVICE_NAME").unwrap_or_else(|_| "Mac".into());
    if name.trim().is_empty() || name.len() > 80 {
        return Err("TAGMAILS_DEVICE_NAME must be 1-80 characters".into());
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
    let client = Client::builder().timeout(Duration::from_secs(10)).build()?;
    let response = client
        .post(format!("{}/api/device/pair", base.trim_end_matches('/')))
        .json(&json!({"code":code,"token":token,"name":name.trim()}))
        .send()
        .map_err(|error| {
            format!("Pairing could not be confirmed; token file kept for recovery: {error}")
        })?;
    if response.status().is_client_error() {
        fs::remove_file(path)?;
        return Err(format!(
            "Pairing was rejected ({}); token file removed",
            response.status()
        )
        .into());
    }
    let response = response
        .error_for_status()
        .map_err(|error| {
            format!("Pairing could not be confirmed; token file kept for recovery: {error}")
        })?
        .json::<Value>()?;
    if response["paired"] != true {
        return Err("Relay did not confirm the device pairing".into());
    }
    println!("Device paired. Token saved at {token_file}.");
    Ok(())
}

fn relay_result(claim: &Value, base: &str) -> Result<Value, Box<dyn Error>> {
    if let Some(error) = claim["model"]["error"].as_str() {
        return Ok(
            json!({"runtime":"tagmails-router","state":"needs_clarification","summary":error}),
        );
    }
    let model = claim["model"]["id"].as_str().unwrap_or("");
    let runtime = if model.starts_with("gpt-") {
        "codex-readonly"
    } else if model.starts_with("claude-") {
        "claude-readonly"
    } else {
        return Err("Relay claim has an unsupported model".into());
    };
    Ok(match agent_result(claim, base, runtime) {
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

fn upload_answer_file(
    client: &Client,
    base: &str,
    token: &str,
    job_id: &str,
    lease_id: &str,
    result: &Value,
) -> Result<(), Box<dyn Error>> {
    let bytes = answer_file(result);
    let response: Value = client
        .post(format!(
            "{}/api/device/artifacts?jobId={job_id}&leaseId={lease_id}",
            base.trim_end_matches('/')
        ))
        .bearer_auth(token)
        .header("Content-Type", "text/plain")
        .header("Content-Length", bytes.len().to_string())
        .header("X-TagMails-Filename", "answer.txt")
        .header("X-TagMails-Upload-Id", lease_id)
        .body(bytes)
        .send()?
        .error_for_status()?
        .json()?;
    if response["id"] != lease_id {
        return Err("Relay returned a different answer file ID".into());
    }
    Ok(())
}

fn relay_iteration(client: &Client, base: &str, token: &str) -> Result<bool, Box<dyn Error>> {
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
    let mut result = relay_result(&claim, base)?;
    if result["state"] == "completed" && wants_answer_file(&claim) {
        upload_answer_file(client, base, token, &job_id, &lease_id, &result)?;
        result["artifactIds"] = json!([lease_id]);
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

fn run_relay(base: &str) -> Result<(), Box<dyn Error>> {
    let once = env::args().any(|arg| arg == "--once");
    let watch = env::args().any(|arg| arg == "--watch");
    if once == watch {
        return Err("Relay mode requires exactly one of --once or --watch".into());
    }
    validate_relay_base(base)?;
    let workspace = env::var("TAGMAILS_WORKSPACE")?;
    if !Path::new(&workspace).is_absolute() || !Path::new(&workspace).is_dir() {
        return Err("TAGMAILS_WORKSPACE must be an existing absolute directory".into());
    }
    let token_file = env::var("TAGMAILS_DEVICE_TOKEN_FILE")?;
    if !Path::new(&token_file).is_absolute() {
        return Err("TAGMAILS_DEVICE_TOKEN_FILE must be absolute".into());
    }
    let token_data = fs::read_to_string(token_file)?;
    let token = token_data.trim();
    if !token.starts_with("tm_dev_")
        || token.len() != 50
        || !token[7..]
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("Device token file is invalid".into());
    }
    let client = Client::builder().timeout(Duration::from_secs(10)).build()?;
    if watch {
        println!("TagMails relay watching {base}. Press Ctrl-C to stop.");
    }
    loop {
        let claimed = match relay_iteration(&client, base, token) {
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
            thread::sleep(Duration::from_secs(30));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn relay_unknown_model_requests_clarification_without_running_an_agent() {
        let result = relay_result(
            &json!({"model":{"error":"Use Codex, Claude, or Luna."}}),
            "unused",
        )
        .unwrap();
        assert_eq!(result["state"], "needs_clarification");
        assert_eq!(result["summary"], "Use Codex, Claude, or Luna.");
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
}

fn main() -> Result<(), Box<dyn Error>> {
    if let Ok(base) = env::var("TAGMAILS_RELAY_URL") {
        let args: Vec<String> = env::args().collect();
        if let Some(index) = args.iter().position(|arg| arg == "--pair") {
            let code = args
                .get(index + 1)
                .ok_or("Pass a pairing code after --pair")?;
            return pair_relay(&base, code);
        }
        return run_relay(&base);
    }
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
        && runtime != "claude-readonly"
    {
        return Err(
            "TAGMAILS_RUNTIME must be mock, codex-readonly, codex-write, or claude-readonly".into(),
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
                    match agent_result(&claim, &base, &runtime) {
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
