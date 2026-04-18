//! API客户端错误处理

use std::fmt;
use std::io;
use reqwest::Error as ReqwestError;

/// API客户端错误
#[derive(Debug)]
pub enum ApiError {
    /// 网络错误
    Network(ReqwestError),
    /// HTTP错误
    Http { status: u16, message: String },
    /// 超时错误
    Timeout,
    /// 序列化错误
    Serialization(serde_json::Error),
    /// 压缩错误
    Compression(io::Error),
    /// 业务逻辑错误
    Business { code: String, message: String },
    /// 其他错误
    Other(String),
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ApiError::Network(e) => write!(f, "网络错误: {}", e),
            ApiError::Http { status, message } => write!(f, "HTTP错误 {}: {}", status, message),
            ApiError::Timeout => write!(f, "请求超时"),
            ApiError::Serialization(e) => write!(f, "序列化错误: {}", e),
            ApiError::Compression(e) => write!(f, "压缩错误: {}", e),
            ApiError::Business { code, message } => write!(f, "业务错误 [{}]: {}", code, message),
            ApiError::Other(e) => write!(f, "其他错误: {}", e),
        }
    }
}

impl std::error::Error for ApiError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            ApiError::Network(e) => Some(e),
            ApiError::Serialization(e) => Some(e),
            ApiError::Compression(e) => Some(e),
            _ => None,
        }
    }
}

impl From<ReqwestError> for ApiError {
    fn from(e: ReqwestError) -> Self {
        if e.is_timeout() {
            ApiError::Timeout
        } else {
            ApiError::Network(e)
        }
    }
}

impl From<serde_json::Error> for ApiError {
    fn from(e: serde_json::Error) -> Self {
        ApiError::Serialization(e)
    }
}

impl From<io::Error> for ApiError {
    fn from(e: io::Error) -> Self {
        ApiError::Compression(e)
    }
}