/**
 * OpenTeam Studio - Path Configuration
 * 路径配置中心
 * 
 * 所有数据都在项目目录下，方便开发调试
 */

import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

// 项目根目录
// 开发模式：import.meta.url 指向 server/utils/paths.ts
// 编译后：import.meta.url 指向 dist/server/utils/paths.js
// 需要根据路径深度判断
const currentDir = dirname(fileURLToPath(import.meta.url));
const isCompiled = currentDir.includes('/dist/');
const PROJECT_ROOT_FROM_SOURCE = resolve(currentDir, '../..');
const PROJECT_ROOT_FROM_DIST = resolve(currentDir, '../../..');

export const PROJECT_ROOT = isCompiled ? PROJECT_ROOT_FROM_DIST : PROJECT_ROOT_FROM_SOURCE;

// 项目内的 team 定义目录（manifest / team.config / members / skills）
export const TEAMS_DIR = join(PROJECT_ROOT, 'teams');

// 项目内 agent 配置目录
export const AGENTS_DIR = join(PROJECT_ROOT, 'agents', 'roles');
export const AGENT_SKILLS_DIR = join(PROJECT_ROOT, 'agents', 'skills');

// LLM 配置文件路径（放在项目根目录）
export const LLM_CONFIG_PATH = join(PROJECT_ROOT, '.llm-config.json');
