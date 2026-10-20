/** Agents V2 pris en charge par les lots de tâches. */
export type TaskAgent = 'pi' | 'codex';

/** Niveau d'effort transmis à l'agent quand il le supporte. */
export type TaskEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Diagnostic observable d'une tentative ou d'un lot : code, message humain, chemin concerné. */
export interface TaskDiagnostic {
  code: string;
  message: string;
  path?: string;
}
