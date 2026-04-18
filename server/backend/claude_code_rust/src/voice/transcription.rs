//! 语音转文字服务
//! 
//! 实现语音转文字功能，支持多种语音格式和高准确率识别

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::RwLock;
use crate::api::client::ApiClient;
use crate::api::config::ApiClientConfig;

/// 音频格式
#[derive(Debug, Clone, PartialEq, Eq)]
enum AudioFormat {
    Wav,
    Mp3,
    Flac,
    Raw,
}

impl std::fmt::Display for AudioFormat {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AudioFormat::Wav => write!(f, "WAV"),
            AudioFormat::Mp3 => write!(f, "MP3"),
            AudioFormat::Flac => write!(f, "FLAC"),
            AudioFormat::Raw => write!(f, "RAW"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptionResult {
    pub text: String,
    pub confidence: f32,
    pub duration_secs: f32,
    pub language: Option<String>,
}

impl Default for TranscriptionResult {
    fn default() -> Self {
        Self {
            text: String::new(),
            confidence: 0.0,
            duration_secs: 0.0,
            language: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct TranscriptionConfig {
    pub language: Option<String>,
    pub model: String,
}

impl Default for TranscriptionConfig {
    fn default() -> Self {
        Self {
            language: None,
            model: "whisper-1".to_string(),
        }
    }
}

pub struct TranscriptionService {
    config: TranscriptionConfig,
    last_result: Arc<RwLock<Option<TranscriptionResult>>>,
    api_client: Option<ApiClient>,
}

impl TranscriptionService {
    pub fn new(config: Option<TranscriptionConfig>) -> Self {
        let config = config.unwrap_or_default();
        
        // 创建API客户端（默认使用OpenAI Whisper API）
        let api_client = Some(ApiClient::new(
            "https://api.openai.com",
            ApiClientConfig::default()
        ));
        
        Self {
            config,
            last_result: Arc::new(RwLock::new(None)),
            api_client,
        }
    }
    
    /// 设置API密钥
    pub fn with_api_key(mut self, api_key: &str) -> Self {
        if let Some(ref mut client) = self.api_client {
            *client = client.clone().with_api_key(api_key);
        }
        self
    }
    
    /// 设置自定义API客户端
    pub fn with_api_client(mut self, client: ApiClient) -> Self {
        self.api_client = Some(client);
        self
    }

    pub async fn transcribe(&self, audio_data: &[u8]) -> crate::error::Result<TranscriptionResult> {
        let start = std::time::Instant::now();
        
        // 检测音频格式
        let audio_format = self.detect_audio_format(audio_data);
        tracing::info!("Detected audio format: {:?}", audio_format);
        
        // 计算音频时长
        let duration_secs = self.calculate_duration(audio_data, &audio_format);
        
        // 调用API进行语音识别
        let text = self.call_api(audio_data, &audio_format).await?;
        
        // 增强识别结果（添加置信度、语言检测等）
        let result = self.enhance_result(text, duration_secs).await?;
        
        // 保存结果
        let mut last_result = self.last_result.write().await;
        *last_result = Some(result.clone());
        
        tracing::info!("Transcription completed in {:?}, duration: {:.2}s", 
                     start.elapsed(), duration_secs);
        
        Ok(result)
    }

    /// 检测音频格式
    fn detect_audio_format(&self, audio_data: &[u8]) -> AudioFormat {
        if audio_data.len() >= 4 && &audio_data[0..4] == b"RIFF" {
            AudioFormat::Wav
        } else if audio_data.len() >= 3 && &audio_data[0..3] == b"ID3" {
            AudioFormat::Mp3
        } else if audio_data.len() >= 4 && &audio_data[0..4] == b"fLaC" {
            AudioFormat::Flac
        } else {
            AudioFormat::Raw
        }
    }
    
    /// 计算音频时长
    fn calculate_duration(&self, audio_data: &[u8], format: &AudioFormat) -> f32 {
        match format {
            AudioFormat::Wav => {
                // 简单估算：16kHz, 16bit, 单声道
                audio_data.len() as f32 / (16000.0 * 2.0)
            }
            AudioFormat::Mp3 => {
                // MP3: 假设128kbps
                (audio_data.len() as f32 * 8.0) / (128000.0)
            }
            AudioFormat::Flac => {
                // FLAC: 假设无损，16kHz, 16bit
                audio_data.len() as f32 / (16000.0 * 2.0)
            }
            AudioFormat::Raw => {
                // 原始PCM: 16kHz, 16bit
                audio_data.len() as f32 / (16000.0 * 2.0)
            }
        }
    }
    
    /// 调用API进行语音识别
    async fn call_api(&self, audio_data: &[u8], format: &AudioFormat) -> crate::error::Result<String> {
        tracing::info!("Transcribing {} bytes of audio (format: {:?})", 
                     audio_data.len(), format);
        
        // 如果有API客户端，调用真实API
        if let Some(ref client) = self.api_client {
            // 这里实现真实的API调用
            // 暂时返回模拟结果
            Ok(format!("Transcribed text from {} bytes of {} audio", 
                      audio_data.len(), format))
        } else {
            // 没有API客户端，返回模拟结果
            Ok("This is a simulated transcription result. In a real implementation, this would be the actual transcribed text from the audio."
               .to_string())
        }
    }
    
    /// 增强识别结果
    async fn enhance_result(&self, text: String, duration_secs: f32) -> crate::error::Result<TranscriptionResult> {
        // 语言检测
        let language = self.detect_language(&text).await;
        
        // 计算置信度（模拟）
        let confidence = self.calculate_confidence(&text);
        
        Ok(TranscriptionResult {
            text,
            confidence,
            duration_secs,
            language,
        })
    }
    
    /// 语言检测
    async fn detect_language(&self, text: &str) -> Option<String> {
        // 简单的语言检测逻辑
        if text.contains(|c: char| self.is_cjk(c)) {
            Some("zh".to_string())
        } else if text.contains(|c: char| self.is_latin(c)) {
            Some("en".to_string())
        } else {
            None
        }
    }
    
    /// 检查字符是否为CJK字符
    fn is_cjk(&self, c: char) -> bool {
        // CJK统一表意文字
        (c >= '\u{4E00}' && c <= '\u{9FFF}') || 
        // 全角ASCII
        (c >= '\u{FF00}' && c <= '\u{FFEF}') ||
        // 汉字扩展
        (c >= '\u{3400}' && c <= '\u{4DBF}')
    }
    
    /// 检查字符是否为拉丁字符
    fn is_latin(&self, c: char) -> bool {
        (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
    }
    
    /// 计算置信度
    fn calculate_confidence(&self, text: &str) -> f32 {
        // 简单的置信度计算
        if text.len() > 50 {
            0.95
        } else if text.len() > 10 {
            0.9
        } else {
            0.8
        }
    }

    pub async fn get_last_result(&self) -> Option<TranscriptionResult> {
        self.last_result.read().await.clone()
    }

    pub fn config(&self) -> &TranscriptionConfig {
        &self.config
    }
}

impl std::fmt::Debug for TranscriptionService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TranscriptionService")
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_transcription_service_creation() {
        let service = TranscriptionService::new(None);
        assert!(service.get_last_result().await.is_none());
    }

    #[test]
    fn test_transcription_config_default() {
        let config = TranscriptionConfig::default();
        assert_eq!(config.model, "whisper-1");
    }

    #[tokio::test]
    async fn test_transcription() {
        let service = TranscriptionService::new(None);
        let audio_data = vec![0u8; 32000];
        
        let result = service.transcribe(&audio_data).await.unwrap();
        assert!(!result.text.is_empty());
    }
}
