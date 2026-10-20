# Prototype du parcours skills dans Docker Sandbox

Date : 6 octobre 2026. Question : un agent isolé peut-il charger les skills officiels, implémenter une tâche, effectuer la revue indépendante Standards/Spec et produire un compte rendu vérifiable ? Périmètre final : **Codex et Pi**. Vibe a été retiré à la demande de l’utilisateur ; ses essais et le premier pont Pi sur image Vibe sont uniquement historiques.

**Verdict : le parcours fonctionne pour Codex ; Pi fonctionne avec un kit dédié et l’extension officielle de sous-agents, mais son respect strict du TDD reste partiel.** Ce résultat autorise la conception du parcours V2, pas une déclaration de conformité totale ni une validation du scheduler.

## Protocole exécuté

Deux dépôts Git jetables, même ticket approuvé `context/spec.md`, même interface `add(a: number, b: number): number` et stub retournant zéro. L’agent doit traiter positifs, négatifs et zéro, avec des tests publics. Seuls `src/add.ts` et `src/add.test.ts` sont autorisés. Une base Git fixe sert à la revue.

1. Vérifier versions, découverte des 38 skills et lecture seule du fichier `implement/SKILL.md`. Une tentative d’écriture **dans le skill** doit échouer.
2. Invoquer `$implement` pour Codex ou `/skill:implement` pour Pi, lire TDD et ressources référencées, observer les commandes RED/GREEN, faire un commit provisoire.
3. Exécuter indépendamment le typechecking, les tests, le diff et son contrôle d’espacement.
4. Charger `code-review`, effectuer deux revues indépendantes concurrentes, puis agréger les comptes rendus Standards/Spec avec leurs preuves.
5. Conserver logs, codes de sortie, commits et bundles Git. Les déclarations d’un agent sont confrontées aux traces.

Les commandes et traces de chaque phase sont dans `evidence/*.json`, `*.stdout.log` et `*.stderr.log`. Les bundles préservent les résultats sans dépendre des VM.

## Résultats observés

| Critère | Codex | Pi dédié |
|---|---|---|
| Runtime | Codex CLI 0.149.1 | Pi 1.0.4, Mistral medium latest |
| Skills officiels | Découverte native par les liens sbx | Magasin monté en lecture seule, `--skill` explicite |
| Fonction, typechecking | Réussis | Réussis |
| Tests finaux | 3/3 | 3/3 |
| TDD | RED/GREEN et ressources référencées lus | RED 3 échecs puis GREEN 3 succès ; tests écrits en bloc avant lecture TDD |
| Revue concurrente | Deux agents natifs, intervalles temporels superposés | Extension officielle `subagent`, mode parallèle, deux agents terminés à 0 |
| Standards | Aucun constat | Aucun constat de code ; note CRLF |
| Spec | Aucun constat | Un constat : conformité TDD partielle |
| Compte rendu | Terminé | Terminé ; revue finale corrigée par les preuves observées |

Commit Codex : `cd2438f13922429490f1d693e49b8214afaa7d1e`, base `b6199ce5da7d56a4883047ee29d5642223290d96`.

Commit Pi dédié : `b0141a6bc3a7c8847a835e0edcaf6cb605acb700`, base `60a69c90977e078a2f0865c55fea339a988df09c`.

La preuve Codex est `codex-parallel-proof.json` avec événements de création et horodatages des deux agents. Les rollouts complets ne sont pas embarqués dans la capture. La preuve Pi est `pi-native-subagent-proof.json` : première tentative avec deux noms d’agents inexistants, puis relance `standards`/`spec` en mode parallèle, sorties 0. Les sous-agents sont des processus Pi indépendants ; leurs prompts de rôle fournissent la baseline officielle et la spec locale.

Le premier rapport Pi affirmait la conformité totale. La relecture avec `pi-execution-evidence.md`, fondée sur les événements réels, détecte correctement les tests écrits en bloc et l’absence de lecture des ressources TDD `tests.md`/`mocking.md`. **RED/GREEN seul ne prouve donc pas le respect du skill.** Le dernier rapport applicable est `pi-native-review-report.md`, et non le premier `pi-native-final-report.md`.

Le contrôle d’espacement Pi par défaut sort à 2 à cause de CRLF dans le diff commité. Le même contrôle avec `core.whitespace=cr-at-eol` sort à 0 ; les deux preuves sont conservées. Aucune normalisation a posteriori ne masque ce résultat. Pour Codex, un contrôle initial de l’ensemble du working tree signalait des fins de lignes dans les fixtures ; le contrôle du diff effectivement commité et revu passe. Le typechecking cible le module source ; les tests sont transpilés et exécutés, sans typechecking complet des déclarations du fichier de tests.

## Conditions techniques validées

`sbx` a été mis à jour de 0.45.1 à **0.47.0**, client et serveur. Les 38 skills du dépôt `mattpocock/skills` ont été installés sans modification. Docker documente le [magasin partagé et les modes de montage des skills](https://docs.docker.com/ai/sandboxes/workflows/agent-skills/). Dans ce test Codex, le répertoire `~/.agents/skills` contient des liens vers `/run/sbx/skills-shared` : c’est leur cible qui est en lecture seule, pas nécessairement le répertoire parent.

Le kit Pi public utilise Anthropic. Sans liaison Anthropic, sa création réussit mais une requête échoue en 401. Le fichier historique `pi-native-readiness.*` concerne ce kit public initial. Il ne décrit pas le kit dédié final.

Le kit **pi-mistral** final dérive du manifeste public Pi et utilise l’image `docker.io/sbx/pi-image:latest`. Il déclare Mistral au proxy Docker, réemploie la liaison déjà configurée et injecte l’authentification pour `api.mistral.ai` ; aucune clé n’est inscrite dans les sources. Le manifeste est validé par `sbx kit validate`. Voir la documentation Docker sur les [liaisons d’identifiants](https://docs.docker.com/ai/sandboxes/configuration/credentials/). Ce parcours final ne dépend d’aucun runtime ni image Vibe.

Le fournisseur Pi utilise l’API OpenAI compatible de Mistral et `supportsStore: false` : une première requête avec `store` était rejetée en 422. L’extension de revue est l’[exemple officiel Pi subagent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent), chargé depuis le package de l’image Pi 1.0.4. La copie de référence est capturée sans modification. Les rôles Standards/Spec sont une configuration du harness ; ils ne changent pas les skills officiels.

Node 22.22.1 de l’image ne dispose pas du stripping TypeScript natif attendu. La dépendance TypeScript du poste était un wrapper natif non portable vers Linux. Le harness utilise donc **TypeScript 5.9.3 portable** et un loader Node minimal pour les tests. Cette adaptation concerne la fixture, pas le code de Slopify.

## Rejouer le test

Depuis les sources de la branche `feature/prototype-sandbox-skills`, dans `docs/prototypes/sandbox-skills` :

```sh
rtk python3 bootstrap.py all
# ou : rtk python3 bootstrap.py codex
# ou : rtk python3 bootstrap.py pi
```

Préconditions : `sbx` 0.47.0 configuré, accès npm pour TypeScript, authentification Codex et liaison Mistral existantes. Le script crée de nouveaux dépôts et noms de sandboxes uniques ; il imprime le chemin des preuves et conserve ses sandboxes pour inspection. Il ne demande aucune clé dans un argument de commande. Une phase d’exécution échouée produit un code final non nul ; la sonde d’écriture readonly attend un échec.

Les composants du parcours ont été exécutés réellement. Le script de bootstrap assemblé a été vérifié syntaxiquement, mais **n’a pas fait l’objet d’une seconde exécution intégrale**. Un nouveau run peut avoir des résultats différents, notamment sur le respect TDD. Les tags d’images `latest`, le modèle `latest` et le dépôt des skills ne constituent pas un verrouillage reproductible des versions ; les traces enregistrent celles observées lors de cet essai.

`parcours.html` est une relecture interactive des observations, autonome, avec état visible et étapes guidées. Il ne lance pas les modèles. Les sandboxes de cet essai sont arrêtées et conservées pour inspection ; les quatre sandboxes préexistantes n’ont pas été modifiées. Aucune VM globale n’a été supprimée.

## Décisions pour Slopify V2 et limites

Prévoir un kit Pi dédié, un montage explicite readonly et `--skill`, l’extension de sous-agents avec deux rôles, et la transmission des preuves d’exécution aux revues. Ne pas déduire une conformité skills d’un code correct, d’un nom de commit ou du seul texte final.

La tâche unique ne valide ni scheduler, ni dépendances entre tâches, ni intégration de branches, ni sources issues, ni suite complète Slopify, ni performance comparative des modèles. Les recherches préexistantes `codex-sandbox-skill-discovery.md` et `docker-vibe-skill-discovery.md` ont servi de point de départ ; la seconde reste historique après le retrait de Vibe.

Capture : branche jetable `feature/prototype-sandbox-skills`, dossier `docs/prototypes/sandbox-skills/`. Les décisions sont reportées dans `docs/plans/slopify-v2.md`. Aucun code de production n’est modifié par ce prototype.

Commit de capture : `89c1cc3` sur `feature/prototype-sandbox-skills`. Checkout local : `/private/tmp/slopify-v2-skills-capture`.
