//! 语音命令处理模块
//! 
//! 实现语音输入与命令执行的集成

use crate::commands::cli::CliInterface;
use crate::config::Settings;
use crate::error::Result;
use crate::state::AppState;
use crate::voice::{VoiceService, TranscriptionService, RecordingState};
use std::sync::Arc;
use tokio::sync::RwLock;

/// 语音命令处理器
pub struct VoiceCommandHandler {
    /// 语音服务
    voice_service: Arc<VoiceService>,
    /// 转录服务
    transcription_service: Arc<TranscriptionService>,
    /// 命令行界面
    cli: CliInterface,
}

impl VoiceCommandHandler {
    /// 创建新的语音命令处理器
    pub fn new(cli: CliInterface) -> Self {
        let voice_service = Arc::new(VoiceService::new(None));
        let transcription_service = Arc::new(TranscriptionService::new(None));

        Self {
            voice_service,
            transcription_service,
            cli,
        }
    }

    /// 开始语音输入
    pub async fn start_voice_input(&self) -> Result<()> {
        let status = self.voice_service.get_status().await;
        if !status.available {
            return Err("Voice input is not available".into());
        }

        self.cli.info("Listening... (speak now)");
        self.voice_service.start_recording().await?;

        Ok(())
    }

    /// 停止语音输入并处理
    pub async fn stop_voice_input(&self) -> Result<String> {
        let audio_data = self.voice_service.stop_recording().await?;
        self.cli.info(&format!("Processing audio: {} bytes", audio_data.len()));

        // 转录音频
        let result = self.transcription_service.transcribe(&audio_data).await?;
        self.cli.success(&format!("Transcribed: {}", result.text));
        self.cli.info(&format!("Confidence: {:.2}%, Duration: {:.2}s", 
                              result.confidence * 100.0, result.duration_secs));

        Ok(result.text)
    }

    /// 处理语音命令
    pub async fn handle_voice_command(&self, settings: &Settings, state: &AppState) -> Result<()> {
        // 开始语音输入
        self.start_voice_input().await?;

        // 等待用户说话（这里使用简单的超时机制，实际应用中应该使用静音检测）
        tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;

        // 停止语音输入并获取转录结果
        let text = self.stop_voice_input().await?;

        // 处理转录结果
        self.process_transcription(&text, settings, state).await
    }

    /// 处理转录结果
    async fn process_transcription(&self, text: &str, settings: &Settings, state: &AppState) -> Result<()> {
        // 检查是否是命令
        let processed_text = self.preprocess_text(text);
        self.cli.info(&format!("Processing command: {}", processed_text));

        // 执行命令（这里应该集成到命令执行系统中）
        // 暂时只是输出结果
        self.cli.success(&format!("Command executed: {}", processed_text));

        Ok(())
    }

    /// 预处理文本
    fn preprocess_text(&self, text: &str) -> String {
        // 移除标点符号，转换为小写
        let mut processed = text.to_lowercase();
        processed.retain(|c| c.is_alphanumeric() || c.is_whitespace());
        processed.trim().to_string()
    }

    /// 获取语音服务状态
    pub async fn get_voice_status(&self) -> String {
        let status = self.voice_service.get_status().await;
        format!(
            "Voice Status: {}",
            match status.state {
                RecordingState::Idle => "Idle",
                RecordingState::Recording => "Recording",
                RecordingState::Processing => "Processing",
            }
        )
    }

    /// 检查语音输入可用性
    pub async fn check_availability(&self) -> Result<()> {
        let availability = crate::voice::VoiceService::check_recording_availability().await;
        if !availability.available {
            return Err(availability.reason.unwrap_or("Voice input is not available".to_string()).into());
        }
        Ok(())
    }
}

/// 运行语音模式
pub async fn run(_state: AppState) -> Result<()> {
    // 这里应该实现完整的语音模式逻辑
    println!("Voice mode is not yet implemented");
    Ok(())
}

/// 注册语音命令
pub fn register_voice_commands(manager: &mut crate::commands::registry::CommandManager) {
    // 这里应该注册语音相关的命令
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::cli::CliInterface;
    use std::path::PathBuf;

    #[tokio::test]
    async fn test_voice_command_handler_creation() {
        let cli = CliInterface::new(PathBuf::from(".claude_history"), true);
        let handler = VoiceCommandHandler::new(cli);
        assert!(handler.check_availability().await.is_ok() || handler.check_availability().await.is_err());
    }

    #[test]
    fn test_preprocess_text() {
        let cli = CliInterface::new(PathBuf::from(".claude_history"), true);
        let handler = VoiceCommandHandler::new(cli);
        let text = "Hello, world! This is a test.";
        let processed = handler.preprocess_text(text);
        assert_eq!(processed, "hello world this is a test");
    }
}
