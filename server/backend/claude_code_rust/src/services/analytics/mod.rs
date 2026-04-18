//! 分析和遥测服务模块
//! 
//! 这个模块实现了分析、遥测和特性开关功能

pub mod growthbook;
pub mod metrics;

// 重新导出主要类型
pub use growthbook::{
    GrowthBookClient, GrowthBookUserAttributes, FeatureFlag,
    GrowthBookConfig, ExperimentData,
};

pub use metrics::{
    MetricType, MetricsCollector, MetricsConfig, MetricsSnapshot,
    PerformanceMonitor, PerformanceReport,
    init_performance_monitor, get_performance_monitor,
    record_session, record_loc, record_pr, record_commit,
    record_cost, record_tokens, record_code_edit_decision,
    record_active_time, get_performance_report,
};

use crate::error::Result;

/// 初始化分析服务
pub async fn init() -> Result<()> {
    tracing::debug!("Initializing analytics services");
    
    // 初始化 GrowthBook
    growthbook::init().await?;
    
    // 初始化性能监视器
    metrics::init_performance_monitor().await?;
    
    tracing::debug!("Analytics services initialized");
    Ok(())
}
