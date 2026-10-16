# Infographie SBX et Slopify

Générée avec l’outil intégré imagegen le 16 octobre 2026.
Contenu fondé sur README.md et docs/images/slopify/README.md.

## Prompt

Use case: infographic-diagram
Create a polished French technical infographic, landscape 16:9, high resolution, inspired by the user's reference: very dark navy background, slate rounded panels, turquoise/yellow/green/coral outlines, crisp white large sans-serif typography, flat pictograms, clear numbered arrows, generous spacing. New original composition, no copied erroneous claims from reference.
Title exact: "Avec Slopify, je pilote. Les agents exécutent."
Subtitle exact: "Slopify orchestre les tâches ; SBX isole leur exécution."
Layout: Three main panels across middle, a wide coral human control panel at bottom with thin lines to orchestration and result. Make hierarchy instantly understandable with minimal text.
LEFT turquoise panel title "Slopify — l’orchestrateur", small laptop/flowchart icon. Text "Spec + lot de tâches JSON" then three concise rows "Valide le lot et les dépendances", "Lance jusqu’à 10 tâches prêtes par vague", "Suit l’état, les rapports et les reprises".
Arrow from left to middle labelled "1 · Lance les tâches".
CENTER wider yellow panel title "SBX — Docker Sandboxes", subtitle "Une sandbox distincte par tâche". Show two sibling little sandbox cards with cube icons and labels "Tâche A · Pi ou Codex" and "Tâche B · Pi ou Codex". Both have short inner rows "Clone Git privé", "Code · outils · tests". Small badge "… jusqu’à 10 en parallèle". Bottom text inside panel "Même commit de départ pour toute la vague" and "Fin de vague → checkpoints Git". Do not imply separate sandbox for reviewers.
Arrow middle to right labelled "2 · Intègre les réussites".
RIGHT green panel title "Résultat Git", branch icon, text "Intégration dans l’ordre du lot", branch label on two readable lines "feature/" and "slopify-<run-id>", footer "Branche de travail de l’utilisateur préservée". Below panel a tiny green outlined pill "Conflit → résolution puis reprise".
BOTTOM wide coral panel: conductor silhouette at laptop on left. Title "Le développeur, chef d’orchestre". Text "Avec l’agent hôte Pi ou Codex : prépare la spec et les tâches, lance, suit et reprend le run." Small distinct caption "Slopify reçoit un lot déjà préparé." Thin coral arrow up to left labelled "Prépare et pilote"; dashed line from right back to bottom labelled "Inspecte le résultat".
A subtle bottom footer outside panels exact "Slopify = orchestration   •   SBX = isolation   •   Git = résultats traçables"
Technical truth: Local orchestration and Docker Sandboxes, never claim remote SSH, no prod or CI deployment represented, no claim zero local code, no guaranteed tests passed. Only include exact requested text, no extra paragraphs. Ensure accents correct, no spell-check squiggles, no watermark. Professional presentation quality.
