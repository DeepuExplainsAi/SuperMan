export const WEBSITE_PROMPT = /^\s*(please\s+)?(build|create|make|design|code)\s+(me\s+)?(a|an|my|the)?\s*(new\s+)?(website|web\s*site|site|landing\s*page|web\s*app|webpage|web\s*page|portfolio|homepage)\b/i;

export function isWebsitePrompt(prompt: string): boolean {
  return WEBSITE_PROMPT.test(prompt);
}
