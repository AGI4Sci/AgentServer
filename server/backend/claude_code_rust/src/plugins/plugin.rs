//! 插件定义
//! 
//! 定义插件的基本结构和特质

use std::fmt::Debug;
use std::path::PathBuf;
use crate::error::Result;

/// 插件状态
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PluginState {
    /// 未加载
    Unloaded,
    /// 加载中
    Loading,
    /// 已加载
    Loaded,
    /// 运行中
    Running,
    /// 错误
    Error,
    /// 正在卸载
    Unloading,
}

/// 插件元数据
#[derive(Debug, Clone)]
pub struct PluginMetadata {
    /// 插件名称
    pub name: String,
    /// 插件版本
    pub version: String,
    /// 插件作者
    pub author: String,
    /// 插件描述
    pub description: String,
    /// 插件入口点
    pub entry_point: String,
    /// 插件依赖
    pub dependencies: Vec<String>,
}

/// 插件特质
#[async_trait::async_trait]
pub trait Plugin: Debug + Send + Sync {
    /// 获取插件元数据
    fn metadata(&self) -> &PluginMetadata;
    
    /// 获取插件状态
    fn state(&self) -> PluginState;
    
    /// 初始化插件
    async fn initialize(&mut self) -> Result<()>;
    
    /// 启动插件
    async fn start(&mut self) -> Result<()>;
    
    /// 停止插件
    async fn stop(&mut self) -> Result<()>;
    
    /// 卸载插件
    async fn unload(&mut self) -> Result<()>;
    
    /// 处理消息
    async fn handle_message(&mut self, message: &str) -> Result<Option<String>>;
}

/// 动态加载插件
#[derive(Debug)]
pub struct DynamicPlugin {
    /// 插件路径
    path: PathBuf,
    /// 插件元数据
    metadata: PluginMetadata,
    /// 插件状态
    state: PluginState,
    /// 插件句柄
    handle: Option<libloading::Library>,
}

impl DynamicPlugin {
    /// 创建新的动态插件
    pub fn new(path: PathBuf, metadata: PluginMetadata) -> Self {
        Self {
            path,
            metadata,
            state: PluginState::Unloaded,
            handle: None,
        }
    }
}

#[async_trait::async_trait]
impl Plugin for DynamicPlugin {
    fn metadata(&self) -> &PluginMetadata {
        &self.metadata
    }
    
    fn state(&self) -> PluginState {
        self.state
    }
    
    async fn initialize(&mut self) -> Result<()> {
        self.state = PluginState::Loading;
        // 加载插件库
        let handle = unsafe {
            libloading::Library::new(&self.path)?
        };
        self.handle = Some(handle);
        self.state = PluginState::Loaded;
        Ok(())
    }
    
    async fn start(&mut self) -> Result<()> {
        self.state = PluginState::Running;
        Ok(())
    }
    
    async fn stop(&mut self) -> Result<()> {
        self.state = PluginState::Loaded;
        Ok(())
    }
    
    async fn unload(&mut self) -> Result<()> {
        self.state = PluginState::Unloading;
        self.handle = None;
        self.state = PluginState::Unloaded;
        Ok(())
    }
    
    async fn handle_message(&mut self, message: &str) -> Result<Option<String>> {
        Ok(None)
    }
}
