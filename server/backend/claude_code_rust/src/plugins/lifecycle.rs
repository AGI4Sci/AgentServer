//! 插件生命周期管理
//! 
//! 实现插件的生命周期管理，包括初始化、启动、停止和卸载

use std::sync::Arc;
use tokio::sync::RwLock;
use crate::error::Result;
use super::plugin::{Plugin, PluginState};

/// 插件生命周期管理器
#[derive(Debug, Clone)]
pub struct PluginLifecycle {
    /// 插件
    plugin: Arc<RwLock<Box<dyn Plugin>>>,
}

impl PluginLifecycle {
    /// 创建新的插件生命周期管理器
    pub fn new(plugin: Box<dyn Plugin>) -> Self {
        Self {
            plugin: Arc::new(RwLock::new(plugin)),
        }
    }
    
    /// 初始化插件
    pub async fn initialize(&self) -> Result<()>
    {
        let mut plugin = self.plugin.write().await;
        plugin.initialize().await
    }
    
    /// 启动插件
    pub async fn start(&self) -> Result<()>
    {
        let mut plugin = self.plugin.write().await;
        plugin.start().await
    }
    
    /// 停止插件
    pub async fn stop(&self) -> Result<()>
    {
        let mut plugin = self.plugin.write().await;
        plugin.stop().await
    }
    
    /// 卸载插件
    pub async fn unload(&self) -> Result<()>
    {
        let mut plugin = self.plugin.write().await;
        plugin.unload().await
    }
    
    /// 获取插件状态
    pub async fn state(&self) -> PluginState {
        let plugin = self.plugin.read().await;
        plugin.state()
    }
    
    /// 检查插件是否正在运行
    pub async fn is_running(&self) -> bool {
        self.state().await == PluginState::Running
    }
    
    /// 检查插件是否已加载
    pub async fn is_loaded(&self) -> bool {
        let state = self.state().await;
        state == PluginState::Loaded || state == PluginState::Running
    }
}
