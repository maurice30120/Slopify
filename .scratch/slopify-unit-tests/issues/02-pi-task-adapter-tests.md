# 02: Tests unitaires pour l'adaptateur de tâche Pi

**What to build:** une suite de tests unitaires dédiée à l'adaptateur de
tâche Pi, couvrant la préparation du kit (spec du sandbox Pi, validation du
kit, montages) et la vérification de disponibilité de l'agent (skills
officiels montés en lecture seule, extension subagent requise, version de
l'agent), en doublant le contexte de commande par des stubs.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Un fichier de test dédié couvre l'adaptateur Pi au seam public, sans
      toucher au code de production.
- [ ] `prepare` écrit un kit contenant la spec du sandbox Pi (image
      officielle Pi, point d'entrée `pi`, identifiants Mistral gérés par
      proxy) et la fait valider par la commande `kit validate` ; un échec de
      validation propage une erreur.
- [ ] `prepare` exige le montage du magasin de skills en lecture seule.
- [ ] `run` retourne le diagnostic de capacité attendu quand la commande de
      disponibilité échoue (skill illisible ou monté en écriture, agent
      indisponible), sans lever d'exception.
- [ ] `run` retourne le diagnostic d'extension manquante quand l'extension
      subagent officielle est absente du paquet Pi installé.
- [ ] Les échecs de l'adaptateur portent l'exitCode de la commande doublée et
      un rapport non vide quand il existe.
- [ ] La suite complète du paquet passe (compilation incluse) après ajout du
      fichier de test.

**Interfaces de test approuvées :**

- `createPiTaskAdapter(): TaskAgentAdapter` — champs testés : `agent` (`pi`),
  `prepare(context)`, `run(context)`.
- `TaskAgentContext` (fourni par l'exécuteur) : le contexte passé à
  l'adaptateur, avec `command(args): Promise<SubprocessResult>` doublé par un
  stub qui simule les réponses `sbx` ; `resultDirectory` pointé vers un
  répertoire temporaire réel.
- Résultat de `run` : `{ exitCode: number, report: string, diagnostics:
  TaskBatchDiagnostic[] }`.
