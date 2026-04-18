export type ValidationRole = string;

const requestedValidationRolesByRequest = new Map<string, Set<ValidationRole>>();

function requestKey(teamId: string, requestId: string): string {
  return `${teamId}:${requestId}`;
}

export function extractRequestedValidationRoles(
  body: string,
  patterns: Array<{ roleId: ValidationRole; pattern: RegExp }>,
): Set<ValidationRole> {
  const roles = new Set<ValidationRole>();
  for (const { roleId, pattern } of patterns) {
    if (pattern.test(body)) {
      roles.add(roleId);
    }
  }
  return roles;
}

export function setRequestedValidationRoles(teamId: string, requestId: string, roles: Set<ValidationRole>): void {
  requestedValidationRolesByRequest.set(requestKey(teamId, requestId), roles);
}

export function getRequestedValidationRoles(teamId: string, requestId?: string): Set<ValidationRole> {
  if (!requestId) {
    return new Set();
  }
  return requestedValidationRolesByRequest.get(requestKey(teamId, requestId)) || new Set();
}

export function clearRunTrackingState(teamId: string, requestId: string): void {
  requestedValidationRolesByRequest.delete(requestKey(teamId, requestId));
}

export function clearTeamRunTrackingState(teamId: string): void {
  for (const key of Array.from(requestedValidationRolesByRequest.keys())) {
    if (key.startsWith(`${teamId}:`)) {
      requestedValidationRolesByRequest.delete(key);
    }
  }
}
