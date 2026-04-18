//! 插件管理器
//! 
//! 实现插件的加载、卸载和管理功能

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use crate::error::Result;
use super::plugin::{Plugin, DynamicPlugin, PluginMetadata, PluginState};
use super::message_bus::MessageBus;
use super::lifecycle::PluginLifecycle;
use super::dependency::DependencyManager;

/// 插件管理器
#[derive(Debug, Clone)]
pub struct PluginManager {
    /// 插件映射
    plugins: Arc<RwLock<HashMap<String, Arc<RwLock<Box<dyn Plugin>>>>>>,
    /// 消息总线
    message_bus: Arc<MessageBus>,
    /// 依赖管理器
    dependency_manager: Arc<RwLock<DependencyManager>>,
    /// 插件目录
    plugin_dirs: Vec<PathBuf>,
}

impl PluginManager {
    /// 创建新的插件管理器
    pub fn new() -> Self {
        Self {
            plugins: Arc::new(RwLock::new(HashMap::new())),
            message_bus: Arc::new(MessageBus::new()),
            dependency_manager: Arc::new(RwLock::new(DependencyManager::new())),
            plugin_dirs: Vec::new(),
        }
    }
    
    /// 添加插件目录
    pub fn add_plugin_dir(&mut self, path: PathBuf) {
        self.plugin_dirs.push(path);
    }
    
    /// 加载插件
    pub async fn load_plugin(&self, path: PathBuf) -> Result<()>
    {
        // 解析插件元数据
        let metadata = self.parse_plugin_metadata(&path)?;
        
        // 检查插件是否已加载
        let mut plugins = self.plugins.write().await;
        if plugins.contains_key(&metadata.name) {
            return Err("Plugin already loaded".into());
        }
        
        // 创建插件实例
        let mut plugin = Box::new(DynamicPlugin::new(path, metadata.clone()));
        
        // 加载插件
        plugin.initialize().await?;
        plugin.start().await?;
        
        // 添加到插件映射
        plugins.insert(metadata.name, Arc::new(RwLock::new(plugin)));
        
        Ok(())
    }
    
    /// 卸载插件
    pub async fn unload_plugin(&self, name: &str) -> Result<()>
    {
        let mut plugins = self.plugins.write().await;
        if let Some(plugin) = plugins.remove(name) {
            let mut plugin_mut = plugin.write().await;
            plugin_mut.stop().await?;
            plugin_mut.unload().await?;
        }
        Ok(())
    }
    
    /// 启动插件
    pub async fn start_plugin(&self, name: &str) -> Result<()>
    {
        let plugins = self.plugins.read().await;
        if let Some(plugin) = plugins.get(name) {
            let mut plugin_mut = plugin.write().await;
            plugin_mut.start().await?;
        }
        Ok(())
    }
    
    /// 停止插件
    pub async fn stop_plugin(&self, name: &str) -> Result<()>
    {
        let plugins = self.plugins.read().await;
        if let Some(plugin) = plugins.get(name) {
            let mut plugin_mut = plugin.write().await;
            plugin_mut.stop().await?;
        }
        Ok(())
    }
    
    /// 获取插件
    pub async fn get_plugin(&self, name: &str) -> Option<Arc<RwLock<Box<dyn Plugin>>>> {
        let plugins = self.plugins.read().await;
        plugins.get(name).cloned()
    }
    
    /// 获取所有插件
    pub async fn get_all_plugins(&self) -> HashMap<String, Arc<RwLock<Box<dyn Plugin>>>> {
        self.plugins.read().await.clone()
    }
    
    /// 扫描插件目录
    pub async fn scan_plugins(&self) -> Result<Vec<PathBuf>>
    {
        let mut plugins = Vec::new();
        for dir in &self.plugin_dirs {
            if dir.exists() && dir.is_dir() {
                for entry in std::fs::read_dir(dir)? {
                    let entry = entry?;
                    let path = entry.path();
                    if path.is_file() && path.extension().map(|ext| ext == "so").unwrap_or(false) {
                        plugins.push(path);
                    }
                }
            }
        }
        Ok(plugins)
    }
    
    /// 解析插件元数据
    fn parse_plugin_metadata(&self, path: &PathBuf) -> Result<PluginMetadata>
    {
        // 这里应该实现从插件文件中解析元数据的逻辑
        // 暂时返回模拟数据
        Ok(PluginMetadata {
            name: "test-plugin".to_string(),
            version: "1.0.0".to_string(),
            author: "Test Author".to_string(),
            description: "Test plugin".to_string(),
            entry_point: "plugin_entry".to_string(),
            dependencies: Vec::new(),
        })
    }
    
    /// 获取消息总线
    pub fn message_bus(&self) -> Arc<MessageBus> {
        self.message_bus.clone()
    }
    
    /// 获取依赖管理器
    pub fn dependency_manager(&self) -> Arc<RwLock<DependencyManager>> {
        self.dependency_manager.clone()
    }
}
