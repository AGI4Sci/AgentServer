/**
 * Agent Session 准备逻辑
 * 仅校验 Team Skill 可用性，不在 agent 目录创建 skills 软链
 */

import { mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

function resolveTeamSkillsDir(teamsDir: string, teamId: string): string {
  const teamDir = join(teamsDir, teamId);
  const toolsDir = join(teamDir, 'tools');
  if (existsSync(toolsDir)) {
    return toolsDir;
  }
  return join(teamDir, 'skills');
}

/**
 * 为 Agent 准备 Team Skill
 *
 * 说明：
 * - skills 统一存放在 agents/skills
 * - 不再在 agents/roles/{agentId}/skills 下创建目录或软链
 * 
 * @param agentId Agent ID
 * @param teamId Team ID
 * @param teamsDir Teams 目录路径（项目根目录/teams）
 */
export async function prepareAgentForTeam(
  _agentId: string,
  teamId: string,
  teamsDir: string
): Promise<{ ok: boolean; error?: string; path?: string }> {
  try {
    let teamSkillsDir = resolveTeamSkillsDir(teamsDir, teamId);

    // 检查 Team tools/skills 目录是否存在
    if (!existsSync(teamSkillsDir)) {
      console.warn(`[Session Prepare] Team tools/skills dir not found for team: ${teamId}`);
      teamSkillsDir = join(teamsDir, teamId, 'skills');
      await mkdir(teamSkillsDir, { recursive: true });
    }

    console.log(`[Session Prepare] Team skills ready: ${teamSkillsDir}`);
    
    return {
      ok: true,
      path: teamSkillsDir,
    };
  } catch (error) {
    console.error('[Session Prepare] Error:', error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * 切换 Agent 的 Team
 * 现在仅校验目标 Team skills 可用
 * 
 * @param agentId Agent ID
 * @param oldTeamId 旧 Team ID（可选）
 * @param newTeamId 新 Team ID
 * @param teamsDir Teams 目录路径
 */
export async function switchAgentTeam(
  _agentId: string,
  newTeamId: string,
  teamsDir: string,
  oldTeamId?: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    let teamSkillsDir = resolveTeamSkillsDir(teamsDir, newTeamId);

    // 确保 Team tools/skills 目录存在
    if (!existsSync(teamSkillsDir)) {
      teamSkillsDir = join(teamsDir, newTeamId, 'skills');
      await mkdir(teamSkillsDir, { recursive: true });
    }

    console.log(`[Session Prepare] Team switched: ${oldTeamId || 'none'} → ${newTeamId}, skills=${teamSkillsDir}`);
    
    return { ok: true };
  } catch (error) {
    console.error('[Session Prepare] Switch error:', error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}
