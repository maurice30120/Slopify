import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';

import { PipelineTimeoutError, withTimeout } from './operationGuards.js';
import type { RuntimePermissionContext } from '../types.js';

const CANCELLED: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };

export class PermissionHandler {
  constructor(
    private readonly getContext: () => RuntimePermissionContext | undefined,
    private readonly options: { autoApproveAll?: boolean; timeoutMs?: number } = {},
  ) {}

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (this.options.autoApproveAll) {
      const option = params.options.find(candidate => candidate.kind === 'allow_once') ?? params.options[0];
      if (option) {
        return {
          outcome: {
            outcome: 'selected',
            optionId: option.optionId,
          },
        };
      }
    }

    const ctx = this.getContext();
    if (!ctx?.hasUI) {
      return CANCELLED;
    }

    const labels = params.options.map(option => `${option.name} [${option.kind}]`);
    let selected: string | undefined;
    try {
      selected = await withTimeout(
        'permission',
        this.options.timeoutMs ?? 300_000,
        ctx.ui.select(
          params.toolCall?.title ?? 'ACP permission request',
          labels,
        ),
      );
    } catch (error: unknown) {
      if (error instanceof PipelineTimeoutError) {
        return CANCELLED;
      }
      throw error;
    }
    if (!selected) {
      return CANCELLED;
    }

    const index = labels.indexOf(selected);
    const option = index >= 0 ? params.options[index] : undefined;
    if (!option) {
      return CANCELLED;
    }

    return {
      outcome: {
        outcome: 'selected',
        optionId: option.optionId,
      },
    };
  }
}
