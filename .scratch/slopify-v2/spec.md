# Slopify V2 — exécuter une spec avec Pi et Codex

**Status:** ready-for-agent

**Approved:** interfaces de test et découpage approuvés par l’utilisateur le 6 octobre 2026 ; implémentation dans des sous-agents autorisée.

## Problem Statement

L’utilisateur prépare une spec et ses tickets dans sa conversation avec Pi. Le moteur actuel de pipelines généralistes ajoute des étapes de préparation, une attribution d’agent globale et une promotion dans le workspace qui ne correspondent plus au parcours voulu. Il lui faut exécuter toute la spec approuvée, avec des tâches isolées, puis recevoir une branche d’intégration et un bilan fiable sans altérer sa branche de travail.

Le prototype a montré que l’installation des skills ne suffit pas : Pi a besoin d’un kit avec Mistral, d’un montage explicite et d’une extension de sous-agents. Les revues doivent disposer des traces réelles pour évaluer le processus. Un code correct et un processus terminé avec le code zéro ne prouvent pas le respect du parcours TDD ou de la revue.

## Solution

Pi rassemble la spec et tous ses tickets approuvés, issus de fichiers locaux ou d’issues, en un lot JSON unique. Slopify valide et fige ce contexte, exécute les tâches disponibles par vagues dans des Docker Sandboxes distincts, récupère leurs résultats durables et intègre les réussites dans une branche dédiée. Pi suit le run et explique son bilan, ses blocages et les interventions possibles.

Les agents d’implémentation sont exclusivement Pi et Codex pour ce parcours V2. Un run mixte est permis. Une tâche finale ordinaire, dépendante de toutes les implémentations, vérifie le résultat combiné et effectue la revue Standards/Spec. Les reprises, résolutions de conflits, lots de correction et clôtures de tickets sont explicites.

## User Stories

1. As an utilisateur, I want préparer mon besoin avec un même agent externe, so that les nuances restent disponibles jusqu’à la spec et aux tickets.
2. As an utilisateur, I want demander à Pi d’implémenter toute une spec approuvée, so that je reste dans ma conversation habituelle.
3. As an coordinateur Pi, I want lire des tickets locaux et des issues, so that les deux sources alimentent le même parcours.
4. As an coordinateur Pi, I want conserver les références d’origine, so that le bilan reste traçable jusqu’aux tickets.
5. As an utilisateur, I want un prérequis externe inachevé signalé avant lancement, so that le périmètre approuvé ne s’élargisse pas automatiquement.
6. As an coordinateur Pi, I want choisir Pi ou Codex par tâche, so that un run puisse utiliser les deux agents.
7. As an utilisateur, I want un lot invalide refusé en entier avant toute exécution, so that aucune tâche ne parte sur un graphe ambigu.
8. As an utilisateur, I want une copie figée de la spec et des prompts, so that modifier les sources pendant le run ne change pas le travail engagé.
9. As an implémenteur, I want lire mon ticket et la spec locale sans accès au tracker, so that mon environnement reste autonome.
10. As an implémenteur, I want disposer des skills officiels et de leurs ressources sur disque, so that je puisse suivre leur parcours complet.
11. As an utilisateur, I want mettre les skills à jour explicitement, so that un lancement n’effectue pas une mise à jour implicite.
12. As an utilisateur, I want un magasin de skills en lecture seule, so that les agents ne modifient pas les instructions partagées.
13. As an implémenteur Pi, I want utiliser Mistral par le proxy Docker, so that je ne dépende pas d’une liaison Anthropic.
14. As an implémenteur Pi, I want déléguer les revues Standards et Spec à deux sous-agents parallèles, so that leurs contextes restent indépendants.
15. As an utilisateur, I want toutes les tâches disponibles exécutées en parallèle dans une vague, so that les tâches indépendantes progressent ensemble.
16. As an utilisateur, I want chaque tâche dans un sandbox distinct, so that ses modifications soient isolées.
17. As an implémenteur, I want commencer depuis la branche intégrée courante, so that les résultats de mes prérequis soient présents.
18. As an utilisateur, I want les réussites fusionnées dans une branche d’intégration dédiée, so that ma branche et mes modifications locales soient préservées.
19. As an coordinateur Pi, I want les logs, le commit et un compte rendu de chaque tentative, so that je puisse expliquer les réussites et les échecs.
20. As an reviewer, I want les traces effectives de tests, typechecking, TDD et délégation, so that mes conclusions ne reposent pas sur les seuls noms de commits.
21. As an utilisateur, I want un échec bloquer uniquement ses descendants, so that les tâches indépendantes puissent continuer.
22. As an utilisateur, I want aucun retry ni changement d’agent automatique, so that je garde la maîtrise des nouvelles tentatives.
23. As an utilisateur, I want reprendre explicitement une tâche échouée, so that les réussites déjà intégrées ne soient pas refaites.
24. As an utilisateur, I want une tâche interrompue recommencer dans un nouveau sandbox, so that une conversation incomplète ne soit pas réutilisée.
25. As an utilisateur, I want les sandboxes en échec ou interrompus conservés, so that je puisse inspecter le problème.
26. As an utilisateur, I want les sandboxes réussis supprimés après sauvegarde des résultats, so that le nettoyage ne perde ni commit ni logs.
27. As an utilisateur, I want un conflit suspendre les nouveaux lancements et conserver les résultats, so that je puisse décider de sa résolution.
28. As an coordinateur Pi, I want les fichiers et les tâches concernés par un conflit, so that je puisse proposer une résolution précise.
29. As an utilisateur, I want autoriser une tentative de résolution dans un sandbox dédié, so that aucune résolution automatique ne modifie le résultat.
30. As an utilisateur, I want les tâches déjà lancées terminer malgré un conflit, so that leurs résultats restent récupérables sans être intégrés prématurément.
31. As an utilisateur, I want un état local durable avec statuts, commits et branche, so that un redémarrage n’efface pas le progrès acquis.
32. As an utilisateur, I want une vérification finale sur le résultat combiné, so that les tests et la revue portent sur toute la spec.
33. As an utilisateur, I want une vérification finale échouée empêcher le verdict de réussite, so that le bilan soit honnête.
34. As an utilisateur, I want autoriser un nouveau lot de correction, so that le lot initial reste figé et auditable.
35. As an utilisateur, I want recevoir la branche d’intégration sans fusion automatique dans ma branche, so that je choisisse quand récupérer le résultat.
36. As an coordinateur Pi, I want clôturer les tickets uniquement sur demande de l’utilisateur selon le tracker, so that Slopify ne modifie pas les sources de travail.

## Implementation Decisions

- La préparation reste externe ; Slopify devient pour la V2 un exécuteur de tâches d’implémentation, sans moteur d’entretien. Les décisions de conception existantes sont conservées, avec Pi à la place de Vibe pour la coordination et Pi/Codex comme implémenteurs.
- Le contrat confirmé est un objet contenant `specFile` et `tasks`. Chaque tâche contient `id`, `prompt`, `dependsOn`, `agent` et `source`. Les identifiants sont uniques ; `agent` vaut `pi` ou `codex`. `source` est une référence non vide de fichier ou d’issue. Les chemins du contexte sont relatifs au lot JSON. Aucun `ticketFile` ni champ `skill` supplémentaire.
- `prompt` contient l’invocation adaptée à l’agent, le texte complet du ticket, ses critères et les interfaces de test approuvées. Slopify transmet ce prompt sans interpréter ou convertir les syntaxes de skills. Les implémenteurs reçoivent aussi des pointeurs vers la spec locale figée, le commit de départ de la tâche et le commit de départ du run.
- La validation complète du lot et de la lisibilité de la spec précède la création de la branche, des sandboxes et des agents. Rejeter JSON invalide, champs requis absents ou mal typés, tâches vides, identifiants dupliqués, agent inconnu, dépendance manquante, auto-dépendance et cycles avec des diagnostics exploitables. Pi vérifie que le lot représente la spec entière et bloque les prérequis externes non résolus.
- Les dépendances déjà terminées hors du lot sont expliquées dans le contexte par Pi ; une dépendance du graphe doit référencer une tâche du lot. Slopify ne sait pas inférer la complétude de la spec ni l’état d’une issue distante.
- Une copie propre et privée du dépôt sert à l’intégration. Elle est basée sur le commit de départ choisi depuis le dépôt de l’utilisateur. Les changements hôtes non commités ne sont ni inclus ni modifiés. Le run expose sa branche dédiée au dépôt hôte sans checkout, merge ou promotion dans la branche utilisateur.
- La spec, les prompts et les références sont copiés dans le stockage durable du run avant lancement. La reprise utilise cette copie, même si les fichiers sources ont disparu ou changé.
- L’interface V2 publique offre lancement de lot, état, reprise explicite de tâches et résolution de conflit explicite. Une famille de commandes dédiée aux tâches peut coexister avec les commandes V1 pendant la transition ; les anciens pipelines ne doivent pas être utilisés pour piloter la V2.
- Le scheduler lance toutes les tâches disponibles, attend la fin de toute la vague, intègre les réussites en ordre déterministe puis calcule la vague suivante. Aucun plafond de concurrence V2. Un échec ne bloque que les descendants ; les réussites indépendantes sont conservées et peuvent faire progresser les vagues suivantes.
- Chaque tentative a une identité distincte et un Docker Sandbox propre, créé depuis l’état intégré courant. Les tâches d’une même vague partagent le même commit de départ. L’intégration réutilise les mécanismes Git de récupération de checkpoints lorsque cela simplifie le code, sans leur politique V1 de promotion hôte.
- Codex et Pi sont lancés non interactivement. Les erreurs de fournisseur, de skills, de sous-agents ou de commandes apparaissent comme échecs avec diagnostics et logs. Un processus terminé avec le code zéro ne remplace pas les preuves ou la vérification finale.
- Le kit Pi dédié utilise l’image Pi et un fournisseur Mistral correctement configuré. Les identifiants passent par le proxy Docker ; aucune clé réelle ne doit être copiée dans le contexte ou les logs. Les chemins du magasin de skills sont découverts/configurés, jamais codés avec le compte utilisateur du prototype.
- Installer tous les skills officiels et leurs ressources via `sbx skills`. Le magasin est monté en lecture seule. Pi le reçoit explicitement via `--skill`, Codex utilise sa découverte gérée par `sbx`. Aucune réécriture des skills officiels, copie privée de remplacement via `sbx cp`, mise à jour implicite ou suivi de révision des skills.
- Pi charge l’extension officielle d’exemple `subagent` et deux agents de revue Standards/Spec avec leur contexte adéquat. Codex possède la délégation native. Les capacités nécessaires sont vérifiées et leurs absences signalées.
- Les deux reviewers reçoivent explicitement les standards du dépôt, notamment les instructions AGENTS, la spec complète et la baseline Standards définie par le skill officiel. Les résultats individuels de la délégation sont vérifiables ; un processus parent réussi ne masque pas une sous-tâche de revue échouée. Cette exigence vient des erreurs de protocole et des omissions observées dans le prototype.
- Le parcours demandé à chaque implémenteur est `implement`, incluant TDD aux interfaces convenues, validations ciblées, suite complète, commit provisoire avant revue, revue depuis le commit de départ, corrections éventuelles puis compte rendu final. La revue finale du run utilise le commit de départ du run.
- Les sorties brutes et erreurs, les commandes et codes de sortie observables, les références aux rapports et les commits sont persistés. Le compte rendu de l’agent est conservé comme déclaration ; Slopify ne fabrique pas une preuve TDD ou de délégation à partir du diff. Les reviewers reçoivent les pointeurs vers les traces réelles ; une preuve manquante est indiquée comme telle.
- Les checkpoints et logs doivent être durables avant suppression d’un sandbox réussi. Les ressources échouées/interrompues restent inspectables avec leurs commandes d’accès. Une erreur de nettoyage est signalée sans effacer le résultat principal.
- L’état du run est persisté de façon atomique après les transitions importantes, avec statuts, tentatives, bases et commits intégrés, branche, conflits, ressources et rapports. Une reprise ne doit ni doubler l’intégration ni relancer les réussites. Une interruption sans résultat enregistré devient `interrupted` ; son retry explicite repart de zéro depuis la branche courante.
- Un conflit suspend l’intégration et les nouveaux lancements. Les résultats déjà obtenus restent enregistrés. Pi propose une résolution ; une action explicite crée un sandbox dédié. La reprise exige un résultat de résolution validé, puis intègre les résultats en attente avant de recalculer la frontière. Aucune résolution autonome.
- Pi ajoute une tâche finale ordinaire dépendant de toutes les implémentations ; son prompt demande le typechecking, la suite complète et `code-review` sur le résultat combiné. Le run n’est réussi que si toutes les tâches, y compris cette vérification, réussissent. Le format reste identique, sans parser le texte d’un prompt pour deviner le rôle d’une tâche.
- Si cette vérification échoue, Pi présente le problème et attend l’accord pour un nouveau lot de correction basé sur la branche obtenue, incluant une nouvelle vérification finale. Le lot initial n’est jamais modifié.
- Les guides et exemples du coordinateur couvrent les deux origines de tickets, la préparation complète, le suivi jusqu’à l’état terminal, les bilans et la clôture explicite ; Slopify n’ajoute pas de connecteurs de tracker.

## Testing Decisions

- Interfaces approuvées par l’utilisateur : API publique de lancement, lecture d’état, reprise et résolution d’un lot ; mêmes comportements accessibles par la CLI. Tests d’intégration avec vrais dépôts Git temporaires, fichiers de contexte et stockage durable, et remplacement uniquement de la frontière externe d’exécution Docker/agents.
- Préférer cette interface de lot aux fonctions internes de validation, aux transitions privées ou aux appels du scheduler. Vérifier des effets observables : diagnostic, ordre des dépendances, contenu intégré, branche hôte préservée, bilans, ressources retenues, contexte figé et absence de relance implicite.
- Les tests suivent un cycle red → green par comportement. Ils couvrent notamment lot refusé sans effet, deux tâches indépendantes plus une dépendante, run mixte, échec isolé, redémarrage, reprise avec sources modifiées, conflit entre checkpoints et vérification finale échouée.
- Les tests de sandbox utilisent l’exécuteur de sous-processus public existant uniquement comme frontière externe ; vérifier le contrat réel de `sbx`, la disponibilité des skills et le transfert durable sans mocks de collaborateurs internes.
- Prior art : tests du runtime Docker Sandbox et de checkpoints Git, tests de livraison avec graphe de dépendances et tests CLI existants. Le nouveau parcours n’est pas testé par reproduction des détails des anciens pipelines.
- Les builds TypeScript servent de typechecking. Exécuter les tests ciblés pendant chaque ticket puis `npm run build` et `npm test` sur la branche d’intégration après assemblage.
- Un smoke réel utilise de petits dépôts jetables et un lot Pi/Codex comportant une dépendance et une vérification finale. Il vérifie les commits et fichiers obtenus, les skills en lecture seule, les deux axes de revue Pi et Codex, les logs et la préservation du dépôt hôte. Les tests automatiques ne nécessitent ni clé API ni Docker.
- Ne pas présenter les observations d’un agent comme preuves indépendantes. Conserver les limites du smoke et les écarts éventuels au parcours des skills dans le rapport final.

## Out of Scope

- Vibe pour la coordination ou l’implémentation V2 ; ses essais et les audits anciens peuvent rester comme historique.
- Préparation interactive, rédaction de specs ou tickets dans le scheduler ; sélection partielle d’une spec ; lecture native de trackers par Slopify.
- Fusion automatique dans la branche de travail utilisateur, clôture automatique de tickets, résolution automatique de conflits, retries automatiques, changement d’agent automatique et réparation automatique après revue.
- Reprise de la conversation d’un ancien agent ; pinning ou suivi de révision des skills ; plafond de concurrence.
- Refonte générale d’ACP ou migration de tous les pipelines historiques V1. La coexistence transitoire ne doit pas introduire un moteur générique supplémentaire pour la V2.
- Garantir qu’un LLM suit parfaitement TDD ou qu’une revue est correcte ; le produit fournit les capacités, le contexte et les traces et rapporte honnêtement les limites.

## Further Notes

Source de conception : plan V2 et ADR sur séparation préparation/implémentation, isolation, lot transmis au scheduler et branche d’intégration. Leur formulation mentionnant Vibe doit être alignée sur la décision ultérieure Pi/Codex.

Le prototype du 6 octobre 2026 couvre une tâche minuscule, pas le scheduler ni l’intégration multi-tâches. Les traces disponibles confirment Codex avec skills sur disque, tests réussis et revue parallèle native ; Pi avec kit Mistral dédié, skills déclarés et extension exécutant Standards/Spec en parallèle. L’essai Pi natif écrit trois tests avant l’implémentation : ses résultats verts ne prouvent pas un respect des cycles unitaires TDD. Des premières revues ont conclu à l’absence de preuves faute de recevoir les logs. Le compte rendu final mentionné par le plan n’est pas présent au moment de cette synthèse ; les conclusions retenues proviennent des traces et des décisions conservées dans le plan.

Le tracker local est établi par les agents de spec et de tickets du dépôt : une spec et un fichier par ticket dans `.scratch`. La documentation standard `docs/agents/issue-tracker.md` n’existe pas encore. La configuration peut être formalisée avec `/setup-matt-pocock-skills` ; sa création ne change pas le tracker déjà utilisé.

Les observations, les sources exactes et la baseline du dépôt sont consignées dans le document compagnon [Conclusions vérifiées du prototype](prototype-findings.md). Le chat du prototype s’est arrêté sur une erreur de limite d’usage ; son essai Pi natif a toutefois terminé et ses traces sont disponibles. Cela explique l’absence du compte rendu annoncé.

Le compte rendu du prototype a depuis été sauvegardé dans docs/research/sandbox-skills-prototype.md ; sa capture Git est 89c1cc320 sur feature/prototype-sandbox-skills. Il confirme les conclusions de cette spec et complète les pointeurs de preuve.
