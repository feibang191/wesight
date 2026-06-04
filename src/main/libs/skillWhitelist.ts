/**
 * Skill whitelist — keeps Claude Code from invoking skills that don't exist
 * on disk.
 *
 * Why this exists: Claude Code's default system prompt describes capabilities
 * like "multi-agent execution" that don't correspond to any directory in
 * `SKILLs/`. Without a gate, the SDK happily emits a `Skill` tool call that
 * the host can't resolve, leaving the user staring at an empty follow-up
 * prompt.
 *
 * The source of truth is the directory listing of `SKILLs/`. Update this
 * set whenever a new skill is added or removed.
 */

const ALLOWED_SKILL_IDS: ReadonlySet<string> = new Set([
  'article-writer',
  'canvas-design',
  'content-planner',
  'create-plan',
  'daily-trending',
  'develop-web-game',
  'docx',
  'films-search',
  'frontend-design',
  'imap-smtp-email',
  'local-tools',
  'music-search',
  'pdf',
  'playwright',
  'pptx',
  'remotion',
  'seedance',
  'seedream',
  'skill-creator',
  'skill-vetter',
  'stock-analyzer',
  'stock-announcements',
  'stock-explorer',
  'technology-news-search',
  'weather',
  'web-search',
  'xlsx',
  'youdaonote',
]);

export function isAllowedSkill(skillId: string | null | undefined): boolean {
  if (!skillId) return false;
  return ALLOWED_SKILL_IDS.has(skillId);
}

export function listAllowedSkillIds(): string[] {
  return Array.from(ALLOWED_SKILL_IDS);
}
