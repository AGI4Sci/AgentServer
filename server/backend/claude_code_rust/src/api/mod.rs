//! API客户端模块
//! 
//! 高性能、可靠的API客户端，支持RESTful API设计规范

pub mod client;
pub mod error;
pub mod request;
pub mod response;
pub mod config;
pub mod retry;
pub mod compression;
pub mod cc_switch;

pub use client::ApiClient;
pub use error::ApiError;
pub use request::Request;
pub use response::Response;
pub use config::ApiClientConfig;
pub use retry::RetryStrategy;
pub use cc_switch::CcSwitchClient;