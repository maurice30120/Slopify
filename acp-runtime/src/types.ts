export interface RuntimeUi {
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message?: string): Promise<boolean>;
}

export interface RuntimePermissionContext {
  hasUI: boolean;
  ui: RuntimeUi;
}

export interface Logger {
  log(message: string): void;
  error(message: string, error?: unknown): void;
}

export const consoleLogger: Logger = {
  log(message) { console.log(`[acp-runtime] ${message}`); },
  error(message, error) {
    if (error === undefined) console.error(`[acp-runtime] ${message}`);
    else console.error(`[acp-runtime] ${message}`, error);
  },
};
