export function buildRuntimeStartingMessage(label: string): string {
  return `Launching ${label} runtime`;
}

export function buildRuntimeRunningMessage(label: string): string {
  return `${label} is processing the request`;
}

export function buildRuntimeCompletedMessage(label: string): string {
  return `${label} run completed`;
}

export function buildRuntimeTimeoutMessage(label: string, timeoutMs: number): string {
  return `${label} runtime timed out after ${timeoutMs}ms.`;
}

export function buildRuntimeStallMessage(label: string, stallTimeoutMs: number, snippet?: string | null): string {
  const suffix = snippet?.trim()
    ? ` Last observed output: ${snippet.trim()}`
    : '';
  return `${label} runtime stalled after ${stallTimeoutMs}ms without new events.${suffix}`;
}
