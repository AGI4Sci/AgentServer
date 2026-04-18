//! API客户端请求处理

use serde::Serialize;
use std::collections::HashMap;

/// API请求方法
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    GET,
    POST,
    PUT,
    DELETE,
    PATCH,
}

impl Method {
    pub fn as_str(&self) -> &'static str {
        match self {
            Method::GET => "GET",
            Method::POST => "POST",
            Method::PUT => "PUT",
            Method::DELETE => "DELETE",
            Method::PATCH => "PATCH",
        }
    }
}

/// API请求
#[derive(Debug, Clone)]
pub struct Request<T: Serialize> {
    /// 请求方法
    pub method: Method,
    /// 请求路径
    pub path: String,
    /// 请求参数
    pub params: Option<HashMap<String, String>>,
    /// 请求头
    pub headers: Option<HashMap<String, String>>,
    /// 请求体
    pub body: Option<T>,
    /// 是否需要认证
    pub auth: bool,
}

impl<T: Serialize> Request<T> {
    /// 创建GET请求
    pub fn get(path: &str) -> Self {
        Self {
            method: Method::GET,
            path: path.to_string(),
            params: None,
            headers: None,
            body: None,
            auth: false,
        }
    }

    /// 创建POST请求
    pub fn post(path: &str, body: T) -> Self {
        Self {
            method: Method::POST,
            path: path.to_string(),
            params: None,
            headers: None,
            body: Some(body),
            auth: false,
        }
    }

    /// 创建PUT请求
    pub fn put(path: &str, body: T) -> Self {
        Self {
            method: Method::PUT,
            path: path.to_string(),
            params: None,
            headers: None,
            body: Some(body),
            auth: false,
        }
    }

    /// 创建DELETE请求
    pub fn delete(path: &str) -> Self {
        Self {
            method: Method::DELETE,
            path: path.to_string(),
            params: None,
            headers: None,
            body: None,
            auth: false,
        }
    }

    /// 创建PATCH请求
    pub fn patch(path: &str, body: T) -> Self {
        Self {
            method: Method::PATCH,
            path: path.to_string(),
            params: None,
            headers: None,
            body: Some(body),
            auth: false,
        }
    }

    /// 添加查询参数
    pub fn with_params(mut self, params: HashMap<String, String>) -> Self {
        self.params = Some(params);
        self
    }

    /// 添加请求头
    pub fn with_headers(mut self, headers: HashMap<String, String>) -> Self {
        self.headers = Some(headers);
        self
    }

    /// 启用认证
    pub fn with_auth(mut self) -> Self {
        self.auth = true;
        self
    }
}