/**
 * Query intent router — small keyword-based heuristic that picks the best
 * Cowork engine for a given user prompt.
 *
 * Why this exists: `coworkEngineRouter` already routes per-session, but the
 * default session engine is whatever the user picked last. When that default
 * is Claude Code and the user types "查个今天的热点新闻" (a web-fetch task),
 * the Claude SDK's system prompt drives the model into a docx / multi-agent
 * bootstrap loop instead of letting the user's intent pick a better engine.
 *
 * This module is intentionally a lightweight regex matcher. Heavy LLM-based
 * routing would add latency and obscure debuggability.
 */

import { CoworkAgentEngine } from '../../../shared/cowork/constants';

export type QueryIntent =
  | 'web_search'
  | 'docx'
  | 'file_read'
  | 'code_task'
  | 'casual';

const INTENT_KEYWORDS: Record<QueryIntent, RegExp[]> = {
  // 抓取 / 搜索类查询：用户用 Hermes（HTTP gateway，跑得快，工具链齐）
  web_search: [
    /(查|搜索|搜一下|找一下|找下|搜下).*?(新闻|热点|排名|榜单|动态|资料|信息|数据)/i,
    /^(今天|今日|现在).*?(热点|新闻|头条|热搜|动态)/,
    /web.?fetch|web.?search|tophub|抖音|微博|知乎|百度|头条|热搜/i,
    /(tavily|bing|google).*?search/i,
  ],
  // Office 文档：走 Claude Code（YdCowork 走 SDK，最稳）
  docx: [
    /\.docx?$/i,
    /(生成|写|做|创建|编辑).*?(文档|word|报告|pdf|excel|pptx|ppt|excel)/i,
    /\b(docx|word|pdf|excel|pptx)\b/i,
  ],
  // 读文件 / 看代码 / 看文档：走 Claude Code
  file_read: [
    /^(读|打开|查看|看).*?(文件|代码|文档)/,
    /AGENTS\.md|SOUL\.md|USER\.md|IDENTITY\.md|BOOTSTRAP\.md/,
  ],
  // 改 / 修 / 写代码：走 Claude Code（SDK 工具链最齐）
  code_task: [
    /(修|改|写|实现|调|debug|fix|refactor).*?(代码|bug|函数|类|文件|模块|接口|代码|错误)/i,
    /^(修|改|写|实现|调)\s/,
  ],
  // 闲聊 / 打招呼：保持当前引擎
  casual: [
    /^(你好|hi|hello|嗨|hey|在吗|你是谁)\b/i,
  ],
};

const INTENT_TO_ENGINE: Record<QueryIntent, CoworkAgentEngine | 'keep'> = {
  web_search: CoworkAgentEngine.Hermes,
  docx: CoworkAgentEngine.YdCowork,
  file_read: CoworkAgentEngine.YdCowork,
  code_task: CoworkAgentEngine.ClaudeCode,
  casual: 'keep',
};

/**
 * Detect the most likely intent behind a user prompt and return the
 * recommended engine. Returns 'keep' when the current engine should be kept
 * (e.g. for casual greetings where switching engines is wasteful).
 */
export function inferEngineFromQuery(
  query: string,
  currentEngine: CoworkAgentEngine,
): { engine: CoworkAgentEngine; intent: QueryIntent; confidence: number } {
  const text = (query || '').trim();
  if (!text) {
    return { engine: currentEngine, intent: 'casual', confidence: 0 };
  }
  for (const intent of Object.keys(INTENT_KEYWORDS) as QueryIntent[]) {
    const patterns = INTENT_KEYWORDS[intent];
    for (const re of patterns) {
      if (re.test(text)) {
        const target = INTENT_TO_ENGINE[intent];
        if (target === 'keep') {
          return { engine: currentEngine, intent, confidence: 0.7 };
        }
        if (target === currentEngine) {
          return { engine: currentEngine, intent, confidence: 0.7 };
        }
        return { engine: target, intent, confidence: 0.7 };
      }
    }
  }
  return { engine: currentEngine, intent: 'casual', confidence: 0 };
}
