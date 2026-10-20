/** Contrat public des extensions ACP exposées par les sessions Docker Sandbox. */
export const SANDBOX_EXTENSION_METHODS = Object.freeze([
  'sandbox/status',
  'sandbox/preview',
  'sandbox/promote',
  'sandbox/reject',
] as const);

/** Type métier SandboxExtensionMethod utilisé pour représenter une étape ou un résultat du cycle de vie du pipeline. */
export type SandboxExtensionMethod = typeof SANDBOX_EXTENSION_METHODS[number];

/** Type métier SandboxExtensionHandler utilisé pour représenter une étape ou un résultat du cycle de vie du pipeline. */
export type SandboxExtensionHandler = (
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/** Type métier SandboxExtensionHandlers utilisé pour représenter une étape ou un résultat du cycle de vie du pipeline. */
export type SandboxExtensionHandlers = Partial<Record<
  SandboxExtensionMethod,
  SandboxExtensionHandler
>>;

/**
 * Frontière d'exécution des extensions ACP de la sandbox. Centraliser le dispatch
 * dans un handler exhaustif garantit que la liste annoncée correspond au code exécutable.
 */
export class SandboxAcpExtensionHandler {
/** Initialise ce composant pour le cycle de vie du pipeline concerné. */
  constructor(private readonly handlers: SandboxExtensionHandlers) {}

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!isSandboxExtensionMethod(method)) {
      throw new Error(`Unsupported sandbox ACP extension: ${method}`);
    }
    const handler = this.handlers[method];
    if (!handler) {
      throw new Error(`Sandbox ACP extension "${method}" is not active.`);
    }
    return handler(params);
  }
}

/** Point d'entrée isSandboxExtensionMethod du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
export function isSandboxExtensionMethod(method: string): method is SandboxExtensionMethod {
  return (SANDBOX_EXTENSION_METHODS as readonly string[]).includes(method);
}
