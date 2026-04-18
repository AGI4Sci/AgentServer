//! MCP 客户端实现
//! 
//! 实现 MCP (Model Context Protocol) 客户端功能

use super::protocol::*;
use crate::error::Result;
use futures::SinkExt;
use futures::StreamExt;
use std::sync::Arc;
use std::time::{Instant, Duration};
use tokio::net::TcpStream;
use tokio::sync::{RwLock, mpsc};
use tokio::time::{interval, timeout};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, WebSocketStream, MaybeTlsStream};

/// MCP 客户端状态
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpClientState {
    /// 已断开
    Disconnected,
    /// 连接中
    Connecting,
    /// 已连接
    Connected,
    /// 认证中
    Authenticating,
    /// 错误
    Error,
}

/// MCP 客户端
pub struct McpClient {
    /// 配置
    config: McpClientConfig,
    /// 客户端状态
    state: Arc<RwLock<McpClientState>>,
    /// WebSocket 连接
    ws_stream: Arc<RwLock<Option<WebSocketStream<MaybeTlsStream<TcpStream>>>>>,
    /// 消息发送通道
    tx: Arc<RwLock<Option<mpsc::Sender<McpFrame>>>>,
    /// 重连尝试次数
    reconnect_attempts: Arc<RwLock<usize>>,
    /// 连接时间
    connected_since: Arc<RwLock<Option<Instant>>>,
}

impl McpClient {
    /// 创建新的 MCP 客户端
    pub fn new(config: McpClientConfig) -> Self {
        Self {
            config,
            state: Arc::new(RwLock::new(McpClientState::Disconnected)),
            ws_stream: Arc::new(RwLock::new(None)),
            tx: Arc::new(RwLock::new(None)),
            reconnect_attempts: Arc::new(RwLock::new(0)),
            connected_since: Arc::new(RwLock::new(None)),
        }
    }

    /// 连接到 MCP 服务器
    pub async fn connect(&self) -> Result<()> {
        *self.state.write().await = McpClientState::Connecting;
        
        let url = url::Url::parse(&self.config.server_address)?;
        let (ws_stream, _) = connect_async(url).await?;
        
        // 创建消息通道
        let (tx, mut rx) = mpsc::channel(100);
        *self.tx.write().await = Some(tx);
        
        *self.ws_stream.write().await = Some(ws_stream);
        *self.state.write().await = McpClientState::Connected;
        *self.connected_since.write().await = Some(Instant::now());
        *self.reconnect_attempts.write().await = 0;
        
        // 启动心跳任务
        self.start_heartbeat().await;
        
        Ok(())
    }

    /// 断开连接
    pub async fn disconnect(&self) -> Result<()> {
        *self.state.write().await = McpClientState::Disconnected;
        
        // 关闭 WebSocket 连接
        let mut ws_stream_write = self.ws_stream.write().await;
        if let Some(mut ws) = ws_stream_write.take() {
            ws.close(None).await?;
        }
        
        // 关闭消息通道
        *self.tx.write().await = None;
        
        Ok(())
    }

    /// 发送心跳
    async fn send_heartbeat(&self) -> Result<()> {
        let frame = McpFrame {
            version: MCP_VERSION.to_string(),
            frame_type: McpFrameType::HeartbeatRequest,
            frame_id: uuid::Uuid::new_v4().to_string(),
            timestamp: chrono::Utc::now().timestamp_millis() as u64,
            data: serde_json::to_value(McpHeartbeatRequest {
                client_id: self.config.client_id.clone(),
                client_version: self.config.client_version.clone(),
            })?,
            checksum: None,
        };
        
        self.send_frame(frame).await
    }

    /// 启动心跳
    async fn start_heartbeat(&self) {
        let interval = interval(self.config.heartbeat_interval);
        
        let state = self.state.clone();
        let client = self.clone();
        tokio::spawn(async move {
            let mut interval = interval;
            loop {
                interval.tick().await;
                
                let current_state = *state.read().await;
                if current_state == McpClientState::Connected {
                    if client.send_heartbeat().await.is_err() {
                        break;
                    }
                }
            }
        });
    }

    /// 发送帧
    pub async fn send_frame(&self, frame: McpFrame) -> Result<()> {
        if let Some(tx) = &*self.tx.read().await {
            tx.send(frame).await?;
        } else {
            return Err("Not connected".into());
        }
        Ok(())
    }

    /// 发送数据请求
    pub async fn send_data_request(&self, data_type: &str, operation: &str, data: serde_json::Value) -> Result<McpDataResponse> {
        let frame = McpFrame {
            version: MCP_VERSION.to_string(),
            frame_type: McpFrameType::DataRequest,
            frame_id: uuid::Uuid::new_v4().to_string(),
            timestamp: chrono::Utc::now().timestamp_millis() as u64,
            data: serde_json::to_value(McpDataRequest {
                data_type: data_type.to_string(),
                operation: operation.to_string(),
                data,
                timeout: Some(30000),
            })?,
            checksum: None,
        };
        
        self.send_frame(frame).await?;
        
        // 这里应该等待响应，暂时返回模拟结果
        Ok(McpDataResponse {
            status: true,
            data: serde_json::Value::Null,
            response_time: 0,
        })
    }

    /// 发送认证请求
    pub async fn send_auth_request(&self, auth_type: &str, auth_data: serde_json::Value) -> Result<McpAuthResponse> {
        let frame = McpFrame {
            version: MCP_VERSION.to_string(),
            frame_type: McpFrameType::AuthRequest,
            frame_id: uuid::Uuid::new_v4().to_string(),
            timestamp: chrono::Utc::now().timestamp_millis() as u64,
            data: serde_json::to_value(McpAuthRequest {
                auth_type: auth_type.to_string(),
                auth_data,
            })?,
            checksum: None,
        };
        
        self.send_frame(frame).await?;
        
        // 这里应该等待响应，暂时返回模拟结果
        Ok(McpAuthResponse {
            status: true,
            token: Some("mock-token".to_string()),
            expires_at: Some(chrono::Utc::now().timestamp_millis() as u64 + 3600000),
        })
    }

    /// 获取客户端状态
    pub async fn get_state(&self) -> McpClientState {
        *self.state.read().await
    }

    /// 获取连接时间
    pub async fn get_uptime(&self) -> Option<Duration> {
        self.connected_since.read().await.as_ref().map(|t| t.elapsed())
    }
}

impl Clone for McpClient {
    fn clone(&self) -> Self {
        Self {
            config: self.config.clone(),
            state: self.state.clone(),
            ws_stream: self.ws_stream.clone(),
            tx: self.tx.clone(),
            reconnect_attempts: self.reconnect_attempts.clone(),
            connected_since: self.connected_since.clone(),
        }
    }
}
