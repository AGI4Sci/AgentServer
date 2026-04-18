//! 插件命令处理模块
//! 
//! 实现插件系统相关的命令处理

use crate::error::Result;
use crate::plugins::{Plugin, PluginManager};
use crate::state::AppState;
use std::path::PathBuf;

/// 列出所有插件
pub async fn list_plugins(state: AppState) -> Result<()> {
    let plugin_manager = PluginManager::new();
    let plugins: std::collections::HashMap<String, std::sync::Arc<tokio::sync::RwLock<Box<dyn Plugin>>>> = plugin_manager.get_all_plugins().await;
    
    println!("Plugins:");
    println!("{:-<60}", "");
    
    if plugins.is_empty() {
        println!("No plugins loaded");
    } else {
        for (name, plugin) in plugins {
            let plugin_read = plugin.read().await;
            let metadata = plugin_read.metadata();
            let state = plugin_read.state();
            
            println!("Name: {}", name);
            println!("Version: {}", metadata.version);
            println!("Author: {}", metadata.author);
            println!("Description: {}", metadata.description);
            println!("Status: {:?}", state);
            println!("{:-<60}", "");
        }
    }
    
    Ok(())
}

/// 加载插件
pub async fn load_plugin(path: String, state: AppState) -> Result<()> {
    let plugin_manager = PluginManager::new();
    let plugin_path = PathBuf::from(path);
    plugin_manager.load_plugin(plugin_path).await?;
    println!("Plugin loaded successfully");
    Ok(())
}

/// 卸载插件
pub async fn unload_plugin(name: String, state: AppState) -> Result<()> {
    let plugin_manager = PluginManager::new();
    plugin_manager.unload_plugin(&name).await?;
    println!("Plugin unloaded successfully");
    Ok(())
}

/// 启动插件
pub async fn start_plugin(name: String, state: AppState) -> Result<()> {
    let plugin_manager = PluginManager::new();
    plugin_manager.start_plugin(&name).await?;
    println!("Plugin started successfully");
    Ok(())
}

/// 停止插件
pub async fn stop_plugin(name: String, state: AppState) -> Result<()> {
    let plugin_manager = PluginManager::new();
    plugin_manager.stop_plugin(&name).await?;
    println!("Plugin stopped successfully");
    Ok(())
}

/// 扫描插件
pub async fn scan_plugins(state: AppState) -> Result<()> {
    let plugin_manager = PluginManager::new();
    let plugins: Vec<std::path::PathBuf> = plugin_manager.scan_plugins().await?;
    
    println!("Found plugins:");
    println!("{:-<60}", "");
    
    if plugins.is_empty() {
        println!("No plugins found");
    } else {
        for path in plugins {
            println!("{}", path.display());
        }
    }
    
    Ok(())
}

/// 注册插件相关的命令
pub fn register_plugin_commands(manager: &mut crate::commands::registry::CommandManager) {
    // 这里应该注册插件相关的命令
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::new_app_state;

    #[tokio::test]
    async fn test_list_plugins() {
        let state = new_app_state();
        let result = list_plugins(state).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_scan_plugins() {
        let state = new_app_state();
        let result = scan_plugins(state).await;
        assert!(result.is_ok());
    }
}
