/**
 * SOUL.md 生成器
 */

import type { SoulConfig } from '../../core/types/index.js';

interface AgentData {
  id: string;
  name: string;
  role: string;
  soul: SoulConfig;
  model: string;
}

/**
 * 生成 SOUL.md 文件内容
 */
export function generateSoulMd(agent: AgentData): string {
  const { soul } = agent;
  
  // 确保 temperature 是有效数字
  let temperature = 0.7;
  if (soul.temperature !== undefined && soul.temperature !== null) {
    const parsed = typeof soul.temperature === 'number' 
      ? soul.temperature 
      : parseFloat(String(soul.temperature));
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) {
      temperature = parsed;
    }
  }
  
  const language = soul.language ?? 'zh-CN';
  
  return `---
id: ${agent.id}
name: ${agent.name}
role: ${agent.role}
model: ${agent.model}
temperature: ${temperature}
language: ${language}
---

# Identity

${soul.identity || '待定义'}

# Personality

${soul.personality || '待定义'}

# Mission

${soul.mission || '待定义'}

# Communication Style

${soul.communication || '待定义'}

# Constraints

${soul.constraints || '待定义'}

# Traits

${(soul.traits || []).map(t => `- ${t}`).join('\n') || '- 待定义'}
`;
}
