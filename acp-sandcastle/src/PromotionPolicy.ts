import type { SandcastlePromotion } from './AgentConfig.js';

export interface SandcastlePreview {
  diff: string;
  filesChanged: number;
  branch: string;
  baseRef: string;
  worktreePath: string;
}

export type SandcastlePromotionMode = SandcastlePromotion;
export type SandcastlePromotionOutcome = 'applied' | 'no_changes' | 'rejected' | 'cancelled';

export type PromotionPolicyDecision =
  | 'discard_no_changes'
  | 'auto_apply'
  | 'auto_reject'
  | 'prompt';

export function decidePromotionPolicy(
  preview: SandcastlePreview,
  mode: SandcastlePromotionMode,
): PromotionPolicyDecision {
  if (preview.filesChanged === 0) {
    return 'discard_no_changes';
  }
  if (mode === 'autoApply') {
    return 'auto_apply';
  }
  if (mode === 'autoReject') {
    return 'auto_reject';
  }
  return 'prompt';
}
