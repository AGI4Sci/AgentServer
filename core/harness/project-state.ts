export interface ParsedProjectTask {
  id: string;
  title: string;
  status: 'todo' | 'active' | 'blocked' | 'done';
  assignee?: string;
  priority?: string;
}

export interface ParsedProjectState {
  tasks: ParsedProjectTask[];
  counts: {
    todo: number;
    active: number;
    blocked: number;
    done: number;
  };
}

const LINE_PATTERNS = {
  active: /^###\s+#ACTIVE\s+(#\S+)\s+(.+?)\s*\|\s*优先级:\s*(\S+)\s*\|\s*(@\S+)/i,
  todo: /^###\s+#TODO\s+(#\S+)\s+(.+?)\s*\|\s*优先级:\s*(\S+)\s*\|\s*(@\S+)/i,
  done: /^###\s+#DONE\s+(#\S+)\s+(.+?)\s*\|\s*(@\S+)/i,
  blocked: /^###\s+#BLOCKED\s+(#\S+)\s+(.+?)\s*\|\s*(@\S+)/i,
};

export function parseProjectMarkdown(content: string): ParsedProjectState {
  const tasks: ParsedProjectTask[] = [];

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();

    const activeMatch = line.match(LINE_PATTERNS.active);
    if (activeMatch) {
      tasks.push({
        id: activeMatch[1],
        title: activeMatch[2].trim(),
        status: 'active',
        priority: activeMatch[3],
        assignee: activeMatch[4],
      });
      continue;
    }

    const todoMatch = line.match(LINE_PATTERNS.todo);
    if (todoMatch) {
      tasks.push({
        id: todoMatch[1],
        title: todoMatch[2].trim(),
        status: 'todo',
        priority: todoMatch[3],
        assignee: todoMatch[4],
      });
      continue;
    }

    const doneMatch = line.match(LINE_PATTERNS.done);
    if (doneMatch) {
      tasks.push({
        id: doneMatch[1],
        title: doneMatch[2].trim(),
        status: 'done',
        priority: '-',
        assignee: doneMatch[3],
      });
      continue;
    }

    const blockedMatch = line.match(LINE_PATTERNS.blocked);
    if (blockedMatch) {
      tasks.push({
        id: blockedMatch[1],
        title: blockedMatch[2].trim(),
        status: 'blocked',
        priority: '-',
        assignee: blockedMatch[3],
      });
    }
  }

  return {
    tasks,
    counts: {
      todo: tasks.filter(task => task.status === 'todo').length,
      active: tasks.filter(task => task.status === 'active').length,
      blocked: tasks.filter(task => task.status === 'blocked').length,
      done: tasks.filter(task => task.status === 'done').length,
    },
  };
}

export function hasStructuredTaskClosure(state: ParsedProjectState): boolean {
  return state.counts.done > 0 && state.counts.active === 0 && state.counts.blocked === 0;
}
