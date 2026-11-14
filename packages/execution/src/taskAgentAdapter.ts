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
  /** Session RPC interactive (stdio via `sbx exec -i`) : stdin piloté par l'adaptateur, flux journalisés vers les preuves de la tentative. Absente des environnements sans transport RPC interactif ; l'adaptateur doit l'exiger explicitement, sans repli silencieux. */
  spawnRpc?: (request: AgentRpcSpawnRequest) => AgentRpcProcess;
}

/** Demande de session RPC interactive : arguments sbx et réception des flux bruts du processus. */
export interface AgentRpcSpawnRequest {
  args: string[];
  /** Chaque ligne stdout du processus RPC, dans l'ordre d'émission. */
  onRecord: (line: string) => void;
  /** Fragments stderr bruts, pour les diagnostics de crash. */
  onStderr: (chunk: string) => void;
  /** Mort observée du processus, exactement une fois : crash, arrêt ordonné ou sortie spontanée. */
  onExit: (exit: { exitCode: number; stderrTail: string }) => void;
  signal?: AbortSignal;
}

/** Processus RPC interactif possédé par un adaptateur d'agent.
 * L'environnement d'exécution journalise les flux vers les preuves durables ; l'adaptateur pilote le protocole au travers de writeLine et ferme par arrêt ordonné. */
export interface AgentRpcProcess {
  /** Écrit une ligne JSONL (commande RPC) sur le stdin du processus. */
  writeLine(line: string): void;
  /** Arrêt ordonné : ferme le stdin, attend la fin réelle du processus et de ses descendants, escalade si nécessaire ; résout au code de sortie observé. */
  close(): Promise<{ exitCode: number; stderrTail: string }>;
  /** Le processus n'a pas encore été observé terminé. */
  readonly alive: boolean;
  /** Description durable du processus (commande et pid) pour le journal de session. */
  describe(): string;
}

export interface TaskAgentAdapter {
  agent: 'codex' | 'pi';
  /** Préparation propre à l'agent avant la création de la sandbox (kit, chemins). */
  prepare(context: TaskAgentContext): Promise<{ createTarget: string; createMounts?: string[] }>;
  /** Invocation de l'agent et traitement de ses événements, verdicts et preuves. */
  run(context: TaskAgentContext): Promise<{ exitCode: number; report: string; diagnostics: TaskDiagnostic[] }>;
}
