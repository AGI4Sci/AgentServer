//! 插件系统
//! 
//! 设计并实现基于Rust的安全插件架构，支持动态加载/卸载ELF格式插件

pub mod manager;
pub mod plugin;
pub mod api;
pub mod message_bus;
pub mod lifecycle;
pub mod dependency;

pub use manager::PluginManager;
pub use plugin::Plugin;
pub use api::PluginApi;
pub use message_bus::MessageBus;
pub use lifecycle::PluginLifecycle;
pub use dependency::PluginDependency;
