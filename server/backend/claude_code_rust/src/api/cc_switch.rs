//! CCSwitch API客户端
//! 
//! 用于与CCSwitch进行交互的API客户端

use crate::error::Result;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// CCSwitch应用ID
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AppId {
    /// OpenCode应用
    OpenCode,
    /// OpenClaw应用
    OpenClaw,
}

impl AppId {
    /// 转换为字符串
    pub fn as_str(&self) -> &'static str {
        match self {
            AppId::OpenCode => "opencode",
            AppId::OpenClaw => "openclaw",
        }
    }
}

/// 提供商排序更新
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderSortUpdate {
    /// 提供商ID
    pub id: String,
    /// 排序索引
    pub sort_index: u32,
}

/// 提供商切换事件
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderSwitchEvent {
    /// 应用类型
    pub app_type: AppId,
    /// 提供商ID
    pub provider_id: String,
}

/// 切换结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SwitchResult {
    /// 警告信息
    pub warnings: Vec<String>,
}

/// 打开终端选项
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenTerminalOptions {
    /// 工作目录
    pub cwd: Option<PathBuf>,
}

/// 提供商信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Provider {
    /// 提供商ID
    pub id: String,
    /// 提供商名称
    pub name: String,
    /// 提供商类型
    pub r#type: String,
    /// 提供商配置
    pub config: serde_json::Value,
    /// 排序索引
    pub sort_index: u32,
    /// 是否启用
    pub enabled: bool,
}

/// 统一提供商
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UniversalProvider {
    /// 提供商ID
    pub id: String,
    /// 提供商名称
    pub name: String,
    /// 提供商类型
    pub r#type: String,
    /// 提供商配置
    pub config: serde_json::Value,
    /// 适用的应用
    pub apps: Vec<AppId>,
}

/// 统一提供商映射
pub type UniversalProvidersMap = std::collections::HashMap<String, UniversalProvider>;

/// CCSwitch API客户端
#[derive(Debug, Clone)]
pub struct CcSwitchClient {
    /// API基础URL
    base_url: String,
    /// 内部HTTP客户端
    client: reqwest::Client,
}

impl CcSwitchClient {
    /// 创建新的CCSwitch客户端
    pub fn new(base_url: &str) -> Self {
        let client = reqwest::ClientBuilder::new()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("Failed to create HTTP client");

        Self {
            base_url: base_url.to_string(),
            client,
        }
    }

    /// 获取所有提供商
    pub async fn get_all_providers(&self, app_id: AppId) -> Result<std::collections::HashMap<String, Provider>> {
        let url = format!("{}/api/providers", self.base_url);
        let response = self.client
            .get(&url)
            .query(&[(&"app", app_id.as_str())])
            .send()
            .await?;

        response.json().await.map_err(Into::into)
    }

    /// 获取当前提供商
    pub async fn get_current_provider(&self, app_id: AppId) -> Result<String> {
        let url = format!("{}/api/providers/current", self.base_url);
        let response = self.client
            .get(&url)
            .query(&[(&"app", app_id.as_str())])
            .send()
            .await?;

        response.text().await.map_err(Into::into)
    }

    /// 添加提供商
    pub async fn add_provider(&self, provider: Provider, app_id: AppId) -> Result<bool> {
        let url = format!("{}/api/providers", self.base_url);
        let response = self.client
            .post(&url)
            .query(&[(&"app", app_id.as_str())])
            .json(&provider)
            .send()
            .await?;

        response.json().await.map_err(Into::into)
    }

    /// 更新提供商
    pub async fn update_provider(&self, provider: Provider, app_id: AppId) -> Result<bool> {
        let url = format!("{}/api/providers", self.base_url);
        let response = self.client
            .put(&url)
            .query(&[(&"app", app_id.as_str())])
            .json(&provider)
            .send()
            .await?;

        response.json().await.map_err(Into::into)
    }

    /// 删除提供商
    pub async fn delete_provider(&self, id: &str, app_id: AppId) -> Result<bool> {
        let url = format!("{}/api/providers/{}", self.base_url, id);
        let response = self.client
            .delete(&url)
            .query(&[(&"app", app_id.as_str())])
            .send()
            .await?;

        response.json().await.map_err(Into::into)
    }

    /// 切换提供商
    pub async fn switch_provider(&self, id: &str, app_id: AppId) -> Result<SwitchResult> {
        let url = format!("{}/api/providers/switch", self.base_url);
        let response = self.client
            .post(&url)
            .query(&[(&"app", app_id.as_str()), (&"id", id)])
            .send()
            .await?;

        response.json().await.map_err(Into::into)
    }

    /// 打开提供商终端
    pub async fn open_terminal(&self, provider_id: &str, app_id: AppId, options: Option<OpenTerminalOptions>) -> Result<bool> {
        let url = format!("{}/api/providers/terminal", self.base_url);
        let mut request = self.client
            .post(&url)
            .query(&[(&"app", app_id.as_str()), (&"providerId", provider_id)]);

        if let Some(options) = options {
            request = request.json(&options);
        }

        let response = request.send().await?;
        response.json().await.map_err(Into::into)
    }

    /// 获取所有统一提供商
    pub async fn get_all_universal_providers(&self) -> Result<UniversalProvidersMap> {
        let url = format!("{}/api/universal-providers", self.base_url);
        let response = self.client.get(&url).send().await?;

        response.json().await.map_err(Into::into)
    }

    /// 添加或更新统一提供商
    pub async fn upsert_universal_provider(&self, provider: UniversalProvider) -> Result<bool> {
        let url = format!("{}/api/universal-providers", self.base_url);
        let response = self.client
            .post(&url)
            .json(&provider)
            .send()
            .await?;

        response.json().await.map_err(Into::into)
    }

    /// 删除统一提供商
    pub async fn delete_universal_provider(&self, id: &str) -> Result<bool> {
        let url = format!("{}/api/universal-providers/{}", self.base_url, id);
        let response = self.client.delete(&url).send().await?;

        response.json().await.map_err(Into::into)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_cc_switch_client() {
        // 测试CCSwitch客户端创建
        let client = CcSwitchClient::new("http://localhost:3000");
        assert_eq!(client.base_url, "http://localhost:3000");
    }

    #[test]
    fn test_app_id_as_str() {
        assert_eq!(AppId::OpenCode.as_str(), "opencode");
        assert_eq!(AppId::OpenClaw.as_str(), "openclaw");
    }
}
