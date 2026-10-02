use reqwest::blocking::Client;
use serde_json::{json, Value};
use std::env;
use std::error::Error;
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

fn mock_result(claim: &Value) -> Value {
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
    json!({
        "state": "completed",
        "summary": summary,
        "details": [format!("Selected route: {model} ({effort})."), "The local Rust process claimed this queued email and returned a structured result."],
        "checks": ["No model was called and no files changed in this prototype."]
    })
}

fn main() -> Result<(), Box<dyn Error>> {
    let base = env::var("TAGMAILS_LAB_URL").unwrap_or_else(|_| "http://127.0.0.1:4177".into());
    let url = reqwest::Url::parse(&base)?;
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") || url.port().is_none() {
        return Err("This prototype connects only to an explicit 127.0.0.1 HTTP lab port".into());
    }
    let once = env::args().any(|arg| arg == "--once");
    let client = Client::builder().timeout(Duration::from_secs(10)).build()?;
    println!("TagMails Rust mock daemon polling {base}. Press Ctrl-C to stop.");
    loop {
        match post(&client, &base, "/api/claim", json!({})) {
            Ok(claim) if claim["claimed"] == true => {
                let result = mock_result(&claim);
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
