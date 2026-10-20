/** Contrat fonctionnel de RuntimeUi dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface RuntimeUi {
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  select(title: string, options: string[]): Promise<string | undefined>;
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  confirm(title: string, message?: string): Promise<boolean>;
}

/** Contrat fonctionnel de RuntimePermissionContext dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface RuntimePermissionContext {
  hasUI: boolean;
  ui: RuntimeUi;
}

/** Contrat fonctionnel de Logger dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface Logger {
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  log(message: string): void;
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  error(message: string, error?: unknown): void;
}
