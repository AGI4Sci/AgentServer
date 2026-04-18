//! 消息总线
//! 
//! 实现插件间的低耦合通信，通过消息总线传递消息

use std::sync::Arc;
use tokio::sync::{RwLock, broadcast};
use serde::{Deserialize, Serialize};
use async_stream::stream;
use futures::Stream;
use crate::error::Result;

/// 消息类型
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginMessage {
    /// 消息类型
    pub message_type: String,
    /// 消息数据
    pub data: String,
    /// 发送者
    pub sender: String,
    /// 目标
    pub target: Option<String>,
}

/// 消息总线
#[derive(Debug, Clone)]
pub struct MessageBus {
    /// 广播发送器
    tx: Arc<broadcast::Sender<PluginMessage>>,
    /// 订阅者数量
    subscribers: Arc<RwLock<usize>>,
}

impl MessageBus {
    /// 创建新的消息总线
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(100);
        Self {
            tx: Arc::new(tx),
            subscribers: Arc::new(RwLock::new(0)),
        }
    }
    
    /// 发送消息
    pub fn send(&self, message: PluginMessage) -> Result<()>
    {
        self.tx.send(message)?;
        Ok(())
    }
    
    /// 订阅消息
    pub fn subscribe(&self) -> broadcast::Receiver<PluginMessage>
    {
        let rx = self.tx.subscribe();
        let subscribers = self.subscribers.clone();
        tokio::spawn(async move {
            let mut count = subscribers.write().await;
            *count += 1;
        });
        rx
    }
    
    /// 订阅特定类型的消息
    pub fn subscribe_with_filter<F>(&self, filter: F) -> impl futures::Stream<Item = PluginMessage>
    where
        F: Fn(&PluginMessage) -> bool + Send + Sync + 'static,
    {
        let rx = self.subscribe();
        Box::pin(async_stream::stream! {
            let mut rx = rx;
            loop {
                match rx.recv().await {
                    Ok(msg) if filter(&msg) => yield msg,
                    Ok(_) => continue,
                    Err(_) => break,
                }
            }
        })
    }
    
    /// 获取订阅者数量
    pub async fn subscriber_count(&self) -> usize {
        *self.subscribers.read().await
    }
}
