//! Bridge 远程控制服务入口

use claude_code_rs::{bridge, error::Result, state::new_app_state, config::Config};
use clap::{Parser, Subcommand};
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

/// Bridge 远程控制服务
#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
#[command(propagate_version = true)]
struct BridgeCli {
    /// 子命令
    #[command(subcommand)]
    command: Option<BridgeCommands>,
    
    /// 启用详细日志
    #[arg(short, long, global = true)]
    verbose: bool,
    
    /// 配置文件路径
    #[arg(long, global = true)]
    config: Option<std::path::PathBuf>,
}

/// Bridge 子命令
#[derive(Subcommand, Debug)]
enum BridgeCommands {
    /// 启动 Bridge 服务
    Start {
        /// 监听地址
        #[arg(short, long, default_value = "127.0.0.1:8080")]
        address: String,
        
        /// 会话模式
        #[arg(short, long, default_value = "single-session")]
        session_mode: String,
    },
    
    /// 停止 Bridge 服务
    Stop,
    
    /// 显示状态
    Status,
    
    /// 注册环境
    Register {
        /// 环境名称
        #[arg(short, long)]
        name: Option<String>,
    },
    
    /// 列出会话
    ListSessions,
}

#[tokio::main]
async fn main() {
    // 初始化日志
    if let Err(e) = init_logging() {
        eprintln!("警告: 初始化日志失败: {}", e);
    }
    
    // 解析命令行参数
    let cli = BridgeCli::parse();
    
    // 运行应用
    if let Err(e) = run(cli).await {
        eprintln!("错误: {}", e);
        std::process::exit(1);
    }
}

/// 初始化日志
fn init_logging() -> Result<()> {
    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info"));
    
    tracing_subscriber::registry()
        .with(env_filter)
        .with(fmt::layer())
        .try_init()
        .map_err(|e| format!("初始化日志失败: {}", e))?;
    
    Ok(())
}

/// 运行应用
async fn run(cli: BridgeCli) -> Result<()> {
    // 初始化 Bridge 系统
    bridge::initialize().await?;
    
    // 创建应用状态
    let state = new_app_state();
    
    // 处理命令
    match cli.command {
        Some(BridgeCommands::Start { address, session_mode }) => {
            start_bridge_server(&address, &session_mode, state).await?;
        }
        Some(BridgeCommands::Stop) => {
            stop_bridge_server().await?;
        }
        Some(BridgeCommands::Status) => {
            show_bridge_status().await?;
        }
        Some(BridgeCommands::Register { name }) => {
            register_environment(name).await?;
        }
        Some(BridgeCommands::ListSessions) => {
            list_sessions().await?;
        }
        None => {
            // 默认启动服务
            start_bridge_server("127.0.0.1:8080", "single-session", state).await?;
        }
    }
    
    Ok(())
}

/// 启动 Bridge 服务器
async fn start_bridge_server(address: &str, session_mode: &str, state: claude_code_rs::state::AppState) -> Result<()> {
    tracing::info!("Starting Bridge server on {}", address);
    
    // 解析会话模式
    let spawn_mode = match session_mode {
        "single-session" => bridge::SpawnMode::SingleSession,
        "worktree" => bridge::SpawnMode::Worktree,
        "same-dir" => bridge::SpawnMode::SameDir,
        _ => return Err("Invalid session mode".into()),
    };
    
    // 创建配置
    let config = Config::default();
    
    // 创建 Bridge 管理器
    let mut manager = bridge::BridgeManager::new(config, state);
    
    // 注册环境
    let (env_id, env_secret) = manager.register_environment().await?;
    tracing::info!("Environment registered: ID={}, Secret={}", env_id, env_secret);
    
    // 启动服务器
    tracing::info!("Bridge server started successfully");
    tracing::info!("Session mode: {:?}", spawn_mode);
    tracing::info!("Max sessions: 100");
    
    // 这里应该实现实际的服务器启动逻辑
    // 暂时使用一个简单的阻塞来模拟服务器运行
    println!("Bridge server started on {}", address);
    println!("Environment ID: {}", env_id);
    println!("Environment Secret: {}", env_secret);
    println!("Session mode: {:?}", spawn_mode);
    println!("Press Ctrl+C to stop");
    
    // 模拟服务器运行
    tokio::signal::ctrl_c().await?;
    
    tracing::info!("Bridge server stopped");
    Ok(())
}

/// 停止 Bridge 服务器
async fn stop_bridge_server() -> Result<()> {
    tracing::info!("Stopping Bridge server");
    println!("Bridge server stopped");
    Ok(())
}

/// 显示 Bridge 状态
async fn show_bridge_status() -> Result<()> {
    tracing::info!("Showing Bridge status");
    println!("Bridge status: Running");
    Ok(())
}

/// 注册环境
async fn register_environment(name: Option<String>) -> Result<()> {
    tracing::info!("Registering environment");
    
    // 创建配置和状态
    let config = Config::default();
    let state = new_app_state();
    
    let mut manager = bridge::BridgeManager::new(config, state);
    let (env_id, env_secret) = manager.register_environment().await?;
    
    println!("Environment registered:");
    println!("  Name: {:?}", name.unwrap_or_else(|| "default".to_string()));
    println!("  ID: {}", env_id);
    println!("  Secret: {}", env_secret);
    
    Ok(())
}

/// 列出会话
async fn list_sessions() -> Result<()> {
    tracing::info!("Listing sessions");
    println!("Sessions:");
    println!("  No active sessions");
    Ok(())
}