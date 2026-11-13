import type { SubprocessResult, TaskExecutionRequest, TaskDiagnostic } from './index.js';

/**
 * Contrat d'adaptateur d'agent : l'environnement d'exécution fournit les commandes
 * (sandbox ou hôte) ; l'adaptateur possède les invocations, paramètres, événements,
 * verdicts et preuves de son agent. Aucun adaptateur n'importe un moteur d'exécution.
 */
export interface TaskAgentContext extends TaskExecutionRequest {
  sandboxName: string;
  containerWorkspacePath: string;
  containerContextPath: string;
  skillsStore: string;
  /**
   * Racine du bundle de workflows de la distribution (répertoire contenant inventory.json et skills/),
   * indépendante du répertoire courant. L'adaptateur résout les rôles et dépendances transitives via
   * resolveWorkflowResources ; son absence ou son invalidité doit produire une erreur explicite,
   * sans repli silencieux vers le store global des skills.
   */
  workflowResourcesRoot?: string;
  /** Commande sbx déjà routée par l'environnement d'exécution (pool, sandbox ou hôte). */
  command(args: string[]): Promise<SubprocessResult>;
}

export interface TaskAgentAdapter {
  agent: 'codex' | 'pi';
  /** Préparation propre à l'agent avant la création de la sandbox (kit, chemins). */
  prepare(context: TaskAgentContext): Promise<{ createTarget: string; createMounts?: string[] }>;
  /** Invocation de l'agent et traitement de ses événements, verdicts et preuves. */
  run(context: TaskAgentContext): Promise<{ exitCode: number; report: string; diagnostics: TaskDiagnostic[] }>;
}
