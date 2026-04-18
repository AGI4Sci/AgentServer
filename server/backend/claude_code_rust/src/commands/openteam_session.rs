use crate::config::Settings;
use crate::error::Result;
use crate::state::AppState;
use serde::Deserialize;
use serde_json::json;
use std::io::{self, BufRead, Write};

#[derive(Debug, Deserialize)]
struct SessionRequest {
    #[serde(rename = "type")]
    request_type: String,
    request_id: String,
    prompt: Option<String>,
    cwd: Option<String>,
    model: Option<String>,
}

pub async fn run(settings: Settings, state: AppState) -> Result<()> {
    emit(&json!({
        "type": "system",
        "subtype": "ready",
        "message": "Claude Code Rust OpenTeam session ready"
    }))?;

    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = line?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        match serde_json::from_str::<SessionRequest>(trimmed) {
            Ok(request) => {
                if request.request_type == "shutdown" {
                    emit(&json!({
                        "type": "result",
                        "request_id": request.request_id,
                        "output": {
                            "success": true,
                            "result": "Claude Code Rust session shutting down"
                        }
                    }))?;
                    break;
                }

                if request.request_type != "run" {
                    emit(&json!({
                        "type": "result",
                        "request_id": request.request_id,
                        "output": {
                            "success": false,
                            "error": format!("Unsupported request type: {}", request.request_type)
                        }
                    }))?;
                    continue;
                }

                emit(&json!({
                    "type": "status",
                    "request_id": request.request_id,
                    "status": "running",
                    "message": "Claude Code Rust request in progress"
                }))?;

                let prompt = request.prompt.unwrap_or_default();
                match crate::commands::query::execute(
                    prompt,
                    settings.clone(),
                    state.clone(),
                    request.cwd,
                    request.model,
                    true,
                ).await {
                    Ok(output) => {
                        emit(&json!({
                            "type": "result",
                            "request_id": request.request_id,
                            "output": {
                                "success": true,
                                "result": output
                            }
                        }))?;
                    }
                    Err(error) => {
                        emit(&json!({
                            "type": "result",
                            "request_id": request.request_id,
                            "output": {
                                "success": false,
                                "error": error.to_string()
                            }
                        }))?;
                    }
                }
            }
            Err(error) => {
                emit(&json!({
                    "type": "result",
                    "request_id": "invalid",
                    "output": {
                        "success": false,
                        "error": format!("Invalid session request: {}", error)
                    }
                }))?;
            }
        }
    }

    Ok(())
}

fn emit(value: &serde_json::Value) -> Result<()> {
    let mut stdout = io::stdout();
    writeln!(stdout, "{}", serde_json::to_string(value)?)?;
    stdout.flush()?;
    Ok(())
}
