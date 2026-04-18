//! API客户端配置

use std::time::Duration;

/// API客户端配置
#[derive(Debug, Clone)]
pub struct ApiClientConfig {
    /// 连接超时
    pub connect_timeout: Duration,
    /// 读取超时
    pub read_timeout: Duration,
    /// 写入超时
    pub write_timeout: Duration,
    /// 是否启用压缩
    pub enable_compression: bool,
    /// 重试策略配置
    pub retry_config: RetryConfig,
    /// 连接池配置
    pub pool_config: PoolConfig,
}

/// 重试策略配置
#[derive(Debug, Clone)]
pub struct RetryConfig {
    /// 最大重试次数
    pub max_retries: usize,
    /// 初始重试间隔
    pub initial_backoff: Duration,
    /// 最大重试间隔
    pub max_backoff: Duration,
    /// 重试指数因子
    pub backoff_factor: f64,
    /// 重试的HTTP状态码
    pub retry_status_codes: Vec<u16>,
}

/// 连接池配置
#[derive(Debug, Clone)]
pub struct PoolConfig {
    /// 最大连接数
    pub max_connections: usize,
    /// 空闲连接超时
    pub idle_timeout: Duration,
}

impl Default for ApiClientConfig {
    fn default() -> Self {
        Self {
            connect_timeout: Duration::from_secs(10),
            read_timeout: Duration::from_secs(30),
            write_timeout: Duration::from_secs(15),
            enable_compression: true,
            retry_config: RetryConfig::default(),
            pool_config: PoolConfig::default(),
        }
    }
}

impl Default for RetryConfig {
    fn default() -> Self {
        Self {
            max_retries: 3,
            initial_backoff: Duration::from_millis(500),
            max_backoff: Duration::from_secs(10),
            backoff_factor: 2.0,
            retry_status_codes: vec![429, 500, 502, 503, 504],
        }
    }
}

impl Default for PoolConfig {
    fn default() -> Self {
        Self {
            max_connections: 100,
            idle_timeout: Duration::from_secs(60),
        }
    }
}