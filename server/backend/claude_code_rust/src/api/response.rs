//! API客户端响应处理

use serde::{Deserialize};

/// API响应
#[derive(Debug, Clone, Deserialize)]
pub struct Response<T> {
    /// 响应状态码
    pub status: u16,
    /// 响应头
    pub headers: serde_json::Value,
    /// 响应体
    pub body: Option<T>,
    /// 响应时间
    pub duration: u64,
}

impl<T> Response<T> where T: Deserialize<'static> {
    pub fn new(status: u16, headers: serde_json::Value, body: Option<T>, duration: u64) -> Self {
        Self {
            status,
            headers,
            body,
            duration,
        }
    }
}

/// 通用错误响应
#[derive(Debug, Clone, Deserialize)]
pub struct ErrorResponse {
    /// 错误代码
    pub code: String,
    /// 错误消息
    pub message: String,
    /// 错误详情
    pub details: Option<serde_json::Value>,
}

/// 分页响应
#[derive(Debug, Clone, Deserialize)]
pub struct PaginatedResponse<T> {
    /// 数据列表
    pub data: Vec<T>,
    /// 分页信息
    pub pagination: Pagination,
}

impl<T> PaginatedResponse<T> where T: Deserialize<'static> {
    pub fn new(data: Vec<T>, pagination: Pagination) -> Self {
        Self {
            data,
            pagination,
        }
    }
}

/// 分页信息
#[derive(Debug, Clone, Deserialize)]
pub struct Pagination {
    /// 当前页
    pub page: u32,
    /// 每页大小
    pub page_size: u32,
    /// 总页数
    pub total_pages: u32,
    /// 总数据量
    pub total_items: u64,
}