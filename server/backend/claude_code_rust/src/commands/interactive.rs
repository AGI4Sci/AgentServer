//! 交互式会话命令
//! 
//! 这个模块实现了交互式会话功能

use crate::commands::builtin::load_builtin_commands;
use crate::commands::cli::{CliInterface, BatchProcessor};
use crate::commands::executor::{CmdExecutor, UserInput};
use crate::commands::registry::CommandManager;
use crate::config::{Config, Settings};
use crate::error::Result;
use crate::state::AppState;
use std::path::PathBuf;
use std::io::{self, Write};

/// 运行交互式会话
pub async fn run(settings: Settings, state: AppState) -> Result<()> {
    tracing::info!("Starting interactive session");
    
    // 初始化命令行界面
    let history_file = PathBuf::from(".claude_history");
    let cli = CliInterface::new(history_file, true);
    cli.init().await?;
    
    // 初始化批量处理器
    let batch_processor = BatchProcessor::new(cli.clone());
    
    // 初始化命令系统
    let mut command_manager = CommandManager::new();
    load_builtin_commands(&mut command_manager);
    command_manager.load_all().await?;
    
    // 创建命令执行器
    let executor = CmdExecutor::new(command_manager.registry().clone());
    
    // 获取当前工作目录
    let cwd = std::env::current_dir()?;
    
    // 使用设置作为配置
    let config = settings;
    
    cli.success("Claude Code Interactive Mode");
    cli.info("Type 'exit' or Ctrl+D to quit");
    cli.info("Type 'help' for available commands");
    cli.info("");
    
    // 交互循环
    loop {
        print!("> ");
        io::stdout().flush().ok();
        
        let mut input = String::new();
        match io::stdin().read_line(&mut input) {
            Ok(0) => break, // Ctrl+D
            Ok(_) => {},
            Err(e) => {
                cli.error(&format!("Error reading input: {}", e));
                continue;
            }
        }
        
        let input = input.trim();
        if input.is_empty() {
            continue;
        }
        
        // 处理特殊命令
        if input == "exit" || input == "quit" {
            break;
        } else if input == "clear" {
            // 清空屏幕
            print!("\x1B[2J\x1B[1;1H");
            continue;
        } else if input.starts_with(".batch") {
            // 批量执行命令
            let parts: Vec<&str> = input.split_whitespace().collect();
            if parts.len() == 2 {
                let file_path = PathBuf::from(parts[1]);
                if let Err(e) = batch_processor.execute_from_file(&file_path).await {
                    cli.error(&format!("Error executing batch file: {}", e));
                }
            } else {
                cli.error("Usage: .batch <file_path>");
            }
            continue;
        }
        
        // 处理用户输入
        match cli.handle_input(input).await {
            Ok(resolved_input) => {
                // 执行命令
                match executor.execute(resolved_input, cwd.clone(), config.clone(), state.clone()).await {
                    Ok(result) => {
                        match result {
                            crate::commands::executor::ExecuteResult::Command(command_result) => {
                                cli.success(&command_result.content);
                                if !command_result.meta_messages.is_empty() {
                                    for msg in &command_result.meta_messages {
                                        cli.info(msg);
                                    }
                                }
                            }
                            crate::commands::executor::ExecuteResult::Message(message) => {
                                // 处理普通消息
                                cli.info(&format!("Message: {}", message));
                                // TODO: 调用 API 处理消息
                            }
                        }
                    }
                    Err(e) => {
                        cli.error(&format!("Error executing command: {}", e));
                    }
                }
            }
            Err(e) => {
                cli.error(&format!("Error handling input: {}", e));
            }
        }
    }
    
    cli.success("Goodbye!");
    Ok(())
}
