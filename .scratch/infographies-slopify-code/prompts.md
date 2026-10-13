# Prompts de génération

Outil : imagegen intégré. Images générées séparément, sans image de référence.

## Planche 1

```text
Use case: infographic-diagram. Crée une infographie pédagogique professionnelle EN FRANÇAIS, très nette, grande résolution, format paysage 3:2. Style éditorial de documentation logicielle, fond ivoire presque blanc, texte bleu nuit, accents cohérents : utilisateur ambre, hôte violet, CLI bleu, agent de tâche turquoise, sous-agents vert. Typographie sans serif extrêmement lisible, titres forts, petites icônes discrètes, connecteurs explicites avec pointes de flèche. Aucun décor inutile, aucun personnage photoréaliste. Marges généreuses, diagrammes structurés, ne pas croiser les flèches. Reproduire les textes courts ci-dessous avec leurs accents et les identifiants techniques exacts. Ne pas inventer de fonctions. Basé sur l'inspection du code, HEAD d6504a4b0, 08/10/2026. 
PLANCHE 1/3. Titre exact « Slopify — Qui parle à qui ? ». Sous-titre « Deux niveaux d’orchestration : le lot, puis la délégation dans une tâche ».

Composition : grand diagramme de haut en bas, quatre étages, avec retours discrets à droite.
Étage 1 : carte « UTILISATEUR » avec « Exprime le besoin • arbitre • consulte le bilan », reliée en double sens à « AGENT HÔTE · Pi ou Codex » avec « Session externe à Slopify », « Prépare spec.md + batch.json », « Appelle la CLI et interprète ses sorties ». Flèche user vers hôte « besoin », retour « résultats / décisions ».
Étage 2 : « CLI SLOPIFY · slopify tasks ». Flèche hôte vers CLI « run / status / resume ». Trois modules à l'intérieur : « Valider le lot » (champs, IDs, dépendances, cycles, spec lisible) ; « Ordonner les vagues » (5 tâches prêtes maximum, ordre du JSON) ; « Intégrer et sauvegarder » (branche dédiée, état durable, traces).
Retour CLI vers hôte « stderr : progression JSONL » et « stdout : un JSON final avec --json ».
Petit encart latéral lié à CLI « ÉTAT DURABLE » : « state.json • contexte figé • tentatives • logs • checkpoints ».

Étage 3 : montrer DEUX cadres de sandbox Docker distincts côte à côte sous la CLI, chacun avec une flèche « 1 tâche → 1 sandbox par tentative ».
Dans cadre gauche « SANDBOX · TÂCHE A », carte « AGENT PRINCIPAL Pi » (kit Pi + Mistral ; implémente, teste, commit).
Dans cadre droite « SANDBOX · TÂCHE B », carte « AGENT PRINCIPAL Codex » (codex exec ; implémente, teste, commit).
Chaque sandbox contient spec figée et skills « implement · tdd · code-review », marqués « lecture seule ».

Étage 4 À L'INTÉRIEUR DE CHAQUE cadre Docker : depuis agent principal flèches « délègue la revue » vers DEUX petites cartes « SOUS-AGENT Standards » et « SOUS-AGENT Spec », avec retour « constats » vers principal.
Sous Pi : « extension subagent · deux rôles configurés ». Sous Codex : « collaboration native · sessions collectées ». Annotation commune « Le principal agrège les revues, corrige et rend son verdict ».
Flèches retour principal vers CLI « rapport + verdict + checkpoint Git ». Ne pas dessiner de flèche directe sous-agent vers user ou hôte.

Bandeau bas : « 5 = plafond de tâches par vague, pas de sous-agents. La CLI ne crée pas un sandbox Docker distinct pour chaque reviewer. »
Second court bandeau « Le parcours V2 appelle acp-sandbox directement ; les autres bibliothèques ACP restent présentes dans le monorepo. »
Pied « Sources code : cli.ts · taskBatch.ts · dockerTaskExecutor.ts · piTaskAdapter.ts ».

```

## Planche 2

```text
Use case: infographic-diagram. Crée une infographie pédagogique professionnelle EN FRANÇAIS, très nette, grande résolution, format paysage 3:2. Style éditorial de documentation logicielle, fond ivoire presque blanc, texte bleu nuit, accents cohérents : utilisateur ambre, hôte violet, CLI bleu, agent de tâche turquoise, sous-agents vert. Typographie sans serif extrêmement lisible, titres forts, petites icônes discrètes, connecteurs explicites avec pointes de flèche. Aucun décor inutile, aucun personnage photoréaliste. Marges généreuses, diagrammes structurés, ne pas croiser les flèches. Reproduire les textes courts ci-dessous avec leurs accents et les identifiants techniques exacts. Ne pas inventer de fonctions. Basé sur l'inspection du code, HEAD d6504a4b0, 08/10/2026. 
PLANCHE 2/3. Titre « Slopify — Du lot au résultat intégré ». Sous-titre « Une vague exécute en parallèle ; les checkpoints sont intégrés ensuite, dans l’ordre du JSON ».

En haut : un rail de quatre étapes numérotées.
« 1 · ENTRÉE » : spec.md + batch.json ; par tâche : id, prompt, agent, dependsOn, source.
« 2 · VALIDATION » : JSON, champs, IDs, dépendances, cycles, accès spec et référence Git ; rejet avant création du run.
« 3 · CONTEXTE FIGÉ » : copie spec + lot ; runId et commit de base ; état durable.
« 4 · ESPACES PRIVÉS » : clone Git d’intégration ; un clone par tentative ; travail non commité de l’utilisateur exclu.

Zone dominante au centre : exemple de trois vagues de gauche à droite avec barrières d’intégration entre elles, flèches lisibles.
Légende « Exemple de dépendances : A et B → C → R ; R est une revue finale ajoutée au lot ».
Vague 1 : DEUX cartes en parallèle « A · Pi » et « B · Codex » partant du même point « base C0 » ; chacune produit un checkpoint. Sous les deux « Attendre la fin de A ET B ». Barrière « Intégrer A, puis B » → « commit intégré C1 ».
Vague 2 : « C · Pi », « dépend de A et B » ; « base C1 » ; checkpoint puis barrière « Intégrer C » → « commit intégré C2 ».
Vague 3 : « R · revue finale », « dépend de A, B et C » ; « base C2 » ; checkpoint puis barrière « Intégrer R » → « résultat du run ».
Grand cartouche sous le diagramme « Une dépendance est satisfaite seulement à succeeded. completed = checkpoint produit, intégration encore attendue. »
Petit cartouche « La revue finale est une tâche ordinaire : la CLI ne l’ajoute pas automatiquement. »
Au-dessus du rail vagues « Règle générale : les 5 premières tâches prêtes, dans l’ordre du lot. La vague suivante attend toute la vague et ses intégrations. »

En bas, deux zones séparées.
À gauche « DANS UNE TÂCHE » chaîne « agent + instructions + skills → code / tests / revues → verdict final ». Afficher en monospace SLOPIFY_RESULT={"status":"succeeded"}.
Puis « Sortie agent 0 + aucun diagnostic bloquant → checkpoint Git vérifié → completed ». Puis « Intégration réussie → succeeded ». Note « Le verdict est déclaré par l’agent ; les tests restent à examiner dans les preuves. »
À droite « CE QUI EST LIVRÉ » : « Branche locale feature/slopify-<runId> », « Rapports, logs et bundles conservés », « Sandbox réussi supprimé après intégration, sauf échec de nettoyage », « Branche courante de l’utilisateur préservée », « Pas de merge automatique dans main ni de push distant ».

Pied « Sources code : taskBatch.ts · dockerTaskExecutor.ts · agentOutcome.ts ».
Éviter les faux symboles de code, conserver C0 C1 C2 comme noms illustratifs, ne pas dessiner R avant C.

```

## Planche 3

```text
Use case: infographic-diagram. Crée une infographie pédagogique professionnelle EN FRANÇAIS, très nette, grande résolution, format paysage 3:2. Style éditorial de documentation logicielle, fond ivoire presque blanc, texte bleu nuit, accents cohérents : utilisateur ambre, hôte violet, CLI bleu, agent de tâche turquoise, sous-agents vert. Typographie sans serif extrêmement lisible, titres forts, petites icônes discrètes, connecteurs explicites avec pointes de flèche. Aucun décor inutile, aucun personnage photoréaliste. Marges généreuses, diagrammes structurés, ne pas croiser les flèches. Reproduire les textes courts ci-dessous avec leurs accents et les identifiants techniques exacts. Ne pas inventer de fonctions. Basé sur l'inspection du code, HEAD d6504a4b0, 08/10/2026. 
PLANCHE 3/3. Titre « Slopify — Suivre, reprendre, résoudre ». Sous-titre « État durable, interventions explicites et limites réellement visibles dans le code ».

Trois colonnes principales bien alignées, avec un bandeau de suivi au-dessus.
Bandeau « OBSERVER » : commande « slopify tasks status <runId> --json » ; trois champs « progress : états / compteurs », « issues : causes / blocages / conflits », « nextActions : commandes et préconditions ». Texte « status relit state.json ; running ne prouve pas qu’un processus est vivant. Les actions proposées ne sont pas exécutées. »

Colonne gauche ambre « ÉCHEC OU INTERRUPTION ».
Diagramme « A échoue » flèche vers « descendants de A : blocked », à côté « tâches indépendantes : continuent ». Texte « Aucune relance automatique ».
Deux blocs commandes :
« tasks resume <runId> » : « Retente échecs et interruptions ; remet les blocages en attente ; réutilise réussites et checkpoints récupérables. »
« tasks resume-task <runId> <taskId> » : « Une tâche seulement ; dépendances déjà succeeded ; nouvelle tentative et sandbox. »
Note « Après crash : arrêter l’ancien agent avant de retenter un état running. Le code ne vérifie pas sa présence. »

Colonne centrale bleu « CONFLIT D’INTÉGRATION ».
Diagramme « checkpoint + état intégré » → « conflicted » → « nouveaux lancements suspendus ».
Commande « tasks conflict <runId> » puis trois chemins explicites :
« use-current » → « conserve l’état courant ; tâche entrante failed »
« use-incoming » → « retente l’intégration du checkpoint entrant ; le conflit peut réapparaître »
« manual » → « crée un clone Git LOCAL au commit courant » → « appliquer la résolution et committer » → « tasks validate-resolution <runId> <resolutionId> » → « bundle puis intégration et reprise ».
Note visuelle claire « Le workspace manuel est un clone sur disque, sans création de sandbox Docker dans ce chemin. »

Colonne droite turquoise « PREUVES ET CONTRÔLES ».
Petit arbre de stockage :
« <store>/<runId>/ »
« state.json »
« context/ : spec + batch figés »
« integration/ : clone Git »
« workspaces/ : clones de tentatives »
« attempts/ : logs, rapports, bundles »
« resolutions/ : clones et bundles »
Texte « Store par défaut sous ~/.local/share/slopify/task-runs/<hash-repo>/ ; configurable. »
Bloc « La CLI contrôle » : « verdict final explicite », « erreurs agent et sous-agents observées », « ascendance des checkpoints Git ».
Bloc « Pas de garantie automatique » : « aucune exécution globale de tests par la CLI », « absence de revue non rejetée à elle seule », « validation manuelle : ascendance Git, sans tests ni contrôle sémantique de la fusion ».

Bandeau bas « Codes : 0 = exécution réussie ou consultation réussie · 2 = exécution échouée / interrompue / en conflit · 1 = entrée ou commande invalide ».
Pied « Sources code : taskBatch.ts · taskBatchCli.ts · taskBatchReport.ts · piTaskAdapter.ts · dockerTaskExecutor.ts ».
Ne pas transformer les stratégies en promesses de résolution correcte. Tout est basé sur la version inspectée, pas sur l’intention documentaire. Les commandes abrégées tasks supposent le préfixe slopify.

```

