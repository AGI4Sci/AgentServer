//! MCP 协议定义
//! 
//! 实现 MCP (Model Context Protocol) 协议帧的序列化/反序列化

use serde::{Deserialize, Serialize};
use std::time::Duration;

/// MCP 协议版本
pub const MCP_VERSION: &str = "1.0";

/// MCP 协议帧类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum McpFrameType {
    /// 心跳请求
    HeartbeatRequest,
    /// 心跳响应
    HeartbeatResponse,
    /// 数据请求
    DataRequest,
    /// 数据响应
    DataResponse,
    /// 错误消息
    Error,
    /// 认证请求
    AuthRequest,
    /// 认证响应
    AuthResponse,
    /// 资源请求
    ResourceRequest,
    /// 资源响应
    ResourceResponse,
}

/// MCP 协议帧
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpFrame {
    /// 协议版本
    pub version: String,
    /// 帧类型
    pub frame_type: McpFrameType,
    /// 帧 ID
    pub frame_id: String,
    /// 时间戳
    pub timestamp: u64,
    /// 数据
    pub data: serde_json::Value,
    /// 校验和
    pub checksum: Option<String>,
}

/// MCP 心跳请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpHeartbeatRequest {
    /// 客户端 ID
    pub client_id: String,
    /// 客户端版本
    pub client_version: String,
}

/// MCP 心跳响应
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpHeartbeatResponse {
    /// 服务器时间戳
    pub server_timestamp: u64,
    /// 服务器版本
    pub server_version: String,
    /// 服务器状态
    pub server_status: String,
}

/// MCP 错误消息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpError {
    /// 错误代码
    pub code: String,
    /// 错误消息
    pub message: String,
    /// 错误详情
    pub details: Option<serde_json::Value>,
}

/// MCP 认证请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpAuthRequest {
    /// 认证类型
    pub auth_type: String,
    /// 认证数据
    pub auth_data: serde_json::Value,
}

/// MCP 认证响应
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpAuthResponse {
    /// 认证状态
    pub status: bool,
    /// 认证令牌
    pub token: Option<String>,
    /// 过期时间
    pub expires_at: Option<u64>,
}

/// MCP 数据请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpDataRequest {
    /// 数据类型
    pub data_type: String,
    /// 数据操作
    pub operation: String,
    /// 数据内容
    pub data: serde_json::Value,
    /// 超时时间
    pub timeout: Option<u64>,
}

/// MCP 数据响应
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpDataResponse {
    /// 操作状态
    pub status: bool,
    /// 响应数据
    pub data: serde_json::Value,
    /// 响应时间
    pub response_time: u64,
}

/// MCP 资源请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpResourceRequest {
    /// 资源 URI
    pub uri: String,
    /// 资源操作
    pub operation: String,
    /// 操作参数
    pub params: Option<serde_json::Value>,
}

/// MCP 资源响应
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpResourceResponse {
    /// 操作状态
    pub status: bool,
    /// 资源数据
    pub resource: Option<serde_json::Value>,
    /// 资源元数据
    pub metadata: Option<serde_json::Value>,
}

/// MCP 客户端配置
#[derive(Debug, Clone)]
pub struct McpClientConfig {
    /// 服务器地址
    pub server_address: String,
    /// 客户端 ID
    pub client_id: String,
    /// 客户端版本
    pub client_version: String,
    /// 心跳间隔
    pub heartbeat_interval: Duration,
    /// 重连间隔
    pub reconnect_interval: Duration,
    /// 最大重连次数
    pub max_reconnect_attempts: usize,
    /// 认证令牌
    pub auth_token: Option<String>,
    /// 启用加密
    pub enable_encryption: bool,
}

impl Default for McpClientConfig {
    fn default() -> Self {
        Self {
            server_address: "ws://localhost:8080".to_string(),
            client_id: format!("client-{}", uuid::Uuid::new_v4()),
            client_version: env!("CARGO_PKG_VERSION").to_string(),
            heartbeat_interval: Duration::from_secs(30),
            reconnect_interval: Duration::from_secs(5),
            max_reconnect_attempts: 5,
            auth_token: None,
            enable_encryption: false,
        }
    }
}