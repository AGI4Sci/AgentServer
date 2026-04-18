//! API客户端重试策略

use std::time::Duration;
use super::error::ApiError;

/// 重试策略
pub trait RetryStrategy {
    /// 检查是否需要重试
    fn should_retry(&self, error: &ApiError, attempt: usize) -> bool;
    
    /// 获取重试间隔
    fn get_backoff(&self, attempt: usize) -> Duration;
}

/// 指数退避重试策略
#[derive(Debug, Clone)]
pub struct ExponentialBackoffStrategy {
    /// 最大重试次数
    max_retries: usize,
    /// 初始退避时间
    initial_backoff: Duration,
    /// 最大退避时间
    max_backoff: Duration,
    /// 退避因子
    backoff_factor: f64,
    /// 可重试的HTTP状态码
    retry_status_codes: Vec<u16>,
}

impl ExponentialBackoffStrategy {
    pub fn new(
        max_retries: usize,
        initial_backoff: Duration,
        max_backoff: Duration,
        backoff_factor: f64,
        retry_status_codes: Vec<u16>,
    ) -> Self {
        Self {
            max_retries,
            initial_backoff,
            max_backoff,
            backoff_factor,
            retry_status_codes,
        }
    }
}

impl RetryStrategy for ExponentialBackoffStrategy {
    fn should_retry(&self, error: &ApiError, attempt: usize) -> bool {
        if attempt >= self.max_retries {
            return false;
        }
        
        match error {
            ApiError::Network(_) | ApiError::Timeout => true,
            ApiError::Http { status, .. } => self.retry_status_codes.contains(status),
            _ => false,
        }
    }
    
    fn get_backoff(&self, attempt: usize) -> Duration {
        let backoff = self.initial_backoff.as_secs_f64() * (self.backoff_factor.powi(attempt as i32));
        let backoff_duration = Duration::from_secs_f64(backoff);
        
        std::cmp::min(backoff_duration, self.max_backoff)
    }
}