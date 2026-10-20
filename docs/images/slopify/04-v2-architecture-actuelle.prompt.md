# Sketchnote de l’architecture V2 actuelle

Généré avec l’outil intégré imagegen le 19 octobre 2026, d’après les sources de l’espace de travail à HEAD `e5f2e49`.

Image finale : `04-v2-architecture-actuelle-2026-10-19.png`.

## Prompt initial exact

```text
Use case: infographic-diagram.
Create one complete, highly readable FRENCH SKETCHNOTE of the CURRENT implemented Slopify V2 architecture, not a comparison and not the proposed Kubernetes Control Plane. Wide landscape poster, ideally 3840x2160 or equivalent high resolution, white paper background, black fineliner hand-drawn diagrams, legible large hand lettering, restrained blue, teal, orange and violet highlights. This is a technical learning map for its owner, used alongside a guided code tour. Clear numbered route with coherent arrows, no visual clutter, no tiny paragraphs. Preserve enough white space. Exact terminology and relationships matter.

Title at top "SLOPIFY V2 · COMMENT ÇA MARCHE AUJOURD’HUI"
Subtitle "Un moteur local de lots · état sur fichiers · ordonnancement continu"
Small date "Code inspecté le 19 octobre 2026"

Layout: three primary columns left-to-right, with a bottom horizontal Git result strip and a compact side/bottom incident legend. The primary left column is inputs & local orchestration, middle is runtime & isolated task execution, right is persisted evidence & observation. Group boxes by real boundaries. Number the route 1 through 6. Do not draw an API server, database server, Kubernetes, durable-pi, Pi RPC, ACP sessions or independent scheduler service.

LEFT/TOP stage 1, user and conversation bubble doodle, exact title "1 · PRÉPARER LE LOT"
"Utilisateur + agent hôte Pi / Codex"
An issue/card doodle "Spec + tickets" leads to two document doodles "spec.md" and "batch.json"
Under batch doc "Prompts · dépendances · agent"
Small annotation "Préparation externe ; init fournit les modèles"

LEFT/CENTER stage 2, terminal icon "2 · LANCER"
"slopify tasks run batch.json"
Arrow to ONE big orchestration rectangle "TaskBatchService"
Inside this single rectangle three little gears with concise labels:
"Valider et figer le contexte"
"Admettre les tâches prêtes"
"Intégrer les checkpoints"
A small label inside "Transitions codées, sans LLM"
At lower edge of this box "Capacité N : 1 à 10"
Outside adjacent to orchestrator draw a small task DAG A1→B1 and A2→B2 with the A2 node having clock icon. Caption "A2 lente : B1 peut avancer"
Small note "Un seul intégrateur Git"

MIDDLE/TOP stage 3 "3 · EXÉCUTER"
A slim box "DockerTaskExecutor" connects orchestrator to "TaskWorkerPool"
Beside pool draw config file ".slopify/runtime.yaml" with short line "size · reuse / recreate".
Below pool show DEFAULT MODE nested boundaries clearly: outer dashed rounded rectangle "Worker réutilisé · Docker Sandbox (sbx)" containing an inner blue rectangle "Conteneur neuf par tentative" containing "Clone Git privé" and "Agent Pi ou Codex". A second little outer Worker silhouette behind it shows a pool, with a tiny N badge. The INNER container is created and removed per attempt; the OUTER worker and immutable assets may be reused during the lot. Small annotation "Mode par défaut : reuse"
Add small alternative note outside below: "recreate : sandbox neuve à chaque tentative"
Small colored arrow from agent to an external cloud "Fournisseur du modèle" labeled "Appels réseau via proxy".
Beside Agent line put short note "Pi : JSON / --print ; Codex : exec --json" to show current subprocess integration, not RPC.
Below nested workers a compact lifecycle loop "affecter → nettoyer → vérifier → disponible"
A tiny evidence/return arrow leaves agent toward stage 4.

RIGHT/TOP stage 4 "4 · CONSERVER LES PREUVES"
Draw local folder, not a database:
"Store local · un dossier par run"
Contents arranged as 4 readable labels:
"context/ : spec et lot figés"
"state.json : tâches, tentatives, Workers"
"attempts/ : logs, rapport, checkpoint.bundle"
"integration/ : clone Git du lot"
Use a double arrow between TaskBatchService and state.json, with label "Sauvegardes atomiques"
Draw Worker execution evidence arrow into attempts/ with label "Résultat + checkpoint".
Tiny state progression under evidence:
"pending → running → completed → succeeded"
Below exact explanation "completed = checkpoint disponible"
"succeeded = résultat intégré"

RIGHT/CENTER stage 5 "5 · OBSERVER"
Draw eye + second terminal
"tasks status / watch"
"Progression · diagnostics · prochaines actions"
A separate small clock/journal doodle "Signaux d’activité · activity.jsonl"
Arrows FROM local store to observer, label "Lecture de l’état"
Arrow from orchestrator to terminal labeled "stderr : progression et activité"
Tiny line "stdout : bilan final"
Observation does not operate the scheduling loop; watch reads and can be stopped independently.

BOTTOM spanning width stage 6 "6 · INTÉGRER ET VÉRIFIER"
Draw left-to-right sequence of Git icons/boxes:
"Checkpoint de tâche" → "Intégration séquentielle" → "Branche feature/slopify-<run-id>" → "Revue finale du lot" → "Récupération par l’utilisateur"
Label on integration-to-branch "fetch Git local"
Below branch "Branche publiée dans le dépôt hôte"
Below user recovery "Branche de travail et fichiers utilisateur préservés"
Review-final box subtitle "Tâche ajoutée automatiquement"
Next small line "Standards + Spec · corrections · build / tests"
Use an arrow from final review back to the integration branch as its changes are also integrated; do not depict unreviewed task outputs automatically merged into the user's active branch.
Tiny note under review "Revues et tests : consignes aux agents ; verdict et erreurs contrôlés"
This avoids claiming the orchestrator independently runs every test itself.

COMPACT bottom incident legend, orange outlined strip, title "SI ÇA SE PASSE MAL"
Three concise parallel notes:
"Échec d’une tâche : descendants bloqués, autres branches continuent"
"Conflit Git ou panne Docker commune : arrêt global de l’admission"
"resume / resume-task : reprise explicite, checkpoints vérifiés"
Tiny note "Aucune relance automatique ; un état running ne prouve pas que le processus vit"

Very small but readable footer: "Chemin V2 : slopify/src + primitives acp-sandbox · les anciens moteurs ACP restent dans le dépôt"
Keep arrow routing unambiguous, all text fully in canvas, no extra invented components or claims. Text must be in French and correctly accented. A diagram full of readable short labels, not a wall of text.
```

## Retouche des connecteurs

```text
Edit the attached French Slopify V2 sketchnote. Preserve the entire artwork, all text, layout, paper background, colors, icons, resolution and all node boxes exactly. Only fix the following connector routing for technical clarity:
1. The purple line "Résultat + checkpoint" must go FROM the worker/task container UP into the "attempts/ : logs, rapport, checkpoint.bundle" row of the local store in panel 4. Remove its current right-pointing arrow toward the observation terminal in panel 5. Results are stored, not sent to watch.
2. The blue "Sauvegardes atomiques" connection must be attributable to TaskBatchService: route a thin blue line from TaskBatchService around the outside top of the central execution panel into state.json in panel 4, preserving unobstructed labels. Avoid falsely making TaskWorkerPool the writer of the JSON file; it reports through the service.
3. In the bottom Git flow, add a clearly visible right-pointing arrow FROM "Branche feature/slopify-<run-id>" TO "Revue finale du lot", labeled "après toutes les tâches". Keep a separate small curved return arrow FROM "Revue finale du lot" BACK TO that integration branch, labeled "checkpoint de revue". The reviewer runs on the integrated branch's state, and its changes are integrated back. Keep the final right-pointing arrow to "Récupération par l’utilisateur".
All other content stays intact, including French spelling and the numbered stages. Do not add other components or change meaning.
```

