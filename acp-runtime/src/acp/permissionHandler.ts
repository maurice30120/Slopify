import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';

import { PipelineTimeoutError, withTimeout } from './operationGuards.js';
import type { RuntimePermissionContext } from '../types.js';

const CANCELLED: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };

/** Composant PermissionHandler qui coordonne une étape observable du cycle de vie du pipeline et en préserve les invariants. */
export class PermissionHandler {
/** Initialise ce composant pour le cycle de vie du pipeline concerné. */
  constructor(
    private readonly getContext: () => RuntimePermissionContext | undefined,
    private readonly options: { autoApproveAll?: boolean; timeoutMs?: number } = {},
  ) {}

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
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
