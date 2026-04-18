import type { HarnessRunRecord } from './types.js';
import { hasStructuredTaskClosure, parseProjectMarkdown } from './project-state.js';

const COORDINATOR_COMPLETION_PATTERNS = [
  /(?:任务|工作|实现|修复|调研|整理|草稿).{0,8}(?:已完成|完成了|完成)/i,
  /(?:最终|最后|总结|汇总).{0,8}(?:如下|如下所示|如下：|如下:)/i,
  /(?:可以|可)开始(?:验收|评审|确认)/i,
  /(?:已提交|已产出|已给出).{0,10}(?:结果|结论|方案|修改)/i,
  /(?:请确认|请验收|请查看最终结果)/i,
];

const USER_ACCEPTANCE_PATTERNS = [
  /^(?:好|好的|可以|行|ok|okay|收到)[，,。\s]*$/i,
  /(?:采纳|接受|确认采用|确认这个方案|就按这个|按这个来)/i,
  /(?:没问题|可以合并|可以提交|通过了|通过吧)/i,
  /(?:确认完成|验收通过|可以结束了)/i,
];

export function hasExplicitCoordinatorCompletion(body: string): boolean {
  const normalized = body.trim();
  return COORDINATOR_COMPLETION_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isUserAcceptanceMessage(body: string): boolean {
  const normalized = body.trim();
  if (normalized.length > 120) {
    return false;
  }
  return USER_ACCEPTANCE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function hasTaskClosureSignal(projectContent: string): boolean {
  return hasStructuredTaskClosure(parseProjectMarkdown(projectContent));
}

export function shouldAttachUserAcceptance(run: HarnessRunRecord | null, now = Date.now()): boolean {
  if (!run) return false;
  const finishedAt = run.finishedAt ? Date.parse(run.finishedAt) : Date.parse(run.startedAt);
  return now - finishedAt <= 10 * 60 * 1000;
}
