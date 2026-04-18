//! 命令行界面增强
//! 
//! 实现跨平台命令行界面的增强功能，包括自动补全、历史记录、彩色输出等

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use crossterm::style::{Color, Colored, Print, ResetColor, SetForegroundColor};
use crossterm::terminal;
use crossterm::cursor;
use crossterm::execute;
use crate::error::Result;

/// 命令行历史记录
#[derive(Debug, Clone)]
pub struct CommandHistory {
    /// 历史记录文件路径
    history_file: PathBuf,
    /// 历史记录
    history: Arc<RwLock<Vec<String>>>,
    /// 最大历史记录数
    max_history: usize,
}

impl CommandHistory {
    /// 创建新的命令历史记录
    pub fn new(history_file: PathBuf) -> Self {
        Self {
            history_file,
            history: Arc::new(RwLock::new(Vec::new())),
            max_history: 1000,
        }
    }
    
    /// 加载历史记录
    pub async fn load(&self) -> Result<()>
    {
        if self.history_file.exists() {
            let file = File::open(&self.history_file)?;
            let reader = BufReader::new(file);
            
            let mut history = self.history.write().await;
            history.clear();
            
            for line in reader.lines() {
                if let Ok(line) = line {
                    history.push(line);
                }
            }
            
            // 限制历史记录数量
            if history.len() > self.max_history {
                let drain_count = history.len() - self.max_history;
                history.drain(0..drain_count);
            }
        }
        
        Ok(())
    }
    
    /// 保存历史记录
    pub async fn save(&self) -> Result<()>
    {
        let history = self.history.read().await;
        let mut file = File::create(&self.history_file)?;
        
        for line in history.iter() {
            writeln!(file, "{}", line)?;
        }
        
        Ok(())
    }
    
    /// 添加历史记录
    pub async fn add(&self, command: &str) {
        let mut history = self.history.write().await;
        
        // 避免重复
        if !history.contains(&command.to_string()) {
            history.push(command.to_string());
            
            // 限制历史记录数量
            if history.len() > self.max_history {
                history.remove(0);
            }
        }
    }
    
    /// 获取历史记录
    pub async fn get_history(&self) -> Vec<String> {
        self.history.read().await.clone()
    }
    
    /// 搜索历史记录
    pub async fn search(&self, prefix: &str) -> Vec<String> {
        let history = self.history.read().await;
        history.iter()
            .filter(|line| line.starts_with(prefix))
            .cloned()
            .collect()
    }
}

/// 命令自动补全
#[derive(Debug, Clone)]
pub struct CommandCompleter {
    /// 命令列表
    commands: Arc<RwLock<Vec<String>>>,
    /// 命令别名
    aliases: Arc<RwLock<HashMap<String, String>>>,
}

impl CommandCompleter {
    /// 创建新的命令自动补全
    pub fn new() -> Self {
        Self {
            commands: Arc::new(RwLock::new(Vec::new())),
            aliases: Arc::new(RwLock::new(HashMap::new())),
        }
    }
    
    /// 添加命令
    pub async fn add_command(&self, command: &str) {
        let mut commands = self.commands.write().await;
        if !commands.contains(&command.to_string()) {
            commands.push(command.to_string());
        }
    }
    
    /// 添加命令别名
    pub async fn add_alias(&self, alias: &str, command: &str) {
        let mut aliases = self.aliases.write().await;
        aliases.insert(alias.to_string(), command.to_string());
    }
    
    /// 补全命令
    pub async fn complete(&self, prefix: &str) -> Vec<String> {
        let commands = self.commands.read().await;
        let aliases = self.aliases.read().await;
        
        let mut completions = Vec::new();
        
        // 补全命令
        for command in commands.iter() {
            if command.starts_with(prefix) {
                completions.push(command.clone());
            }
        }
        
        // 补全别名
        for alias in aliases.keys() {
            if alias.starts_with(prefix) {
                completions.push(alias.clone());
            }
        }
        
        completions
    }
    
    /// 解析命令别名
    pub async fn resolve_alias(&self, command: &str) -> String {
        let aliases = self.aliases.read().await;
        if let Some(resolved) = aliases.get(command) {
            resolved.clone()
        } else {
            command.to_string()
        }
    }
}

/// 命令行彩色输出
#[derive(Debug, Clone)]
pub struct ColorOutput {
    /// 是否启用彩色输出
    enabled: bool,
}

impl ColorOutput {
    /// 创建新的彩色输出
    pub fn new(enabled: bool) -> Self {
        Self { enabled }
    }
    
    /// 输出彩色文本
    pub fn print_color(&self, text: &str, color: Color) {
        if self.enabled {
            execute!(std::io::stdout(), 
                SetForegroundColor(color),
                Print(text),
                ResetColor
            ).unwrap();
        } else {
            print!("{}", text);
        }
    }
    
    /// 输出彩色行
    pub fn println_color(&self, text: &str, color: Color) {
        self.print_color(text, color);
        println!();
    }
    
    /// 输出成功消息
    pub fn println_success(&self, text: &str) {
        self.println_color(text, Color::Green);
    }
    
    /// 输出错误消息
    pub fn println_error(&self, text: &str) {
        self.println_color(text, Color::Red);
    }
    
    /// 输出警告消息
    pub fn println_warning(&self, text: &str) {
        self.println_color(text, Color::Yellow);
    }
    
    /// 输出信息消息
    pub fn println_info(&self, text: &str) {
        self.println_color(text, Color::Blue);
    }
}

/// 命令行界面
#[derive(Debug, Clone)]
pub struct CliInterface {
    /// 命令历史记录
    history: CommandHistory,
    /// 命令自动补全
    completer: CommandCompleter,
    /// 彩色输出
    color_output: ColorOutput,
    /// 命令别名
    aliases: Arc<RwLock<HashMap<String, String>>>,
}

impl CliInterface {
    /// 创建新的命令行界面
    pub fn new(history_file: PathBuf, color_enabled: bool) -> Self {
        Self {
            history: CommandHistory::new(history_file),
            completer: CommandCompleter::new(),
            color_output: ColorOutput::new(color_enabled),
            aliases: Arc::new(RwLock::new(HashMap::new())),
        }
    }
    
    /// 初始化
    pub async fn init(&self) -> Result<()>
    {
        // 加载历史记录
        self.history.load().await?;
        
        // 添加默认命令
        self.add_default_commands().await;
        
        // 添加默认别名
        self.add_default_aliases().await;
        
        Ok(())
    }
    
    /// 添加默认命令
    async fn add_default_commands(&self) {
        let commands = vec!["help", "version", "clear", "exit", "config", "mcp", "status"];
        for command in commands {
            self.completer.add_command(command).await;
        }
    }
    
    /// 添加默认别名
    async fn add_default_aliases(&self) {
        let aliases = vec![
            ("h", "help"),
            ("v", "version"),
            ("c", "clear"),
            ("q", "exit"),
            ("cfg", "config"),
        ];
        for (alias, command) in aliases {
            self.completer.add_alias(alias, command).await;
        }
    }
    
    /// 处理用户输入
    pub async fn handle_input(&self, input: &str) -> Result<String> {
        // 添加到历史记录
        self.history.add(input).await;
        self.history.save().await?;
        
        // 解析命令别名
        let resolved_input = self.completer.resolve_alias(input).await;
        
        Ok(resolved_input)
    }
    
    /// 补全输入
    pub async fn complete_input(&self, input: &str) -> Vec<String> {
        self.completer.complete(input).await
    }
    
    /// 输出成功消息
    pub fn success(&self, text: &str) {
        self.color_output.println_success(text);
    }
    
    /// 输出错误消息
    pub fn error(&self, text: &str) {
        self.color_output.println_error(text);
    }
    
    /// 输出警告消息
    pub fn warning(&self, text: &str) {
        self.color_output.println_warning(text);
    }
    
    /// 输出信息消息
    pub fn info(&self, text: &str) {
        self.color_output.println_info(text);
    }
    
    /// 获取历史记录
    pub async fn get_history(&self) -> Vec<String> {
        self.history.get_history().await
    }
    
    /// 搜索历史记录
    pub async fn search_history(&self, prefix: &str) -> Vec<String> {
        self.history.search(prefix).await
    }
    
    /// 添加命令
    pub async fn add_command(&self, command: &str) {
        self.completer.add_command(command).await;
    }
    
    /// 添加命令别名
    pub async fn add_alias(&self, alias: &str, command: &str) {
        self.completer.add_alias(alias, command).await;
    }
}

/// 批量操作处理器
#[derive(Debug, Clone)]
pub struct BatchProcessor {
    /// 命令行界面
    cli: CliInterface,
}

impl BatchProcessor {
    /// 创建新的批量操作处理器
    pub fn new(cli: CliInterface) -> Self {
        Self { cli }
    }
    
    /// 执行批量命令
    pub async fn execute_batch(&self, commands: Vec<String>) -> Result<()>
    {
        for command in commands {
            let resolved_command = self.cli.handle_input(&command).await?;
            self.cli.info(&format!("Executing: {}", resolved_command));
            
            // 这里应该执行命令
            // 暂时只是输出
            tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        }
        
        Ok(())
    }
    
    /// 从文件执行批量命令
    pub async fn execute_from_file(&self, file_path: &PathBuf) -> Result<()>
    {
        let file = File::open(file_path)?;
        let reader = BufReader::new(file);
        
        let mut commands = Vec::new();
        for line in reader.lines() {
            if let Ok(line) = line {
                let trimmed = line.trim();
                if !trimmed.is_empty() && !trimmed.starts_with('#') {
                    commands.push(trimmed.to_string());
                }
            }
        }
        
        self.execute_batch(commands).await
    }
}
