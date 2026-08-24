# Migration Codex vers Docker Sandboxes

## Problem Statement

Slopify exécute aujourd’hui les agents isolés et transfère leurs changements au moyen de Sandcastle. Cette dépendance impose des concepts, des configurations et du code spécifiques au runtime, alors que Docker Sandboxes fournit désormais le clonage privé du dépôt, l’exécution de Codex, une politique réseau globale et un remote Git permettant de récupérer les changements.

Pour un pipeline multi-agent, la promotion actuelle par agent ne garantit pas qu’un ensemble de changements soit intégré dans un ordre reproductible ni transféré atomiquement dans le workspace hôte. Elle complique aussi l’attribution des résultats, les retries et la reprise après crash. Enfin, `sbx --clone` ne voit pas les modifications Git non commitées du workspace hôte, ce qui rendrait toute promotion ambiguë si un pipeline avec effets workspace démarrait depuis un dépôt sale.

## Solution

Remplacer entièrement Sandcastle par Docker Sandboxes pour le parcours Codex. Chaque nœud agent avec effets workspace s’exécute dans son propre Sandbox Run créé avec `sbx --clone`. Slopify crée ensuite un Agent Checkpoint technique attribué au run, au nœud et à la tentative, récupère ce checkpoint depuis le remote Git créé par Docker Sandbox, puis l’intègre dans une branche privée en respectant l’ordre topologique du DAG et l’ordre de déclaration des nœuds parallèles d’un même niveau.

Le workspace hôte reste inchangé jusqu’à ce que tous les Agent Checkpoints retenus forment un Pipeline Change Set cohérent. Une seule politique de promotion au niveau du pipeline décide alors de rejeter, demander confirmation, appliquer automatiquement ou rejeter automatiquement cet ensemble. La Promotion transfère tout le Pipeline Change Set ou rien. Un conflit suspend le pipeline et expose un diagnostic sans modifier le workspace.

La CLI vérifie avant tout pipeline avec effets workspace que le dépôt Git est propre, que `sbx` et ses capacités requises sont disponibles et que la politique réseau globale Docker est initialisée. Au premier usage, elle reprend exactement les choix Open, Balanced et Locked Down. Par défaut, les sandboxes sont nettoyées; `--keep-sandboxes` les conserve toutes et affiche les commandes nécessaires au diagnostic local.

## User Stories

1. En tant qu’utilisateur de Slopify, je veux exécuter un pipeline Codex dans Docker Sandbox, afin de ne plus dépendre de Sandcastle.
2. En tant qu’utilisateur, je veux que chaque nœud agent avec effets workspace dispose de sa propre sandbox, afin que les agents parallèles ne partagent pas un workspace mutable.
3. En tant qu’utilisateur, je veux que mon workspace hôte reste inchangé pendant l’exécution, afin de pouvoir examiner le résultat complet avant toute Promotion.
4. En tant qu’utilisateur, je veux que Slopify refuse un pipeline avec effets workspace lorsque Git contient des modifications locales, afin d’éviter que `sbx --clone` travaille sur une base différente de celle que je vois.
5. En tant qu’utilisateur, je veux que l’erreur de workspace sale explique que les changements non commités sont invisibles à `sbx --clone` et empêchent une Promotion sûre, afin de savoir comment corriger le problème.
6. En tant qu’utilisateur, je veux qu’un pipeline sans effets workspace reste exécutable dans un workspace sale, afin que le préflight ne bloque pas les usages en lecture seule.
7. En tant qu’utilisateur, je veux une erreur corrective lorsque le workspace n’est pas un dépôt Git, afin de comprendre le prérequis du clonage et de la Promotion.
8. En tant qu’utilisateur, je veux une erreur corrective lorsque `sbx` est absent ou trop ancien, afin de pouvoir installer une version compatible.
9. En tant qu’utilisateur, je veux que Slopify vérifie les capacités Docker Sandbox dont il dépend, afin d’échouer avant de lancer un pipeline incompatible.
10. En tant qu’utilisateur au premier lancement, je veux choisir Open, Balanced ou Locked Down, afin d’utiliser le modèle de politique réseau natif de Docker Sandbox.
11. En tant qu’utilisateur, je veux que Open corresponde à `allow-all`, Balanced à `balanced` et Locked Down à `deny-all`, afin que les libellés Slopify aient exactement la sémantique Docker.
12. En tant qu’utilisateur, je veux que les sandboxes héritent de la politique réseau globale, afin de ne pas configurer un second modèle réseau par nœud.
13. En tant qu’utilisateur, je veux modifier ultérieurement la politique réseau avec `sbx policy`, afin de rester compatible avec les outils Docker.
14. En tant qu’utilisateur, je veux configurer un agent avec `transport: "sandbox"` et `agent: "codex"`, afin d’exprimer clairement le nouveau runtime.
15. En tant qu’utilisateur, je veux une erreur de migration si l’ancien fichier `.acp/.sandcastle/config.json` existe, afin de ne pas croire qu’une configuration obsolète est encore appliquée.
16. En tant qu’utilisateur, je veux que cette erreur indique le chemin rejeté, la raison, un exemple de nouvelle configuration et l’étape de suppression, afin de migrer manuellement sans ambiguïté.
17. En tant qu’utilisateur, je veux que Slopify crée un Agent Checkpoint même lorsque Codex ne commite rien, afin que le résultat Git ne dépende pas du comportement de l’agent.
18. En tant qu’utilisateur, je veux que chaque Agent Checkpoint soit attribué au pipeline, au nœud et à la tentative, afin de diagnostiquer et reprendre précisément un run.
19. En tant qu’utilisateur, je veux que les checkpoints soient intégrés dans l’ordre topologique du DAG, afin que les dépendances soient respectées.
20. En tant qu’utilisateur, je veux que les nœuds parallèles d’un même niveau soient intégrés dans leur ordre de déclaration, afin que le résultat soit déterministe indépendamment de leur ordre de fin.
21. En tant qu’utilisateur, je veux qu’un retry remplace seulement le checkpoint de la tentative concernée, afin de préserver les résultats valides des autres agents.
22. En tant qu’utilisateur, je veux voir un aperçu unique du Pipeline Change Set, afin de prendre une décision sur le résultat complet plutôt que sur des fragments par agent.
23. En tant qu’utilisateur, je veux choisir une politique `discard`, `ask`, `auto-apply` ou `auto-reject` au niveau du pipeline, afin de contrôler une seule décision finale.
24. En tant qu’utilisateur, je veux qu’une Promotion applique tout le Pipeline Change Set ou rien, afin de ne jamais obtenir un état partiellement promu.
25. En tant qu’utilisateur, je veux qu’un résultat sans changement soit signalé comme tel sans mutation hôte, afin de distinguer un succès vide d’un rejet.
26. En tant qu’utilisateur, je veux qu’un rejet ne modifie jamais mon workspace, afin de pouvoir abandonner le résultat en sécurité.
27. En tant qu’utilisateur, je veux qu’une annulation, une erreur ou un timeout ne promeuve aucun changement, afin que seules les décisions explicites puissent muter le workspace.
28. En tant qu’utilisateur, je veux qu’un conflit d’intégration suspende le pipeline et liste les fichiers concernés, afin de comprendre pourquoi la Promotion est interdite.
29. En tant qu’utilisateur, je veux qu’aucun conflit ne soit résolu automatiquement par un agent dans cette version, afin que Slopify ne prenne pas de décision de fusion implicite.
30. En tant qu’utilisateur, je veux reprendre un pipeline après crash à partir de son snapshot, afin de ne pas relancer inutilement les agents terminés.
31. En tant qu’utilisateur, je veux qu’une sandbox ne soit réutilisée que si son identité et son commit de base correspondent au snapshot, afin d’éviter de reprendre une ressource étrangère ou obsolète.
32. En tant qu’utilisateur, je veux qu’une divergence lors de la reprise suspende le pipeline sans suppression ni Promotion implicite, afin de pouvoir diagnostiquer l’état réel.
33. En tant qu’utilisateur, je veux que Slopify nettoie les sandboxes après succès, rejet, annulation ou échec, afin de ne pas accumuler de ressources locales.
34. En tant qu’utilisateur, je veux que le nettoyage soit idempotent, afin qu’une reprise puisse le répéter sans transformer une ressource absente en erreur de pipeline.
35. En tant qu’utilisateur, je veux passer `--keep-sandboxes`, afin de conserver toutes les sandboxes du pipeline pour un diagnostic local.
36. En tant qu’utilisateur, je veux voir le nom de chaque sandbox conservée et les commandes pour la lancer, ouvrir un shell et la supprimer, afin de pouvoir l’inspecter sans connaître son identifiant interne.
37. En tant qu’utilisateur, je veux recevoir les sorties de Codex pendant son exécution, afin de suivre la progression du nœud.
38. En tant qu’utilisateur, je veux qu’une annulation ou un timeout soit propagé au processus exécuté dans la sandbox, afin de stopper réellement le travail.
39. En tant que mainteneur, je veux que stdin soit fermé pour l’exécution Codex non interactive, afin d’éviter que `codex exec` attende une entrée supplémentaire.
40. En tant que mainteneur, je veux que tous les appels `sbx` utilisent des tableaux d’arguments plutôt que des commandes shell concaténées, afin de conserver une frontière de subprocess sûre et testable.
41. En tant que mainteneur, je veux que le pipeline reste indépendant de Docker, afin que le bridge ACP demeure la frontière du runtime sandbox.
42. En tant que mainteneur, je veux des extensions ACP nommées `sandbox/status`, `sandbox/preview`, `sandbox/promote` et `sandbox/reject`, afin qu’aucun contrat public actif ne conserve le nom Sandcastle.
43. En tant que mainteneur, je veux supprimer la dépendance, les providers, les montages, les homes et les options propres à Sandcastle, afin de simplifier durablement le code.
44. En tant que mainteneur, je veux que cette première migration accepte uniquement Codex, afin de valider un parcours étroit avant d’ajouter Pi et Vibe via `sbx`.
45. En tant que mainteneur, je veux tester le contrat CLI avec un faux exécuteur `sbx`, afin de couvrir les comportements sans démarrer de microVM dans la suite ordinaire.
46. En tant que mainteneur, je veux un smoke test opt-in contre Docker Sandbox réel, afin de détecter les écarts entre le faux exécuteur et la CLI installée.

## Implementation Decisions

- Le package d’isolation devient `@acp-client/sandbox` et expose des concepts neutres; aucun type public actif ne conserve le nom Sandcastle.
- Le module de runtime Docker détecte `sbx`, vérifie une version minimale de 0.35.0, crée les sandboxes Codex avec `--clone`, exécute les processus, diffuse stdout/stderr, propage annulations et timeouts, liste les ressources pour la reprise et effectue le nettoyage.
- Le module de Promotion Git crée les Agent Checkpoints dans les clones privés, récupère les refs via les remotes `sandbox-<name>`, calcule les aperçus sans mutation hôte, intègre les checkpoints sur une branche privée du run et réalise la Promotion atomique.
- Les commandes de version utilisent `sbx version`; `sbx --version` n’est pas un contrat valide.
- L’exécution non interactive de Codex ferme stdin. Le prototype a validé `codex exec` dans une sandbox clonée et a montré qu’un stdin ouvert provoque une lecture d’entrée supplémentaire.
- Les noms de sandbox sont stables, compatibles avec `sbx`, dérivés du run, du nœud et de la tentative, puis complétés par un hash court pour éviter les collisions après normalisation.
- Chaque nœud agent avec effets workspace possède une sandbox distincte. Les nœuds sans effets workspace ne déclenchent pas les contraintes Git du parcours d’écriture.
- Slopify, et non Codex, crée le commit technique de l’Agent Checkpoint avec une identité Git dédiée.
- Le snapshot de pipeline persiste le nom de sandbox, le commit de base, le checkpoint, l’état d’intégration et les références de diagnostics nécessaires à une reprise déterministe.
- L’intégration suit l’ordre topologique du DAG, puis l’ordre de déclaration pour les nœuds parallèles d’un même niveau. L’ordre de fin des agents n’influence jamais le Pipeline Change Set.
- Un Integration Conflict produit un état suspendu et un diagnostic structuré des fichiers concernés. Aucune Promotion n’est possible tant que le conflit subsiste.
- La politique de Promotion quitte les nœuds et appartient au pipeline. Les valeurs sont `discard`, `ask`, `auto-apply` et `auto-reject`.
- L’aperçu, la décision et la Promotion portent sur un seul Pipeline Change Set. La validation de la base précède une mutation hôte atomique.
- La politique réseau n’appartient plus aux nœuds. Slopify initialise la politique Docker globale avec Open/`allow-all`, Balanced/`balanced` ou Locked Down/`deny-all`, puis laisse `sbx policy` gérer les modifications.
- La seule configuration d’agents chargée est `.acp/acp-agents.json`. Le transport sandbox accepte uniquement `agent: "codex"` dans cette version.
- La présence de `.acp/.sandcastle/config.json` est une erreur explicite de migration; il n’existe ni parsing silencieux, ni fallback, ni compatibilité d’exécution.
- CPU, mémoire, template et kit restent aux valeurs par défaut Docker Sandbox et ne sont pas exposés dans la configuration Slopify.
- Le nettoyage est la valeur par défaut. `--keep-sandboxes` conserve toutes les sandboxes d’un pipeline, y compris celles en succès ou en erreur, puis affiche des commandes de diagnostic copiables.
- La reprise compare l’identité et la base observées via `sbx ls --json` avec le snapshot. Une divergence suspend la reprise sans relancer, supprimer ou promouvoir implicitement.
- La frontière ACP est conservée. Les opérations d’extension publiques deviennent `sandbox/status`, `sandbox/preview`, `sandbox/promote` et `sandbox/reject`.
- La dépendance `@ai-hero/sandcastle` et le code spécifique aux providers Pi/Vibe/Cursor, aux images, aux montages de credentials et aux homes Sandcastle sont supprimés plutôt que conservés derrière une compatibilité.

## Testing Decisions

- Le seam principal est la CLI de pipeline de bout en bout. Les tests fournissent un exécuteur `sbx` contrôlé à la frontière de subprocess, puis observent uniquement le code de sortie, les messages utilisateur, les événements de pipeline, l’état Git hôte, les snapshots et les diagnostics produits.
- Les tests ordinaires ne vérifient ni l’ordre exact de toutes les fonctions internes ni les classes concrètes. Ils vérifient les invariants externes: aucune mutation avant Promotion, attribution des checkpoints, intégration déterministe et atomicité du transfert final.
- Le faux exécuteur couvre les réponses et erreurs de `version`, `create --clone`, `exec`, `ls --json`, `policy` et `rm --force`, y compris annulation, timeout, ressource absente et ressource incompatible.
- Les tests du catalogue couvrent la nouvelle configuration sandbox Codex, le rejet des agents non pris en charge et l’erreur de migration de l’ancien fichier.
- Les tests du préflight couvrent dépôt absent, workspace sale, parcours lecture seule, binaire absent, version trop ancienne, capacité manquante, politique réseau non initialisée et collision de nom.
- Les tests de pipeline couvrent deux agents parallèles terminant dans des ordres opposés mais produisant le même résultat intégré, un retry qui remplace une seule tentative, et un conflit qui suspend sans mutation hôte.
- Les tests de Promotion couvrent `discard`, `ask`, `auto-apply`, `auto-reject`, aucun changement, rejet utilisateur, annulation, erreur et changement de la base hôte avant Promotion.
- Les tests de cycle de vie couvrent le nettoyage idempotent et `--keep-sandboxes` avec les commandes d’inspection affichées.
- Les tests de reprise couvrent un crash après création, après checkpoint et avant Promotion, ainsi que le refus de réutiliser une sandbox dont l’identité ou la base diverge.
- Un smoke test opt-in exécute le parcours minimal validé par le prototype contre un vrai `sbx`: création clonée, `codex exec` non interactif avec stdin fermé, checkpoint technique, fetch du remote, aperçu sans mutation hôte, puis nettoyage explicite.
- Les tests existants de bridge ACP, de workspace runtime, de politiques de pipeline, d’exécution V3 et de backend CLI constituent le prior art à faire évoluer vers les nouveaux noms et invariants.

## Out of Scope

- Support de Pi, Vibe ou Cursor; ils pourront être ajoutés plus tard via Docker Sandbox.
- Fallback Sandcastle ou maintien d’une compatibilité d’exécution avec Sandcastle.
- Résolution automatique des Integration Conflicts par un agent.
- Support des workspaces Git sales au moyen d’un snapshot, stash ou commit automatique.
- Configuration par nœud de la politique réseau.
- Exposition de CPU, mémoire, templates, kits ou images Docker Sandbox.
- Usage d’un SDK Docker Sandboxes non documenté à la place de la CLI `sbx`.
- Promotion indépendante d’un Agent Checkpoint avant la fin du pipeline.

## Further Notes

- Le prototype jetable du 24 juillet 2026 a validé le parcours minimal avec `sbx` 0.35.0 et Codex CLI 0.142.4: clone privé, exécution Codex, isolation du workspace hôte, commit technique, fetch du remote et diff côté hôte.
- Le prototype est une preuve de faisabilité, pas une architecture de production. Son harness reste disponible pour comparer le comportement réel pendant la migration.
- La suppression finale de Sandcastle n’est achevée que lorsque le lockfile ne contient plus `@ai-hero/sandcastle` et qu’une recherche insensible à la casse ne trouve le terme que dans l’historique de migration et l’erreur dédiée à l’ancien fichier.
- Le document de planification et les ADR existants restent les sources des décisions architecturales; cette spécification exprime le contrat utilisateur et les critères observables à livrer.
