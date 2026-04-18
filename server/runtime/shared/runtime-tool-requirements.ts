import type { WorkerRunRequest } from '../team-worker-types.js';

const ENGLISH_RUNTIME_TOOL_PATTERNS = [
  /\buse real tools?\b/,
  /\buse (?:(?:the|available)\s+){0,2}tools?\b/,
  /\buse the available tools?\b/,
  /\buse available tools?\b/,
  /\b(?:list_dir|grep_search|read_file|run_command|browser_open|browser_activate|apply_patch|web_fetch)\b/,
  /\blist (?:the )?(?:files|folders|directories|contents?)\b/,
  /\breport (?:the )?(?:names|count) of direct children\b/,
  /\bshow (?:me )?(?:the )?(?:files|folders|directories|contents?)\b/,
  /\bread (?:the )?file\b/,
  /\bopen (?:the )?file\b/,
  /\bsearch (?:the )?(?:repo|repository|codebase|workspace)\b/,
  /\binspect (?:the )?(?:repo|repository|codebase|workspace|working directory)\b/,
  /\bcheck (?:the )?(?:repo|repository|codebase|workspace|working directory)\b/,
  /\brun (?:the exact )?(?:shell |terminal )?commands?\b/,
  /\bexecute (?:the exact )?commands?\b/,
  /\bexecute\s+`(?:list_dir|grep_search|read_file|run_command|browser_open|browser_activate|apply_patch|web_fetch)\b/,
  /\bcreate (?:the )?file\b/,
  /\bwrite (?:to )?(?:the )?file\b/,
  /\bread (?:back )?(?:the )?file\b/,
  /\bedit (?:the )?file\b/,
  /\bapply patch\b/,
  /\bbrowser\b/,
  /\bopen (?:the )?(?:page|url|website)\b/,
  /\bvisit (?:the )?(?:page|url|website)\b/,
  /\bclick\b/,
  /\bcurrent working directory\b/,
  /\bdo not guess\b/,
  /\bhost-visible workspace path\b/,
];

const CHINESE_RUNTIME_TOOL_PATTERNS = [
  /使用(?:可用|真实)?工具/,
  /请(?:先)?用工具/,
  /不要猜测/,
  /不要臆测/,
  /先查看/,
  /先检查/,
  /先读取/,
  /列出当前工作目录/,
  /查看当前工作目录/,
  /读取当前工作目录/,
  /检查当前工作目录/,
  /列出(?:当前)?目录/,
  /查看(?:当前)?目录/,
  /读取(?:当前)?目录/,
  /检查(?:当前)?目录/,
  /列出(?:所有)?文件/,
  /列出(?:所有)?子项/,
  /查看(?:所有)?文件/,
  /读取(?:这个|该)?文件/,
  /打开(?:这个|该)?文件/,
  /搜索(?:代码库|仓库|目录|工作区)/,
  /检查(?:代码库|仓库|目录|工作区)/,
  /浏览(?:页面|网址|网站)/,
  /打开(?:页面|网址|网站)/,
  /点击/,
  /运行(?:命令|终端命令|shell 命令|shell命令)/,
  /执行(?:命令|终端命令|shell 命令|shell命令)/,
  /创建文件/,
  /写入文件/,
  /编辑文件/,
  /打补丁/,
];

const RUNTIME_TOOL_PATTERNS = [
  ...ENGLISH_RUNTIME_TOOL_PATTERNS,
  ...CHINESE_RUNTIME_TOOL_PATTERNS,
];

export function textDemandsRuntimeToolExecution(text: string): boolean {
  return RUNTIME_TOOL_PATTERNS.some((pattern) => pattern.test(String(text || '').toLowerCase()));
}

export function requestDemandsRuntimeToolExecution(request: WorkerRunRequest): boolean {
  return textDemandsRuntimeToolExecution(`${request.input.task}\n${request.input.context}`);
}
