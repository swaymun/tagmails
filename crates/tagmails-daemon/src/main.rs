use reqwest::blocking::Client;
use serde_json::{json, Value};
use std::env;
use std::error::Error;
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

fn codex_result(claim: &Value, base: &str) -> Result<Value, Box<dyn Error>> {
    let runner =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/mock-inbox/codex-runner.mjs");
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
        .ok_or("Codex adapter stdin unavailable")?
        .write_all(claim.to_string().as_bytes())?;
    let output = child.wait_with_output()?;
    if !output.status.success() {
        return Err("Codex adapter process failed".into());
    }
    let result: Value = serde_json::from_slice(&output.stdout)?;
    Ok(result)
}

fn main() -> Result<(), Box<dyn Error>> {
    let base = env::var("TAGMAILS_LAB_URL").unwrap_or_else(|_| "http://127.0.0.1:4177".into());
    let url = reqwest::Url::parse(&base)?;
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") || url.port().is_none() {
        return Err("This prototype connects only to an explicit 127.0.0.1 HTTP lab port".into());
    }
    let once = env::args().any(|arg| arg == "--once");
    let runtime = env::var("TAGMAILS_RUNTIME").unwrap_or_else(|_| "mock".into());
    if runtime != "mock" && runtime != "codex-readonly" {
        return Err("TAGMAILS_RUNTIME must be mock or codex-readonly".into());
    }
    let selected_job = if runtime == "codex-readonly" {
        if !once {
            return Err("Codex read-only prototype requires --once".into());
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
                let result = if runtime == "codex-readonly" {
                    match codex_result(&claim, &base) {
                        Ok(result) => result,
                        Err(error) => {
                            eprintln!("Local Codex adapter failed: {error}");
                            json!({"runtime":"codex-cli-readonly","state":"failed","summary":"The local Codex adapter could not complete this turn."})
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
