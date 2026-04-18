/**
 * SOUL.md 解析器
 * 统一的解析实现，消除 H1/H2 不一致问题
 */

import type { SoulConfig } from '../../core/types/index.js';

/**
 * 解析 SOUL.md 文件内容
 * 
 * 支持 H1 (#) 和 H2 (##) 两种格式的 section 标题
 * 例如：
 *   # Identity        (H1 格式)
 *   ## Identity       (H2 格式)
 * 
 * 都会被识别为 "identity" section
 */
export function parseSoulMd(content: string): SoulConfig {
  const result: SoulConfig = {
    identity: '',
    personality: '',
    mission: '',
    communication: '',
    constraints: '',
    traits: [],
    language: 'zh-CN',
    temperature: 0.7,
  };

  if (!content) return result;

  // 解析 frontmatter (YAML 格式)
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (frontmatterMatch) {
    const fm = frontmatterMatch[1];
    
    // 提取 role
    const roleMatch = fm.match(/^role:\s*(.+)$/m);
    if (roleMatch) {
      result.role = roleMatch[1].trim();
    }
    
    // 提取 model
    const modelMatch = fm.match(/^model:\s*(.+)$/m);
    if (modelMatch) {
      result.model = modelMatch[1].trim();
    }
    
    // 提取 temperature
    const tempMatch = fm.match(/temperature:\s*([\d.]+)/);
    if (tempMatch) {
      const parsed = parseFloat(tempMatch[1]);
      if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) {
        result.temperature = parsed;
      }
    }
    
    // 提取 language
    const langMatch = fm.match(/language:\s*(\S+)/);
    if (langMatch) {
      result.language = langMatch[1];
    }
  }

  // 解析各 section（同时支持 H1 和 H2 格式）
  const sections: Record<string, string> = {};
  let currentSection = '';
  let currentContent: string[] = [];

  for (const line of content.split('\n')) {
    // 同时匹配 H1 (# ) 和 H2 (## ) 格式
    const match = line.match(/^#{1,2}\s+(.+)$/);
    if (match) {
      // 保存上一个 section
      if (currentSection && currentContent.length > 0) {
        sections[currentSection] = currentContent.join('\n').trim();
      }
      // 开始新 section（转小写，去除空格）
      currentSection = match[1].toLowerCase().trim();
      currentContent = [];
    } else if (currentSection) {
      currentContent.push(line);
    }
  }

  // 保存最后一个 section
  if (currentSection && currentContent.length > 0) {
    sections[currentSection] = currentContent.join('\n').trim();
  }

  // 映射到 SoulConfig（支持中英文字段名）
  result.identity = sections['identity'] || sections['身份'] || '';
  result.personality = sections['personality'] || sections['个性'] || '';
  result.mission = sections['mission'] || sections['使命'] || '';
  result.communication = sections['communication style'] 
    || sections['communication'] 
    || sections['沟通方式'] 
    || sections['沟通'] 
    || '';
  result.constraints = sections['constraints'] || sections['约束'] || '';
  
  // 解析 traits（列表格式）
  const traitsText = sections['traits'] || sections['特征'] || '';
  result.traits = traitsText
    .split('\n')
    .map(l => l.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean);

  return result;
}
