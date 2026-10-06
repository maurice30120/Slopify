# Conception de Slopify V2

## Décisions confirmées

- La préparation se déroule dans une conversation externe à Slopify, avec un même agent pour `grill-with-docs` → `to-spec` → `to-tickets`.
- Slopify démarre avec les tickets approuvés et leurs dépendances. Chaque tâche d’implémentation est confiée à un agent isolé.
- Tous les implémenteurs lancés par Slopify travaillent dans Docker Sandbox, avec un sandbox distinct par tâche, pour Pi et Codex. Le Pi coordinateur reste dans la session habituelle de l’utilisateur, hors des sandboxes d’implémentation.
- Les tickets sont utilisés aussi bien sous forme de fichiers locaux que d’issues, environ à parts égales. La V2 doit prendre en charge ces deux sources ; une entrée limitée aux fichiers locaux ne répond pas au besoin.
- L’expérience cible part de Pi : l’utilisateur lui demande « utilise Slopify pour implémenter les tâches de la spec ». L’utilisateur reste dans sa conversation avec Pi pour déclencher l’implémentation.
- Pi garde la main pendant l’exécution, suit le run jusqu’à son terme et vérifie son état. Il présente les échecs et les interventions nécessaires à l’utilisateur, puis contrôle le bilan final avant de lui présenter le résultat.
- Chaque agent produit un compte rendu à la fin de sa tâche, y compris en cas d’échec. Slopify transmet ce compte rendu à Pi avec le résultat de la tâche, pour lui permettre de suivre le travail. Ce retour ne transfère pas à Pi la responsabilité du scheduler.
- La demande porte sur l’implémentation de la spec entière et de tous ses tickets associés, comme dans le skill officiel `implement-spec`. La sélection d’un sous-ensemble de tickets n’est pas le parcours cible V2.
- Si un ticket de la spec dépend d’un ticket extérieur encore inachevé, Pi bloque le lancement et signale le prérequis manquant à l’utilisateur. Il n’élargit pas automatiquement le périmètre de la spec approuvée.
- Pi récupère la spec et les tickets approuvés depuis les sources auxquelles il a accès, puis transmet le lot complet à Slopify avec les dépendances et les références de source. Slopify valide le graphe et décide quand lancer chaque tâche ; Pi ne pilote pas les lancements tâche par tâche.
- Pi et Codex sont pris en charge comme agents d’implémentation dès la V2. Le fait que Pi soit le point d’entrée ne contraint pas le choix de l’implémenteur.
- Pi choisit l’agent d’implémentation pour chaque tâche et transmet cette attribution avec le lot à Slopify. Un même run peut donc contenir des tâches exécutées par Pi et Codex.
- Pi prépare une copie locale du contexte avant le lancement : contenu des tickets, critères d’acceptation et spec. Les implémenteurs reçoivent le contexte de leur tâche et un pointeur vers cette copie locale de la spec ; ils n’ont pas besoin d’accéder au tracker. Les références vers les sources d’origine sont conservées.
- La copie locale du contexte reste figée pendant le run. Les changements apportés aux tickets ou à la spec après le lancement sont pris en compte lors d’une nouvelle exécution.
- Slopify fusionne chaque tâche réussie dans une branche d’intégration dédiée. Les tâches dépendantes démarrent depuis l’état intégré courant. La branche de travail de l’utilisateur reste inchangée jusqu’à ce qu’il récupère le résultat.
- En cas de conflit d’intégration, Slopify suspend les nouveaux lancements et conserve les résultats. Pi reçoit les fichiers en conflit et les tâches concernées, propose une résolution et demande à l’utilisateur d’autoriser une tentative dans un sandbox dédié. Slopify reprend après résolution et validation. La résolution entièrement automatique est hors du périmètre V2.
- Les tâches déjà en cours au moment d’un conflit terminent leur exécution. Leurs résultats sont conservés, sans être fusionnés avant la résolution et la validation du conflit.
- Un échec d’implémentation bloque les tâches qui dépendent de la tâche échouée, sans arrêter les tâches indépendantes. Slopify signale l’échec à Pi, qui le présente à l’utilisateur.
- Slopify V2 ne relance pas automatiquement les tâches échouées. Une nouvelle tentative passe par une commande explicite de reprise, sur demande de l’utilisateur. La spec et les tickets restent figés.
- Un fichier d’état local par run conserve les statuts des tâches, leurs commits et la branche d’intégration. La reprise réutilise les résultats déjà intégrés pour éviter de refaire les tâches réussies.
- Une tâche interrompue sans résultat enregistré est marquée interrompue. Sur demande explicite, elle recommence depuis zéro dans un nouveau sandbox basé sur la branche d’intégration courante ; Slopify ne reprend pas la conversation de l’ancien agent. Les tâches déjà intégrées restent acquises.
- Les sandboxes réussis sont supprimés après récupération durable de leur commit et de leurs logs. Les sandboxes en échec ou interrompus sont conservés pour inspection.
- Pi transmet le lot à Slopify dans un fichier JSON unique contenant les tâches, leurs dépendances, l’agent choisi par tâche et les chemins vers le contexte local figé. Slopify reçoit ce même format quelle que soit la source des tickets ; Pi traite les différences entre fichiers locaux et issues avant le lancement.
- Chaque tâche contient un champ `prompt` avec l’appel du skill, le texte du ticket, les critères d’acceptation et les interfaces de test approuvées. Ce champ remplace `ticketFile` ; aucun champ `skill` séparé n’est ajouté. Pi compose le prompt adapté à l’agent choisi et Slopify le transmet tel quel, sans parser les commandes de skills ni convertir `/` en `$`. Le contenu du lot JSON constitue la copie figée du texte des tickets ; la spec reste un fichier local commun.
- Slopify valide tout le lot au démarrage, avant de créer des sandboxes ou de lancer des agents : format JSON, champs requis, identifiants uniques, agents reconnus, dépendances présentes, absence de cycles et accès au contexte local. Une erreur rejette le lot complet avec un diagnostic que Pi peut corriger ; aucune exécution partielle d’un lot invalide n’est lancée.
- Le scheduler fonctionne par vagues : il lance les tâches disponibles en parallèle, attend leur fin, intègre les résultats réussis puis calcule la vague suivante. Une tâche devenue exécutable attend la fin de la vague en cours. Ce compromis privilégie la simplicité du code plutôt que le lancement continu dès qu’une dépendance est intégrée.
- Aucun plafond de concurrence n’est appliqué en V2 : toutes les tâches disponibles dans une vague sont lancées en parallèle, chacune dans son Docker Sandbox.
- Chaque implémenteur suit le parcours complet du skill `implement` : TDD lorsque possible aux interfaces de test convenues, typechecking et tests ciblés réguliers, suite complète en fin de tâche, revue puis commit.
- Slopify utilise les skills utiles du dépôt officiel [mattpocock/skills](https://github.com/mattpocock/skills), sans réécrire leurs instructions. Ils sont regroupés dans un dossier de skills. La cible retenue est de les installer sur disque dans le sandbox avant de démarrer l’agent, avec leurs ressources et références, puis d’utiliser une invocation courte dans le prompt plutôt que d’y recopier leur contenu. La syntaxe d’invocation dépend de l’agent.
- L’installation embarque tous les skills du dépôt officiel `mattpocock/skills`, avec leurs ressources et références, plutôt qu’un sous-ensemble minimal limité au parcours d’implémentation et de revue.
- L’installation et la mise à disposition des skills utilisent `sbx skills`, selon le choix explicite de l’utilisateur, plutôt qu’une copie privée via `sbx cp`. Le magasin partagé doit être exposé en lecture seule aux agents. Les mises à jour sont explicites ; Pi nécessite un montage explicite du magasin et sa déclaration via `--skill <racine>`.
- La version des skills n’est pas figée par commit et Slopify ne maintient pas de suivi de révision des skills. L’utilisateur a abandonné cette contrainte pour simplifier la V2 ; les skills utilisés sont ceux installés dans le magasin `sbx skills`.
- Pi fait valider par l’utilisateur les interfaces à tester pendant la préparation et les inclut dans le contexte local figé des tâches. Les implémenteurs disposent ainsi de l’accord préalable demandé par le skill `tdd` avant d’écrire leurs tests.
- Pour que `code-review` couvre les changements jusqu’à `HEAD` sans modifier les skills officiels, l’implémenteur crée un commit provisoire dans son sandbox avant la revue. Slopify fournit le commit de départ comme point de comparaison. Après la revue, l’implémenteur committe les corrections éventuelles et Slopify récupère le résultat final.
- À la fin du run, Slopify retourne la branche d’intégration et le bilan des tâches. Pi présente le résultat à l’utilisateur, qui décide de le récupérer dans sa branche. Slopify n’effectue pas de fusion automatique dans la branche de travail de l’utilisateur.
- La clôture des tickets est confiée à Pi sur demande de l’utilisateur, selon les règles du tracker. Slopify ne clôture pas les tickets et une validation finale réussie ne déclenche pas leur clôture automatique.
- Pi ajoute au lot une tâche finale de vérification utilisant le skill officiel `code-review`, dépendante de toutes les tâches d’implémentation. Elle s’exécute dans un sandbox sur le résultat intégré ; Slopify la traite comme une tâche ordinaire. La revue porte sur les changements de l’ensemble du run, depuis son commit de départ, avec la spec locale comme référence. Le skill `code-review` ne constitue pas à lui seul une exécution des tests sur le résultat combiné.
- La tâche finale de vérification exécute le typechecking et la suite complète de tests du projet sur le résultat intégré, puis effectue la revue finale. Un échec de ces vérifications apparaît dans le bilan et empêche de considérer le run comme réussi.
- Si les tests combinés ou la revue finale détectent un problème, Pi le présente à l’utilisateur et attend son accord avant de lancer une tâche de correction. La correction n’est pas déclenchée automatiquement.
- Une correction approuvée s’exécute dans un nouveau lot basé sur la branche d’intégration obtenue, avec une nouvelle tâche finale de vérification. Le lot initial reste figé et les résultats déjà intégrés sont conservés.
- La simplicité du code est prioritaire pour les choix de conception V2, notamment pour éviter une politique de relance et de changement automatique d’agent.

Les frontières et la répartition entre agents sont détaillées dans [Limiter Slopify V2 à l’exécution des tâches d’implémentation](../adr/0007-limit-v2-to-implementation-tasks.md) et [Garder un même agent pour la préparation et isoler les implémenteurs](../adr/0008-share-preparation-agent-isolate-implementers.md).

Cette répartition était initialement décrite dans [Confier le lot à Slopify depuis Vibe (ADR historique)](../adr/0009-submit-task-batch-from-vibe.md), mais **Vibe est hors du périmètre V2** — Pi le remplace comme coordinateur et comme implémenteur, aux côtés de Codex. Voir [ADR 0011 : Remplacer Vibe par Pi/Codex pour la V2](../adr/0011-replace-vibe-with-pi-codex-for-v2.md) pour la décision finale.

## Contrat JSON confirmé

```json
{
  "specFile": "context/spec.md",
  "tasks": [
    {
      "id": "task-1",
      "prompt": "/skill:implement Consulte context/spec.md.\n\nDescription du ticket…\nCritères d’acceptation…\nInterfaces de test approuvées…",
      "dependsOn": [],
      "agent": "pi",
      "source": "https://github.com/org/repo/issues/42"
    }
  ]
}
```

Le champ `prompt` contient le texte du ticket et l’instruction de suivre le skill. `source` conserve la référence d’origine, fichier ou issue. Les chemins locaux sont résolus depuis le fichier JSON. `agent` indique `pi` ou `codex` pour chaque tâche ; `dependsOn` référence les identifiants des tâches du lot.

La dernière tâche utilise un prompt demandant `code-review` et dépend de toutes les tâches d’implémentation. Pi emploie `/skill:implement` et `/skill:code-review` pour les tâches Pi ; la syntaxe explicite documentée pour Codex est `$implement` et `$code-review`. Slopify ne traite pas cette syntaxe et n’a pas à connaître le contenu des skills. Le chargement sur disque et l’invocation non interactive ont été exercés dans le prototype ; les conditions et limites sont décrites dans son compte rendu.

## Points à intégrer après le prototype

- Fournir un kit Pi dédié : image Pi, fournisseur Mistral configuré et injection des identifiants par le proxy Docker. Le kit Pi public demande Anthropic ; sans liaison autorisée, sa création réussit mais ses requêtes échouent.
- Exposer le magasin `sbx skills` en lecture seule à Pi et déclarer sa racine avec `--skill <racine>`. Codex découvre les liens gérés par `sbx` dans `~/.agents/skills`.
- Configurer l’extension officielle d’exemple `subagent` de Pi, avec les agents de revue Standards et Spec. Codex dispose de la délégation native. Les skills officiels restent inchangés.
- Transmettre les traces de tests, de typechecking, de TDD et de délégation aux deux axes de revue. Un diff final ou des noms de commits ne prouvent pas ces étapes.
- Valider séparément le scheduler, l’intégration multi-tâches et les sources issues ; ces points ne sont pas couverts par le prototype d’une tâche.

Ce document capture la conception en cours ; aucun changement de code n’est effectué.

## Évolution du périmètre — 6 octobre 2026

L’utilisateur retire Vibe du périmètre et le remplace par Pi, pour le point d’entrée comme pour l’implémentation. Les agents cibles sont désormais `pi` et `codex`. Les ADR 0008 et 0009 décrivant Vibe restent des documents historiques et devront être alignés lors de la formalisation de la V2. Les essais Vibe sont conservés uniquement comme historique du prototype.

Le [compte rendu du prototype Docker Sandbox](../research/sandbox-skills-prototype.md) décrit les observations et leurs limites. Les sources et preuves sont capturées sur la branche jetable `feature/prototype-sandbox-skills`, dans `docs/prototypes/sandbox-skills/`. Le prototype teste le parcours d’un agent sur une tâche minuscule ; il ne valide pas encore le scheduler, les sources issues ou l’intégration multi-tâches de Slopify V2.
