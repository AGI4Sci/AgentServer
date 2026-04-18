/**
 * 输入验证工具
 */

/**
 * 验证 Agent ID 格式
 * @returns null 表示验证通过，否则返回错误信息
 */
export function validateAgentId(id: string): string | null {
  if (!id || typeof id !== 'string') return 'Agent ID is required';
  if (id.length < 3) return 'Agent ID must be at least 3 characters';
  if (id.length > 64) return 'Agent ID too long (max 64 chars)';
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/i.test(id)) {
    return 'Agent ID must be alphanumeric with hyphens, not starting/ending with hyphen';
  }
  return null;
}

/**
 * 验证 Team ID 格式
 * @returns null 表示验证通过，否则返回错误信息
 */
export function validateTeamId(id: string): string | null {
  if (!id || typeof id !== 'string') return 'Team ID is required';
  if (id.length < 3) return 'Team ID must be at least 3 characters';
  if (id.length > 64) return 'Team ID too long (max 64 chars)';
  if (!/^[a-z0-9][a-z0-9-_]*[a-z0-9]$/i.test(id)) {
    return 'Team ID must be alphanumeric with hyphens/underscores';
  }
  return null;
}

/**
 * 路径安全检查：防止目录穿越攻击
 */
export function isPathSafe(path: string, basePath: string): boolean {
  // 规范化路径
  const normalizedPath = path.replace(/\.\./g, '');
  return normalizedPath.startsWith(basePath);
}
