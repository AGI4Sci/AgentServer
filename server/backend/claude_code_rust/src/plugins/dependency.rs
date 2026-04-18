//! 插件依赖管理
//! 
//! 实现插件依赖的解析和管理，支持插件依赖的安装和加载

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use crate::error::Result;

/// 插件依赖
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PluginDependency {
    /// 依赖名称
    pub name: String,
    /// 依赖版本
    pub version: String,
}

/// 依赖解析器
#[derive(Debug)]
pub struct DependencyResolver {
    /// 插件依赖映射
    dependencies: HashMap<String, Vec<PluginDependency>>,
    /// 已解析的依赖
    resolved: HashSet<PluginDependency>,
}

impl DependencyResolver {
    /// 创建新的依赖解析器
    pub fn new() -> Self {
        Self {
            dependencies: HashMap::new(),
            resolved: HashSet::new(),
        }
    }
    
    /// 添加插件依赖
    pub fn add_plugin_dependencies(&mut self, plugin_name: &str, dependencies: Vec<PluginDependency>) {
        self.dependencies.insert(plugin_name.to_string(), dependencies);
    }
    
    /// 解析依赖
    pub fn resolve(&mut self, plugin_name: &str) -> Result<Vec<PluginDependency>> {
        let mut result = Vec::new();
        let mut visited = HashSet::new();
        self.resolve_recursive(plugin_name, &mut visited, &mut result)?;
        Ok(result)
    }
    
    /// 递归解析依赖
    fn resolve_recursive(&mut self, plugin_name: &str, visited: &mut HashSet<String>, result: &mut Vec<PluginDependency>) -> Result<()>
    {
        if visited.contains(plugin_name) {
            return Ok(());
        }
        
        visited.insert(plugin_name.to_string());
        
        // 先复制依赖列表，避免可变借用冲突
        let deps = self.dependencies.get(plugin_name).cloned();
        if let Some(deps) = deps {
            for dep in deps {
                if !self.resolved.contains(&dep) {
                    self.resolved.insert(dep.clone());
                    result.push(dep.clone());
                    
                    // 递归解析依赖的依赖
                    self.resolve_recursive(&dep.name, visited, result)?;
                }
            }
        }
        
        Ok(())
    }
    
    /// 检查依赖是否已解析
    pub fn is_resolved(&self, dependency: &PluginDependency) -> bool {
        self.resolved.contains(dependency)
    }
    
    /// 获取已解析的依赖
    pub fn resolved_dependencies(&self) -> &HashSet<PluginDependency> {
        &self.resolved
    }
}

/// 依赖管理器
#[derive(Debug)]
pub struct DependencyManager {
    /// 依赖解析器
    resolver: DependencyResolver,
    /// 依赖路径
    dependency_paths: Vec<PathBuf>,
}

impl DependencyManager {
    /// 创建新的依赖管理器
    pub fn new() -> Self {
        Self {
            resolver: DependencyResolver::new(),
            dependency_paths: Vec::new(),
        }
    }
    
    /// 添加依赖路径
    pub fn add_dependency_path(&mut self, path: PathBuf) {
        self.dependency_paths.push(path);
    }
    
    /// 解析插件依赖
    pub fn resolve_dependencies(&mut self, plugin_name: &str) -> Result<Vec<PluginDependency>> {
        self.resolver.resolve(plugin_name)
    }
    
    /// 查找依赖
    pub fn find_dependency(&self, dependency: &PluginDependency) -> Option<PathBuf> {
        for path in &self.dependency_paths {
            let dep_path = path.join(format!("{}-{}.so", dependency.name, dependency.version));
            if dep_path.exists() {
                return Some(dep_path);
            }
        }
        None
    }
}
