export type NormalizedStreamingText = {
  delta: string;
  snapshot: string;
};

export function normalizeStreamingText(previousSnapshot: string, incoming: string): NormalizedStreamingText {
  if (!incoming) {
    return {
      delta: '',
      snapshot: previousSnapshot,
    };
  }

  if (!previousSnapshot) {
    return {
      delta: incoming,
      snapshot: incoming,
    };
  }

  if (incoming === previousSnapshot) {
    return {
      delta: '',
      snapshot: previousSnapshot,
    };
  }

  if (incoming.startsWith(previousSnapshot)) {
    return {
      delta: incoming.slice(previousSnapshot.length),
      snapshot: incoming,
    };
  }

  const previousIndex = incoming.lastIndexOf(previousSnapshot);
  if (previousIndex >= 0) {
    const deltaStart = previousIndex + previousSnapshot.length;
    return {
      delta: incoming.slice(deltaStart),
      snapshot: incoming,
    };
  }

  if (previousSnapshot.startsWith(incoming)) {
    return {
      delta: '',
      snapshot: previousSnapshot,
    };
  }

  return {
    delta: incoming,
    snapshot: `${previousSnapshot}${incoming}`,
  };
}
