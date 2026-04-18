//! API客户端核心实现

use super::config::ApiClientConfig;
use super::error::ApiError;
use super::request::{Request, Method};
use super::response::Response;
use super::retry::{RetryStrategy, ExponentialBackoffStrategy};
use super::compression::{CompressionType, compress_data, get_compression_type};
use reqwest::{Client, ClientBuilder, Request as ReqwestRequest, Response as ReqwestResponse};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use std::sync::Arc;

/// API客户端
#[derive(Clone)]
pub struct ApiClient {
    /// 基础URL
    base_url: String,
    /// HTTP客户端
    client: Arc<Client>,
    /// 配置
    config: ApiClientConfig,
    /// 重试策略
    retry_strategy: Arc<dyn RetryStrategy + Send + Sync>,
    /// API密钥
    api_key: Option<String>,
}

impl ApiClient {
    /// 创建新的API客户端
    pub fn new(base_url: &str, config: ApiClientConfig) -> Self {
        let client = ClientBuilder::new()
            .connect_timeout(config.connect_timeout)
            .timeout(config.read_timeout)
            .build()
            .expect("Failed to create HTTP client");

        let retry_strategy = Arc::new(ExponentialBackoffStrategy::new(
            config.retry_config.max_retries,
            config.retry_config.initial_backoff,
            config.retry_config.max_backoff,
            config.retry_config.backoff_factor,
            config.retry_config.retry_status_codes.clone(),
        ));

        Self {
            base_url: base_url.to_string(),
            client: Arc::new(client),
            config,
            retry_strategy,
            api_key: None,
        }
    }

    /// 设置API密钥
    pub fn with_api_key(mut self, api_key: &str) -> Self {
        self.api_key = Some(api_key.to_string());
        self
    }

    /// 发送请求
    pub async fn send<T: Serialize, R: serde::de::DeserializeOwned>(
        &self,
        request: Request<T>,
    ) -> Result<Response<R>, ApiError> {
        let start_time = std::time::Instant::now();
        
        let mut attempt = 0;
        loop {
            match self.send_once(&request).await {
                Ok(response) => {
                    let duration = start_time.elapsed().as_millis() as u64;
                    return Ok(Response {
                        status: response.status().into(),
                        headers: self.headers_to_json(&response),
                        body: self.parse_response::<R>(response).await?,
                        duration,
                    });
                }
                Err(error) => {
                    if self.retry_strategy.should_retry(&error, attempt) {
                        attempt += 1;
                        let backoff = self.retry_strategy.get_backoff(attempt);
                        tokio::time::sleep(backoff).await;
                        continue;
                    }
                    return Err(error);
                }
            }
        }
    }

    /// 发送单次请求
    async fn send_once<T: Serialize>(
        &self,
        request: &Request<T>,
    ) -> Result<ReqwestResponse, ApiError> {
        let url = self.build_url(&request.path, request.params.as_ref());
        let mut req_builder = match request.method {
            Method::GET => self.client.get(&url),
            Method::POST => self.client.post(&url),
            Method::PUT => self.client.put(&url),
            Method::DELETE => self.client.delete(&url),
            Method::PATCH => self.client.patch(&url),
        };

        // 设置请求头
        if let Some(headers) = &request.headers {
            for (key, value) in headers {
                req_builder = req_builder.header(key, value);
            }
        }

        // 设置认证头
        if request.auth {
            if let Some(api_key) = &self.api_key {
                req_builder = req_builder.header("Authorization", format!("Bearer {}", api_key));
            }
        }

        // 设置请求体
        if let Some(body) = &request.body {
            let body_json = serde_json::to_vec(body)?;
            
            if self.config.enable_compression {
                let compression_type = CompressionType::Gzip;
                let compressed_body = compress_data(&body_json, compression_type)?;
                req_builder = req_builder
                    .header("Content-Encoding", "gzip")
                    .header("Content-Length", compressed_body.len())
                    .body(compressed_body);
            } else {
                req_builder = req_builder.json(body);
            }
        }

        // 发送请求
        let response = req_builder.send().await?;

        // 检查响应状态
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let message = response.text().await.unwrap_or_default();
            return Err(ApiError::Http { status, message });
        }

        Ok(response)
    }

    /// 构建URL
    fn build_url(&self, path: &str, params: Option<&std::collections::HashMap<String, String>>) -> String {
        let mut url = self.base_url.clone();
        if !url.ends_with('/') && !path.starts_with('/') {
            url.push('/');
        }
        url.push_str(path);

        if let Some(params) = params {
            if !params.is_empty() {
                url.push('?');
                let mut first = true;
                for (key, value) in params {
                    if !first {
                        url.push('&');
                    }
                    url.push_str(&urlencoding::encode(key));
                    url.push('=');
                    url.push_str(&urlencoding::encode(value));
                    first = false;
                }
            }
        }

        url
    }

    /// 解析响应
    async fn parse_response<R: serde::de::DeserializeOwned>(
        &self,
        response: ReqwestResponse,
    ) -> Result<Option<R>, ApiError> {
        let body = response.bytes().await?;
        if body.is_empty() {
            return Ok(None);
        }

        let body_vec = body.to_vec();
        let response: R = serde_json::from_slice(&body_vec)?;
        Ok(Some(response))
    }

    /// 将响应头转换为JSON
    fn headers_to_json(&self, response: &ReqwestResponse) -> serde_json::Value {
        let mut headers = serde_json::Map::new();
        for (key, value) in response.headers() {
            if let Ok(value_str) = value.to_str() {
                headers.insert(key.as_str().to_string(), serde_json::Value::String(value_str.to_string()));
            }
        }
        serde_json::Value::Object(headers)
    }

    /// 发送GET请求
    pub async fn get<R: serde::de::DeserializeOwned>(&self, path: &str) -> Result<Response<R>, ApiError> {
        self.send(Request::<()>::get(path)).await
    }

    /// 发送POST请求
    pub async fn post<T: Serialize, R: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        body: T,
    ) -> Result<Response<R>, ApiError> {
        self.send(Request::post(path, body)).await
    }

    /// 发送PUT请求
    pub async fn put<T: Serialize, R: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        body: T,
    ) -> Result<Response<R>, ApiError> {
        self.send(Request::put(path, body)).await
    }

    /// 发送DELETE请求
    pub async fn delete<R: serde::de::DeserializeOwned>(&self, path: &str) -> Result<Response<R>, ApiError> {
        self.send(Request::<()>::delete(path)).await
    }

    /// 发送PATCH请求
    pub async fn patch<T: Serialize, R: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        body: T,
    ) -> Result<Response<R>, ApiError> {
        self.send(Request::patch(path, body)).await
    }
}