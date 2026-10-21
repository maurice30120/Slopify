import type { TaskExecutionRequest } from './taskExecution.js';

/** Invoke the installed skill through the agent's native mechanism, retaining
 * the original ticket as-is and avoiding a second valid native reference. */
export function nativeSkillPrompt(request: Pick<TaskExecutionRequest, 'agent' | 'prompt' | 'skill'>): string {
  const skill = request.skill ?? 'implement';
  if (request.agent === 'pi') {
    const command = `/skill:${skill}`;
    // Pi expands a leading command terminated by a literal space (or EOF).
    if (/^\/skill:(?:implement|code-review)(?: |$)/.test(request.prompt)) return request.prompt;
    return `${command} ${request.prompt}`;
  }
  if (/\$code-review(?![\w-])/.test(request.prompt)) return request.prompt;
  if (new RegExp(`\\$${skill}(?![\\w-])`).test(request.prompt)) return request.prompt;
  return `$${skill}\n\n${request.prompt}`;
}
