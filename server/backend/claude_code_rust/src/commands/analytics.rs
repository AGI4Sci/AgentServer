//! 分析命令处理模块
//! 
//! 实现分析和统计相关的命令处理

use crate::error::Result;
use crate::services::analytics::{get_performance_report, record_session};
use crate::state::AppState;

/// 显示性能报告
pub async fn show_performance_report(state: AppState) -> Result<()> {
    // 记录会话
    record_session().await;
    
    // 获取性能报告
    if let Some(report) = get_performance_report().await {
        println!("Performance Report:");
        println!("{:-<60}", "");
        println!("Uptime: {} seconds", report.uptime_secs);
        println!("Session Count: {}", report.session_count);
        println!("Total Lines of Code: {}", report.total_loc);
        println!("Total PRs: {}", report.total_prs);
        println!("Total Commits: {}", report.total_commits);
        println!("Total Cost: ${:.2}", report.total_cost);
        println!("Total Tokens Input: {}", report.total_tokens_input);
        println!("Total Tokens Output: {}", report.total_tokens_output);
        println!("Active Time: {} minutes", report.active_time_minutes);
        
        if !report.edit_decisions.is_empty() {
            println!("Edit Decisions:");
            for (decision, count) in report.edit_decisions {
                println!("  - {}: {}", decision, count);
            }
        }
        println!("{:-<60}", "");
    } else {
        println!("Performance monitor not initialized");
    }
    
    Ok(())
}

/// 注册分析相关的命令
pub fn register_analytics_commands(manager: &mut crate::commands::registry::CommandManager) {
    // 这里应该注册分析相关的命令
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::new_app_state;

    #[tokio::test]
    async fn test_show_performance_report() {
        let state = new_app_state();
        let result = show_performance_report(state).await;
        assert!(result.is_ok());
    }
}
