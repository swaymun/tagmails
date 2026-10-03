use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use reqwest::blocking::Client;
use ring::hmac;
use serde_json::{json, Value};
use std::env;
use std::error::Error;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

fn post(client: &Client, base: &str, path: &str, body: Value) -> Result<Value, Box<dyn Error>> {
    let response = client
        .post(format!("{base}{path}"))
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
        "codex-readonly" => "codex-runner.mjs",
        "claude-readonly" => "claude-runner.mjs",
        _ => return Err("Unsupported local agent runtime".into()),
    };
    let runner = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/mock-inbox")
        .join(file);
    let mut child = Command::new("node")
        .arg(runner)
        .env("TAGMAILS_LAB_URL", base)
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

fn relay_post(
    client: &Client,
    base: &str,
    path: &str,
    token: &str,
    body: Value,
) -> Result<Value, Box<dyn Error>> {
    let response = client
        .post(format!("{base}{path}"))
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

fn run_relay_once(base: &str) -> Result<(), Box<dyn Error>> {
    if !env::args().any(|arg| arg == "--once") {
        return Err("Relay prototype requires --once".into());
    }
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
    let response = relay_post(&client, base, "/api/device/claim", token, json!({}))?;
    if response["claimed"] != true {
        println!("No queued relay mail.");
        return Ok(());
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
    let model = claim["model"]["id"].as_str().unwrap_or("");
    let runtime = if model.starts_with("gpt-") {
        "codex-readonly"
    } else if model.starts_with("claude-") {
        "claude-readonly"
    } else {
        return Err("Relay claim has an unsupported model".into());
    };
    claim["claimId"] = json!(lease_id);
    claim["claimed"] = json!(true);
    let result = match agent_result(&claim, base, runtime) {
        Ok(result) => result,
        Err(error) => {
            eprintln!("Local agent adapter failed: {error}");
            json!({"runtime":format!("{}-cli-readonly", runtime.split('-').next().unwrap_or("agent")),"state":"failed","summary":"The local agent adapter could not complete this turn."})
        }
    };
    let completion = relay_post(
        &client,
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
    Ok(())
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
}

fn main() -> Result<(), Box<dyn Error>> {
    if let Ok(base) = env::var("TAGMAILS_RELAY_URL") {
        return run_relay_once(&base);
    }
    let base = env::var("TAGMAILS_LAB_URL").unwrap_or_else(|_| "http://127.0.0.1:4177".into());
    let url = reqwest::Url::parse(&base)?;
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") || url.port().is_none() {
        return Err("This prototype connects only to an explicit 127.0.0.1 HTTP lab port".into());
    }
    let once = env::args().any(|arg| arg == "--once");
    let runtime = env::var("TAGMAILS_RUNTIME").unwrap_or_else(|_| "mock".into());
    if runtime != "mock" && runtime != "codex-readonly" && runtime != "claude-readonly" {
        return Err("TAGMAILS_RUNTIME must be mock, codex-readonly, or claude-readonly".into());
    }
    let selected_job = if runtime != "mock" {
        if !once {
            return Err("Read-only agent prototypes require --once".into());
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
                            json!({"runtime":format!("{}-cli-readonly", runtime.split('-').next().unwrap_or("agent")),"state":"failed","summary":"The local agent adapter could not complete this turn."})
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
