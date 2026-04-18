//! 工具注册表模块
//! 
//! 管理工具的注册、加载和检索

use super::base::Tool;
use super::types::ToolMetadata;
use crate::error::Result;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::RwLock;

/// 工具加载器 trait
#[async_trait::async_trait]
pub trait ToolLoader: Send + Sync {
    /// 加载工具到注册表
    async fn load(&self, registry: &ToolRegistry) -> Result<()>;
    
    /// 获取加载器名称
    fn name(&self) -> &str;
}

/// 工具注册表
/// 
/// 负责存储和管理所有注册的工具
#[derive(Clone)]
pub struct ToolRegistry {
    /// 工具映射（名称 -> 工具）
    tools: Arc<RwLock<HashMap<String, Arc<dyn Tool>>>>,
    /// 别名映射（别名 -> 工具名称）
    aliases: Arc<RwLock<HashMap<String, String>>>,
}

impl ToolRegistry {
    /// 创建新的工具注册表
    pub fn new() -> Self {
        Self {
            tools: Arc::new(RwLock::new(HashMap::new())),
            aliases: Arc::new(RwLock::new(HashMap::new())),
        }
    }
    
    /// 注册工具
    pub async fn register<T: Tool + 'static>(&self, tool: T) {
        let metadata = tool.metadata();
        let tool_arc = Arc::new(tool);
        
        let mut tools = self.tools.write().await;
        tools.insert(metadata.name.clone(), tool_arc);
        
        let mut aliases = self.aliases.write().await;
        if let Some(tool_aliases) = metadata.aliases {
            for alias in tool_aliases {
                aliases.insert(alias, metadata.name.clone());
            }
        }
        
        // 注册小写别名
        let lowercase_name = metadata.name.to_lowercase();
        if lowercase_name != metadata.name {
            aliases.insert(lowercase_name, metadata.name.clone());
        }
    }
    
    /// 获取工具
    pub async fn get(&self, name: &str) -> Option<Arc<dyn Tool>> {
        let tools = self.tools.read().await;
        let aliases = self.aliases.read().await;
        
        // 先尝试直接查找
        if let Some(tool) = tools.get(name) {
            return Some(tool.clone());
        }
        
        // 尝试通过别名查找
        if let Some(real_name) = aliases.get(name) {
            if let Some(tool) = tools.get(real_name) {
                return Some(tool.clone());
            }
        }
        
        None
    }
    
    /// 检查工具是否存在
    pub async fn has(&self, name: &str) -> bool {
        self.get(name).await.is_some()
    }
    
    /// 获取工具数量
    pub async fn len(&self) -> usize {
        self.tools.read().await.len()
    }
    
    /// 获取所有工具名称
    pub async fn tool_names(&self) -> Vec<String> {
        self.tools.read().await.keys().cloned().collect()
    }
    
    /// 获取所有工具元数据
    pub async fn tool_metadata(&self) -> Vec<ToolMetadata> {
        self.tools.read().await.values()
            .map(|tool| tool.metadata())
            .collect()
    }
}

/// 工具管理器
/// 
/// 负责管理工具加载器和加载工具
#[derive(Clone)]
pub struct ToolManager {
    /// 工具注册表
    registry: ToolRegistry,
    /// 工具加载器
    loaders: Arc<RwLock<Vec<Box<dyn ToolLoader>>>>,
}

impl ToolManager {
    /// 创建新的工具管理器
    pub fn new() -> Self {
        Self {
            registry: ToolRegistry::new(),
            loaders: Arc::new(RwLock::new(Vec::new())),
        }
    }
    
    /// 添加工具加载器
    pub fn add_loader<T: ToolLoader + 'static>(&mut self, loader: T) {
        let mut loaders = self.loaders.try_write().expect("Failed to acquire write lock");
        loaders.push(Box::new(loader));
    }
    
    /// 加载所有工具
    pub async fn load_all(&mut self) -> Result<()> {
        let loaders = self.loaders.read().await;
        
        for loader in loaders.iter() {
            tracing::debug!("Loading tools from {}", loader.name());
            loader.load(&self.registry).await?;
        }
        
        Ok(())
    }
    
    /// 获取工具注册表
    pub fn registry(&self) -> &ToolRegistry {
        &self.registry
    }
    
    /// 获取工具
    pub async fn get_tool(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.registry.get(name).await
    }
    
    /// 检查工具是否存在
    pub async fn has_tool(&self, name: &str) -> bool {
        self.registry.has(name).await
    }
    
    /// 获取工具数量
    pub async fn tool_count(&self) -> usize {
        self.registry.len().await
    }
    
    /// 获取所有工具名称
    pub async fn tool_names(&self) -> Vec<String> {
        self.registry.tool_names().await
    }
    
    /// 获取所有工具元数据
    pub async fn tool_metadata(&self) -> Vec<ToolMetadata> {
        self.registry.tool_metadata().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use super::super::types::{ToolUseContext, ToolResult, ToolCategory, ToolPermissionLevel};
    
    struct TestTool;
    
    #[async_trait]
    impl Tool for TestTool {
        fn metadata(&self) -> ToolMetadata {
            super::super::base::ToolBuilder::new("test", "Test tool")
                .category(ToolCategory::Other)
                .aliases(vec!["t".to_string()])
                .build_metadata()
        }
        
        async fn execute(
            &self,
            _input: serde_json::Value,
            _context: ToolUseContext,
        ) -> Result<ToolResult> {
            Ok(ToolResult::success(serde_json::json!("ok")))
        }
    }
    
    #[tokio::test]
    async fn test_register_tool() {
        let registry = ToolRegistry::new();
        registry.register(TestTool).await;
        
        assert!(registry.has("test").await);
        assert!(registry.has("t").await);
        assert_eq!(registry.len().await, 1);
    }
    
    #[tokio::test]
    async fn test_get_tool() {
        let registry = ToolRegistry::new();
        registry.register(TestTool).await;
        
        let tool = registry.get("test").await;
        assert!(tool.is_some());
        
        let tool_by_alias = registry.get("t").await;
        assert!(tool_by_alias.is_some());
    }
    
    #[tokio::test]
    async fn test_tool_manager() {
        let mut manager = ToolManager::new();
        
        struct TestLoader;
        
        #[async_trait]
        impl ToolLoader for TestLoader {
            async fn load(&self, registry: &ToolRegistry) -> Result<()> {
                registry.register(TestTool).await;
                Ok(())
            }
            
            fn name(&self) -> &str {
                "test"
            }
        }
        
        manager.add_loader(TestLoader);
        manager.load_all().await.unwrap();
        
        assert!(manager.has_tool("test").await);
        assert_eq!(manager.tool_count().await, 1);
    }
}