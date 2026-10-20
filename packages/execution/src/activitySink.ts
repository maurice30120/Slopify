/**
 * Contrat ActivitySink (ADR 0013, ADR 0015 §5) : le moteur de lots n'observe
 * l'activité d'un run que par ce seam. Le moteur possède la boucle de tick et
 * le cycle de vie (intervalle, annulation) ; le sink possède la fabrication du
 * Signal — lecture des logs, signaux Git, phrases, composition, journal du
 * run et émission. Types seuls : aucune implémentation ici, l'adapter est le
 * package activity et les tests peuvent injecter un sink en mémoire.
 */

/** Tentative active observée par un tick : identité stable et chemins de preuve. */
export interface ActivityTickAttempt {
  taskId: string;
  attemptId: string;
  /** Chemin du log stdout de la tentative dans le store du run. */
  logPath: string;
  /** Chemin du clone privé de la tentative dans le store du run. */
  workspacePath: string;
}

/** Charge utile d'un tick : le run, l'instant, les tentatives actives et la phase d'intégration. */
export interface ActivityTick {
  runId: string;
  now: Date;
  attempts: ActivityTickAttempt[];
  /** Tâche en cours d'intégration, pour la phrase de phase d'intégration. */
  integrationTaskId?: string;
}

/** Session de tick d'un run : reçoit chaque tick pendant la commande longue. */
export interface ActivitySinkSession {
  tick(payload: ActivityTick): Promise<void>;
}

/** Seam du Signal d'activité : ouvre une session par run ; le moteur garde la boucle. */
export interface ActivitySink {
  beginRun(): Promise<ActivitySinkSession>;
}
