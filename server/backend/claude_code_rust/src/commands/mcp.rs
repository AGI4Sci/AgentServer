//! MCP 命令处理模块
//! 
//! 实现 MCP (Model Context Protocol) 相关的命令处理

use crate::error::Result;
use crate::mcp::McpManager;
use crate::state::AppState;

/// 列出所有 MCP 服务器
pub async fn list_servers(state: AppState) -> Result<()> {
    let mcp_manager = McpManager::new(state);
    let servers = mcp_manager.list_servers().await;
    
    println!("MCP Servers:");
    println!("{:-<60}", "");
    
    if servers.is_empty() {
        println!("No MCP servers configured");
    } else {
        for server in servers {
            println!("Name: {}", server.name);
            println!("Type: {}", server.server_type);
            println!("Status: {:?}", server.status);
            println!("Tools: {}", server.tools.len());
            println!("Commands: {}", server.commands.len());
            println!("Resources: {}", server.resources.len());
            println!("{:-<60}", "");
        }
    }
    
    Ok(())
}

/// 启用 MCP 服务器
pub async fn enable_server(server_name: String, state: AppState) -> Result<()> {
    let mut mcp_manager = McpManager::new(state);
    mcp_manager.enable_server(server_name).await?;
    println!("MCP server enabled successfully");
    Ok(())
}

/// 禁用 MCP 服务器
pub async fn disable_server(server_name: String, state: AppState) -> Result<()> {
    let mut mcp_manager = McpManager::new(state);
    mcp_manager.disable_server(server_name).await?;
    println!("MCP server disabled successfully");
    Ok(())
}

/// 重新连接 MCP 服务器
pub async fn reconnect_server(server_name: String, state: AppState) -> Result<()> {
    let mut mcp_manager = McpManager::new(state);
    mcp_manager.reconnect_server(server_name).await?;
    println!("MCP server reconnected successfully");
    Ok(())
}

/// 注册 MCP 相关的命令
pub fn register_mcp_commands(manager: &mut crate::commands::registry::CommandManager) {
    // 这里应该注册 MCP 相关的命令
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::new_app_state;

    #[tokio::test]
    async fn test_list_servers() {
        let state = new_app_state();
        let result = list_servers(state).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_enable_server() {
        let state = new_app_state();
        let result = enable_server("test-server".to_string(), state).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_disable_server() {
        let state = new_app_state();
        let result = disable_server("test-server".to_string(), state).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_reconnect_server() {
        let state = new_app_state();
        let result = reconnect_server("test-server".to_string(), state).await;
        assert!(result.is_ok());
    }
}
