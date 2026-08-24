/** Public ACP extension contract for Docker Sandbox sessions. */
export const SANDBOX_EXTENSION_METHODS = Object.freeze([
  'sandbox/status',
  'sandbox/preview',
  'sandbox/promote',
  'sandbox/reject',
] as const);

export type SandboxExtensionMethod = typeof SANDBOX_EXTENSION_METHODS[number];

export type SandboxExtensionHandler = (
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export type SandboxExtensionHandlers = Partial<Record<
  SandboxExtensionMethod,
  SandboxExtensionHandler
>>;

/**
 * Runtime boundary for the sandbox ACP extensions. Keeping dispatch in one
 * exhaustive handler makes the advertised method list match executable code.
 */
export class SandboxAcpExtensionHandler {
  constructor(private readonly handlers: SandboxExtensionHandlers) {}

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

export function isSandboxExtensionMethod(method: string): method is SandboxExtensionMethod {
  return (SANDBOX_EXTENSION_METHODS as readonly string[]).includes(method);
}
