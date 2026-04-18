//! 单次查询命令

use crate::config::Settings;
use crate::error::{ClaudeError, Result};
use crate::state::AppState;
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use serde_json::{json, Value};
use std::io::{self, Read};

const ANTHROPIC_VERSION: &str = "2023-06-01";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ApiStyle {
    Anthropic,
    OpenAi,
}

/// 运行单次查询
pub async fn run(query: String, settings: Settings, _state: AppState) -> Result<()> {
    let output_mode = std::env::var("OPENTEAM_OUTPUT").unwrap_or_default();
    let full_text = execute(
        query,
        settings,
        _state,
        std::env::var("OPENTEAM_CWD").ok(),
        std::env::var("OPENTEAM_MODEL").ok(),
        output_mode == "jsonl",
    ).await?;

    if output_mode == "jsonl" {
        emit_json(&json!({
            "type": "status",
            "status": "completed",
            "message": "Claude Code completed"
        }))?;
        emit_json(&json!({
            "type": "result",
            "output": {
                "success": true,
                "result": full_text
            }
        }))?;
    } else {
        println!();
    }

    Ok(())
}

pub async fn execute(
    query: String,
    settings: Settings,
    _state: AppState,
    cwd_override: Option<String>,
    model_override: Option<String>,
    jsonl: bool,
) -> Result<String> {
    let prompt = resolve_prompt(query)?;
    let cwd = cwd_override.filter(|value| !value.trim().is_empty());
    let model = model_override
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| settings.api.get_model_id(&settings.model));
    let normalized_model = normalize_model_name(&model);
    let base_url = settings.api.get_base_url();
    let api_style = detect_api_style(&base_url);
    let original_cwd = std::env::current_dir().ok();

    if let Some(path) = cwd.as_deref() {
        std::env::set_current_dir(path)
            .map_err(ClaudeError::Io)?;
    }

    let api_key = settings
        .api
        .get_api_key()
        .ok_or_else(|| ClaudeError::Auth("Missing ANTHROPIC_API_KEY/API key for Claude Code runtime".to_string()))?;

    if jsonl {
        emit_json(&json!({
            "type": "status",
            "status": "starting",
            "message": "Preparing Claude Code request"
        }))?;
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(settings.api.timeout))
        .build()?;

    let result = match api_style {
        ApiStyle::Anthropic => {
            run_anthropic_request(&client, &api_key, &base_url, &normalized_model, &prompt, settings.api.max_tokens, jsonl).await
        }
        ApiStyle::OpenAi => {
            run_openai_request(&client, &api_key, &base_url, &normalized_model, &prompt, settings.api.max_tokens, jsonl).await
        }
    };

    if let Some(path) = original_cwd {
        let _ = std::env::set_current_dir(path);
    }

    result
}

async fn run_anthropic_request(
    client: &reqwest::Client,
    api_key: &str,
    base_url: &str,
    model: &str,
    prompt: &str,
    max_tokens: usize,
    jsonl: bool,
) -> Result<String> {
    let url = build_messages_url(base_url);
    let response = client
        .post(url)
        .header("x-api-key", api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header(ACCEPT, "text/event-stream")
        .header(CONTENT_TYPE, "application/json")
        .json(&json!({
            "model": model,
            "max_tokens": max_tokens,
            "stream": true,
            "messages": [
                {
                    "role": "user",
                    "content": prompt
                }
            ]
        }))
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(ClaudeError::Other(format!("Claude API request failed: {} {}", status, body)));
    }

    if jsonl {
        emit_json(&json!({
            "type": "status",
            "status": "running",
            "message": "Claude Code streaming response"
        }))?;
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut full_text = String::new();

    use futures::StreamExt;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(idx) = buffer.find("\n\n") {
            let raw_event = buffer[..idx].to_string();
            buffer.drain(..idx + 2);
            if let Some(text) = handle_sse_event(&raw_event, jsonl)? {
                full_text.push_str(&text);
                if !jsonl {
                    print!("{}", text);
                }
            }
        }
    }

    if !buffer.trim().is_empty() {
        if let Some(text) = handle_sse_event(&buffer, jsonl)? {
            full_text.push_str(&text);
            if !jsonl {
                print!("{}", text);
            }
        }
    }

    Ok(full_text)
}

async fn run_openai_request(
    client: &reqwest::Client,
    api_key: &str,
    base_url: &str,
    model: &str,
    prompt: &str,
    max_tokens: usize,
    jsonl: bool,
) -> Result<String> {
    let url = build_chat_completions_url(base_url);
    let response = client
        .post(url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header(CONTENT_TYPE, "application/json")
        .json(&json!({
            "model": model,
            "messages": [
                {
                    "role": "user",
                    "content": prompt
                }
            ],
            "max_tokens": max_tokens,
            "stream": false
        }))
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(ClaudeError::Other(format!("OpenAI-compatible request failed: {} {}", status, body)));
    }

    if jsonl {
        emit_json(&json!({
            "type": "status",
            "status": "running",
            "message": "Claude Code request in progress"
        }))?;
    }

    let payload: Value = response.json().await?;
    let text = extract_openai_text(&payload)
        .ok_or_else(|| ClaudeError::Other(format!("OpenAI-compatible response missing assistant text: {}", payload)))?;

    if jsonl {
        emit_json(&json!({
            "type": "text-delta",
            "text": text
        }))?;
    } else {
        print!("{}", text);
    }

    Ok(text)
}

fn resolve_prompt(query: String) -> Result<String> {
    if std::env::var("OPENTEAM_QUERY_STDIN").ok().as_deref() == Some("1") {
        let mut input = String::new();
        io::stdin().read_to_string(&mut input)?;
        let trimmed = input.trim().to_string();
        if !trimmed.is_empty() {
            return Ok(trimmed);
        }
    }

    let trimmed = query.trim().to_string();
    if trimmed.is_empty() {
        return Err(ClaudeError::Command("Query text is empty".to_string()));
    }
    Ok(trimmed)
}

fn build_messages_url(base_url: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');
    if trimmed.ends_with("/v1/messages") {
        return trimmed.to_string();
    }
    if trimmed.ends_with("/v1") {
        return format!("{}/messages", trimmed);
    }
    format!("{}/v1/messages", trimmed)
}

fn build_chat_completions_url(base_url: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');
    if trimmed.ends_with("/v1/chat/completions") {
        return trimmed.to_string();
    }
    if trimmed.ends_with("/v1") {
        return format!("{}/chat/completions", trimmed);
    }
    format!("{}/v1/chat/completions", trimmed)
}

fn detect_api_style(base_url: &str) -> ApiStyle {
    match std::env::var("CLAUDE_CODE_API_STYLE").ok().as_deref() {
        Some("openai") => return ApiStyle::OpenAi,
        Some("anthropic") => return ApiStyle::Anthropic,
        _ => {}
    }

    if base_url.contains("chat/completions") || base_url.contains("openai") || base_url.contains("127.0.0.1:18000") {
        ApiStyle::OpenAi
    } else {
        ApiStyle::Anthropic
    }
}

fn normalize_model_name(model: &str) -> String {
    model.strip_prefix("custom/").unwrap_or(model).to_string()
}

fn extract_openai_text(payload: &Value) -> Option<String> {
    payload["choices"]
        .as_array()
        .and_then(|choices| choices.first())
        .and_then(|choice| choice["message"]["content"].as_str())
        .map(|text| text.to_string())
}

fn handle_sse_event(raw_event: &str, jsonl: bool) -> Result<Option<String>> {
    let mut data_lines = Vec::new();

    for line in raw_event.lines() {
        if let Some(rest) = line.strip_prefix("data:") {
            data_lines.push(rest.trim());
        }
    }

    if data_lines.is_empty() {
        return Ok(None);
    }

    let data = data_lines.join("\n");
    if data == "[DONE]" {
        return Ok(None);
    }

    let payload: Value = serde_json::from_str(&data)?;
    let event_type = payload["type"].as_str().unwrap_or_default();

    if event_type == "content_block_delta" {
        if let Some(text) = payload["delta"]["text"].as_str() {
            if jsonl {
                emit_json(&json!({
                    "type": "text-delta",
                    "text": text
                }))?;
            }
            return Ok(Some(text.to_string()));
        }
    }

    if event_type == "error" {
        let message = payload["error"]["message"]
            .as_str()
            .unwrap_or("Unknown Claude API error");
        if jsonl {
            emit_json(&json!({
                "type": "error",
                "error": message
            }))?;
            emit_json(&json!({
                "type": "result",
                "output": {
                    "success": false,
                    "error": message
                }
            }))?;
        }
        return Err(ClaudeError::Other(message.to_string()));
    }

    Ok(None)
}

fn emit_json(value: &Value) -> Result<()> {
    println!("{}", serde_json::to_string(value)?);
    Ok(())
}
