# Fiabiliser les smokes V2 et la revue Pi locale

Base : PR #172, commit `21c2928069030970493fca6400f0b791be8e4db3`.
Origine : rétrospective du 20 octobre 2026, correctifs demandés par l'utilisateur.
Suivi : spec [#173](https://github.com/maurice30120/Slopify/issues/173), tickets [#174](https://github.com/maurice30120/Slopify/issues/174), [#175](https://github.com/maurice30120/Slopify/issues/175) et [#176](https://github.com/maurice30120/Slopify/issues/176).

## Résultats observés

- Smoke local : Pi et Codex réussissent ; la revue finale échoue avec six diagnostics `pi_subagent_error`, malgré un verdict final déclaré `succeeded`.
- Les six erreurs correspondent à quatre appels `args requires workflow`, un `steer` sans message et une tentative de steering bloquée par une demande superviseur.
- Le Pi natif charge `pi-subagents@0.78.0` ; le mode sandbox utilise l'extension officielle de Pi, dont le protocole est différent.
- Le checkpoint local Pi ajoute six fichiers `.pi-lens-probe-home/*.log` au résultat intégré.
- Le smoke Docker réussit, mais sa revue tente aussi les commandes npm imposées sur un dépôt temporaire sans `package.json`.

Les preuves d'origine sont conservées localement. Les tests automatisés utilisent des fixtures anonymisées et de faux exécutables, sans dépendre de chemins personnels ni d'identifiants de session.

## Critères d'acceptation

### A. Contrat Pi local et diagnostics

1. Préparer la délégation de revue avec le contrat de l'extension Pi effectivement disponible. Une incompatibilité détectable doit produire un diagnostic exploitable avant des tentatives répétées ; aucune sélection du fournisseur/modèle ni modification de la configuration Pi personnelle.
2. Le chemin prévu pour `pi-subagents` doit fournir des instructions correctes pour les appels de délégation et la gestion d'une demande superviseur en exécution non interactive. Documenter explicitement les capacités supportées et les limites de détection.
3. Une erreur de sous-agent conserve son message original et son contexte d'appel observable. Le rapport permet de retrouver la cause sans lire tout le flux JSON.
4. Le verdict `succeeded` ne masque pas les erreurs de sous-agents non résolues. Ne pas transformer les incidents observés en succès pour faire passer le smoke.
5. Les événements JSON de la session en échec sont représentés par des fixtures minimales pour vérifier les diagnostics et la politique de rejet sans fournisseur réel.

### B. Preuves hors du résultat Git et assertions du smoke

1. Les traces Pi Lens de chaque tentative locale sont placées dans son répertoire de preuves, hors du clone destiné au checkpoint. Les conserver en cas d'échec comme en cas de réussite ; aucune modification de réglage global.
2. Le smoke vérifie les contenus exacts de `pi.txt` et `codex.txt`, ainsi que l'ensemble exact des fichiers modifiés depuis sa base. Tout fichier parasite, toute modification ou suppression d'un fichier de base fait échouer la validation avec un diagnostic lisible.
3. L'arbre et la branche du dépôt hôte restent inchangés ; les preuves et les checkpoints restent inspectables.
4. Le contrôle du smoke est testable en CI avec de vrais dépôts Git temporaires, sans lancer Pi, Codex ou Docker.

### C. Validations de la revue finale adaptées au dépôt

1. La revue finale ne suppose plus que chaque dépôt est un monorepo npm. Elle utilise les validations définies par le lot ou documentées par le dépôt.
2. Le dépôt minimal du smoke dispose d'une validation explicite des critères d'acceptation, sans commandes npm inapplicables ni ajout de fichiers produit pour contourner un échec.
3. Les dépôts disposant de commandes de build/test conservent l'obligation de les exécuter ; un échec de validation applicable reste un échec. Les dépôts sans infrastructure de build/test sont décrits factuellement, avec les vérifications réellement effectuées.
4. Les choix de validation sont figés pour le run, compatibles avec les états existants, et présents dans le contexte de la revue finale.

## Interfaces de test proposées

Confirmation utilisateur demandée avant toute écriture de test :

- `LocalTaskExecutor.execute` : faux Pi exécutable pour observer lancement, environnement, diagnostics, checkpoint et preuves. Ne prouve pas l'intégration réelle au fournisseur.
- `TaskBatchService.run` : exécuteur injecté capturant le contexte de revue finale et les choix persistés. Ne prouve pas le comportement du modèle.
- Entrée publique du validateur utilisé par `scripts/smoke-v2.mjs` : vrais dépôts Git temporaires pour vérifier le périmètre et les octets. Ne lance aucun agent réel.

## Graphe de travail

- Ticket A / #174 : contrat Pi local et diagnostics (A1–A5).
- Ticket B / #175 : isolation des traces et vérification du périmètre (B1–B4).
- Ticket C / #176 : validations de revue adaptées au dépôt (C1–C4).
- A, B et C sont indépendants ; la revue finale d'intégration dépend des trois.

## Vérification et périmètre

TDD par comportement, tests ciblés, puis build racine, suite complète et `audit:v2`. Revue Standards/Spec depuis la base de cette spec. Les smokes réels restent manuels sur le Mac ; l'autorisation de cette session couvre leur relance nécessaire à la vérification des correctifs. Aucun merge de PR, aucune réécriture de branche parente ni clôture manuelle des tickets existants de V2.
