//! 分析和统计模块
//! 
//! 实现高效的数据采集、多线程处理、持久化存储和可视化展示

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::{RwLock, mpsc};
use tokio::time::{interval, Duration};
use crate::error::Result;

/// 统计指标类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum MetricType {
    /// 会话计数器
    SessionCounter,
    /// 代码行数计数器
    LocCounter,
    /// PR 计数器
    PrCounter,
    /// 提交计数器
    CommitCounter,
    /// 成本计数器
    CostCounter,
    /// Token 计数器
    TokenCounter,
    /// 代码编辑工具决策计数器
    CodeEditToolDecisionCounter,
    /// 活跃时间计数器
    ActiveTimeCounter,
}

impl MetricType {
    /// 获取指标类型的描述
    pub fn description(&self) -> &'static str {
        match self {
            MetricType::SessionCounter => "Session Counter",
            MetricType::LocCounter => "Lines of Code Counter",
            MetricType::PrCounter => "Pull Request Counter",
            MetricType::CommitCounter => "Commit Counter",
            MetricType::CostCounter => "Cost Counter",
            MetricType::TokenCounter => "Token Counter",
            MetricType::CodeEditToolDecisionCounter => "Code Edit Tool Decision Counter",
            MetricType::ActiveTimeCounter => "Active Time Counter",
        }
    }
}

/// 计数器条目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CounterEntry {
    /// 计数器值
    pub value: u64,
    /// 时间戳
    pub timestamp: i64,
    /// 属性
    pub attributes: HashMap<String, String>,
}

impl CounterEntry {
    /// 创建新的计数器条目
    pub fn new(metric_type: MetricType) -> Self {
        Self {
            value: 0,
            timestamp: chrono::Utc::now().timestamp(),
            attributes: HashMap::new(),
        }
    }
}

/// 带属性的计数器
#[derive(Debug, Clone)]
pub struct AttributedCounter {
    /// 指标类型
    metric_type: MetricType,
    /// 当前值
    value: u64,
    /// 历史记录
    history: Vec<CounterEntry>,
    /// 属性
    attributes: HashMap<String, String>,
}

impl AttributedCounter {
    /// 创建新的带属性的计数器
    pub fn new(metric_type: MetricType) -> Self {
        Self {
            metric_type,
            value: 0,
            history: Vec::new(),
            attributes: HashMap::new(),
        }
    }
    
    /// 获取当前值
    pub fn value(&self) -> u64 {
        self.value
    }
    
    /// 增加计数
    pub fn increment(&mut self, delta: u64) {
        self.value += delta;
        self.history.push(CounterEntry {
            value: self.value,
            timestamp: chrono::Utc::now().timestamp(),
            attributes: self.attributes.clone(),
        });
    }
    
    /// 增加计数并添加属性
    pub fn increment_with_attributes(&mut self, delta: u64, mut attributes: HashMap<String, String>) {
        self.value += delta;
        self.attributes.extend(attributes);
        self.history.push(CounterEntry {
            value: self.value,
            timestamp: chrono::Utc::now().timestamp(),
            attributes: self.attributes.clone(),
        });
    }
    
    /// 获取指标类型
    pub fn metric_type(&self) -> &MetricType {
        &self.metric_type
    }
    
    /// 获取属性
    pub fn attributes(&self) -> &HashMap<String, String> {
        &self.attributes
    }
    
    /// 获取历史记录
    pub fn history(&self) -> &[CounterEntry] {
        &self.history
    }
}

/// 统计快照
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetricsSnapshot {
    /// 时间戳
    pub timestamp: i64,
    /// 指标值
    pub values: HashMap<String, u64>,
}

impl MetricsSnapshot {
    /// 创建新的统计快照
    pub fn new() -> Self {
        Self {
            timestamp: chrono::Utc::now().timestamp(),
            values: HashMap::new(),
        }
    }
    
    /// 获取指标值
    pub fn get(&self, name: &str) -> Option<u64> {
        self.values.get(name).copied()
    }
    
    /// 设置指标值
    pub fn set(&mut self, name: String, value: u64) {
        self.values.insert(name, value);
    }
}

/// 统计配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetricsConfig {
    /// 采样间隔（秒）
    pub sample_interval_secs: u64,
    /// 聚合间隔（秒）
    pub aggregation_interval_secs: u64,
    /// 保留天数
    pub retention_days: i64,
}

impl Default for MetricsConfig {
    fn default() -> Self {
        Self {
            sample_interval_secs: 60,
            aggregation_interval_secs: 3600,
            retention_days: 30,
        }
    }
}

/// 统计数据采集器
#[derive(Clone)]
pub struct MetricsCollector {
    /// 计数器
    counters: Arc<RwLock<HashMap<String, AttributedCounter>>>,
    /// 快照
    snapshots: Arc<RwLock<Vec<MetricsSnapshot>>>,
    /// 上次采样时间
    last_sample: Arc<RwLock<Option<std::time::Instant>>>,
    /// 配置
    config: MetricsConfig,
    /// 消息通道
    tx: mpsc::Sender<MetricsEvent>,
    /// 消息接收通道
    rx: Arc<RwLock<Option<mpsc::Receiver<MetricsEvent>>>>,
}

/// 统计事件
#[derive(Debug, Clone)]
enum MetricsEvent {
    /// 增加计数
    Increment { metric: MetricType, delta: u64, attributes: Option<HashMap<String, String>> },
    /// 采集快照
    Snapshot,
    /// 重置计数器
    Reset,
}

impl MetricsCollector {
    /// 创建新的统计数据采集器
    pub fn new() -> Self {
        let (tx, rx) = mpsc::channel(100);
        Self {
            counters: Arc::new(RwLock::new(HashMap::new())),
            snapshots: Arc::new(RwLock::new(Vec::new())),
            last_sample: Arc::new(RwLock::new(None)),
            config: MetricsConfig::default(),
            tx,
            rx: Arc::new(RwLock::new(Some(rx))),
        }
    }
    
    /// 使用配置创建新的统计数据采集器
    pub fn with_config(config: MetricsConfig) -> Self {
        let (tx, rx) = mpsc::channel(100);
        Self {
            counters: Arc::new(RwLock::new(HashMap::new())),
            snapshots: Arc::new(RwLock::new(Vec::new())),
            last_sample: Arc::new(RwLock::new(None)),
            config,
            tx,
            rx: Arc::new(RwLock::new(Some(rx))),
        }
    }
    
    /// 启动采集器
    pub async fn start(&self) {
        let rx = self.rx.write().await.take();
        if let Some(mut rx) = rx {
            let counters = self.counters.clone();
            let snapshots = self.snapshots.clone();
            let config = self.config.clone();
            
            tokio::spawn(async move {
                let mut interval = interval(Duration::from_secs(config.sample_interval_secs));
                loop {
                    tokio::select! {
                        event = rx.recv() => {
                            if let Some(event) = event {
                                Self::handle_event(event, &counters).await;
                            } else {
                                break;
                            }
                        }
                        _ = interval.tick() => {
                            Self::take_snapshot(&counters, &snapshots).await;
                        }
                    }
                }
            });
        }
    }
    
    /// 处理事件
    async fn handle_event(event: MetricsEvent, counters: &Arc<RwLock<HashMap<String, AttributedCounter>>>) {
        match event {
            MetricsEvent::Increment { metric, delta, attributes } => {
                let key = format!("{:?}", metric);
                let mut counters = counters.write().await;
                let counter = counters.entry(key).or_insert_with(|| AttributedCounter::new(metric));
                if let Some(attrs) = attributes {
                    counter.increment_with_attributes(delta, attrs);
                } else {
                    counter.increment(delta);
                }
            }
            MetricsEvent::Snapshot => {
                // 快照由定时器处理
            }
            MetricsEvent::Reset => {
                counters.write().await.clear();
            }
        }
    }
    
    /// 采集快照
    async fn take_snapshot(counters: &Arc<RwLock<HashMap<String, AttributedCounter>>>, snapshots: &Arc<RwLock<Vec<MetricsSnapshot>>>) {
        let counters = counters.read().await;
        let mut snapshot = MetricsSnapshot::new();
        
        for (name, counter) in &*counters {
            snapshot.set(name.clone(), counter.value());
        }
        
        let mut snapshots = snapshots.write().await;
        snapshots.push(snapshot);
    }
    
    /// 增加计数
    pub async fn increment(&self, metric: MetricType, delta: u64) {
        self.tx.send(MetricsEvent::Increment { 
            metric, 
            delta, 
            attributes: None 
        }).await.unwrap();
    }
    
    /// 增加计数并添加属性
    pub async fn increment_with_attributes(&self, metric: MetricType, delta: u64, attributes: HashMap<String, String>) {
        self.tx.send(MetricsEvent::Increment { 
            metric, 
            delta, 
            attributes: Some(attributes) 
        }).await.unwrap();
    }
    
    /// 获取计数器值
    pub async fn get_counter_value(&self, metric: MetricType) -> u64 {
        let key = format!("{:?}", metric);
        let counters = self.counters.read().await;
        counters.get(&key).map(|c| c.value()).unwrap_or(0)
    }
    
    /// 获取所有计数器
    pub async fn get_all_counters(&self) -> HashMap<String, u64> {
        let counters = self.counters.read().await;
        counters.iter().map(|(k, v)| (k.clone(), v.value())).collect()
    }
    
    /// 获取快照
    pub async fn get_snapshots(&self) -> Vec<MetricsSnapshot> {
        self.snapshots.read().await.clone()
    }
    
    /// 重置计数器
    pub async fn reset(&self) {
        self.tx.send(MetricsEvent::Reset).await.unwrap();
    }
}

/// 性能监视器
#[derive(Clone)]
pub struct PerformanceMonitor {
    /// 统计数据采集器
    metrics: MetricsCollector,
    /// 启动时间
    start_time: std::time::Instant,
}

impl PerformanceMonitor {
    /// 创建新的性能监视器
    pub fn new() -> Self {
        Self {
            metrics: MetricsCollector::new(),
            start_time: std::time::Instant::now(),
        }
    }
    
    /// 启动性能监视器
    pub async fn start(&self) {
        self.metrics.start().await;
    }
    
    /// 记录会话
    pub async fn record_session(&self) {
        self.metrics.increment(MetricType::SessionCounter, 1).await;
    }
    
    /// 记录代码行数
    pub async fn record_loc(&self, lines: u64) {
        self.metrics.increment(MetricType::LocCounter, lines).await;
    }
    
    /// 记录 PR
    pub async fn record_pr(&self) {
        self.metrics.increment(MetricType::PrCounter, 1).await;
    }
    
    /// 记录提交
    pub async fn record_commit(&self) {
        self.metrics.increment(MetricType::CommitCounter, 1).await;
    }
    
    /// 记录成本
    pub async fn record_cost(&self, cost: f64) {
        // 转换为整数单位（例如，美分）
        let cost_cents = (cost * 100.0) as u64;
        self.metrics.increment(MetricType::CostCounter, cost_cents).await;
    }
    
    /// 记录 Token
    pub async fn record_tokens(&self, input: u64, output: u64) {
        self.metrics.increment(MetricType::TokenCounter, input + output).await;
    }
    
    /// 记录代码编辑工具决策
    pub async fn record_code_edit_decision(&self, decision: &str) {
        let mut attributes = HashMap::new();
        attributes.insert("decision".to_string(), decision.to_string());
        self.metrics.increment_with_attributes(MetricType::CodeEditToolDecisionCounter, 1, attributes).await;
    }
    
    /// 记录活跃时间
    pub async fn record_active_time(&self, seconds: u64) {
        self.metrics.increment(MetricType::ActiveTimeCounter, seconds).await;
    }
    
    /// 获取性能报告
    pub async fn get_performance_report(&self) -> PerformanceReport {
        let uptime = self.start_time.elapsed().as_secs();
        let counters = self.metrics.get_all_counters().await;
        
        PerformanceReport {
            uptime_secs: uptime,
            session_count: counters.get("SessionCounter").copied().unwrap_or(0),
            total_loc: counters.get("LocCounter").copied().unwrap_or(0),
            total_prs: counters.get("PrCounter").copied().unwrap_or(0),
            total_commits: counters.get("CommitCounter").copied().unwrap_or(0),
            total_cost: counters.get("CostCounter").copied().unwrap_or(0) as f64 / 100.0,
            total_tokens_input: 0, // 需要单独记录
            total_tokens_output: 0, // 需要单独记录
            edit_decisions: HashMap::new(), // 需要从属性中提取
            active_time_minutes: counters.get("ActiveTimeCounter").copied().unwrap_or(0) / 60,
        }
    }
}

/// 性能报告
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PerformanceReport {
    /// 运行时间（秒）
    pub uptime_secs: u64,
    /// 会话数量
    pub session_count: u64,
    /// 代码总行数
    pub total_loc: u64,
    /// PR 总数
    pub total_prs: u64,
    /// 提交总数
    pub total_commits: u64,
    /// 总成本
    pub total_cost: f64,
    /// 输入 Token 总数
    pub total_tokens_input: u64,
    /// 输出 Token 总数
    pub total_tokens_output: u64,
    /// 编辑决策
    pub edit_decisions: HashMap<String, u64>,
    /// 活跃时间（分钟）
    pub active_time_minutes: u64,
}

/// 全局性能监视器
static PERFORMANCE_MONITOR: once_cell::sync::Lazy<Arc<RwLock<Option<PerformanceMonitor>>>> = 
    once_cell::sync::Lazy::new(|| Arc::new(RwLock::new(None)));

/// 初始化性能监视器
pub async fn init_performance_monitor() -> Result<()> {
    let monitor = PerformanceMonitor::new();
    monitor.start().await;
    *PERFORMANCE_MONITOR.write().await = Some(monitor);
    Ok(())
}

/// 获取性能监视器
pub async fn get_performance_monitor() -> Option<Arc<PerformanceMonitor>> {
    if let Some(monitor) = &*PERFORMANCE_MONITOR.read().await {
        Some(Arc::new(monitor.clone()))
    } else {
        None
    }
}

/// 记录会话
pub async fn record_session() {
    if let Some(monitor) = get_performance_monitor().await {
        monitor.record_session().await;
    }
}

/// 记录代码行数
pub async fn record_loc(lines: u64) {
    if let Some(monitor) = get_performance_monitor().await {
        monitor.record_loc(lines).await;
    }
}

/// 记录 PR
pub async fn record_pr() {
    if let Some(monitor) = get_performance_monitor().await {
        monitor.record_pr().await;
    }
}

/// 记录提交
pub async fn record_commit() {
    if let Some(monitor) = get_performance_monitor().await {
        monitor.record_commit().await;
    }
}

/// 记录成本
pub async fn record_cost(cost: f64) {
    if let Some(monitor) = get_performance_monitor().await {
        monitor.record_cost(cost).await;
    }
}

/// 记录 Token
pub async fn record_tokens(input: u64, output: u64) {
    if let Some(monitor) = get_performance_monitor().await {
        monitor.record_tokens(input, output).await;
    }
}

/// 记录代码编辑工具决策
pub async fn record_code_edit_decision(decision: &str) {
    if let Some(monitor) = get_performance_monitor().await {
        monitor.record_code_edit_decision(decision).await;
    }
}

/// 记录活跃时间
pub async fn record_active_time(seconds: u64) {
    if let Some(monitor) = get_performance_monitor().await {
        monitor.record_active_time(seconds).await;
    }
}

/// 获取性能报告
pub async fn get_performance_report() -> Option<PerformanceReport> {
    if let Some(monitor) = get_performance_monitor().await {
        Some(monitor.get_performance_report().await)
    } else {
        None
    }
}
