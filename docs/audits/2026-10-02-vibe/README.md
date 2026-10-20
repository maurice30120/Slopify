# Audit Slopify — pipeline simple / Vibe Sandbox

Audit réalisé le 2 octobre 2026 à 14:20, heure de Paris.

**Suivi :** les corrections ont ensuite été appliquées sur demande de
l’utilisateur. Voir [fix-report.md](fix-report.md) pour les nouveaux tests et
la réussite du retest complet. Le document ci-dessous conserve le
constat initial.

## Verdict

**Le parcours demandé ne fonctionne pas de bout en bout.** Le pipeline `simple`
sélectionne bien `Vibe Sandbox` dans les événements CLI, mais lance réellement
Codex avec `mistral-medium-latest`. Codex refuse ce modèle. Le run échoue avant
la création du fichier attendu, du checkpoint et de la Promotion.

La compilation et la suite de tests existantes passent. Cela ne suffit donc
pas à valider la liaison entre le catalogue d’agents et le runtime sandbox.

La protection du dépôt fonctionne : le dépôt de test reste propre, HEAD ne
change pas, aucun fichier métier n’est créé et la sandbox du run est supprimée.

## Périmètre et environnement

- Source : HEAD `919de3782ce68a4926dc9740cae07c3b36519682` **avec les modifications
  locales présentes au début de l’audit** ; ce résultat ne caractérise pas HEAD seul.
- 18 fichiers suivis étaient déjà modifiés. L’audit ne les a pas édités, commités
  ou réinitialisés. Ses ajouts sont dans ce dossier.
- Node.js `v24.18.0`, Docker Sandboxes `v0.45.1`.
- Agent demandé : `Vibe Sandbox`, transport `sandbox`, agent `vibe`, modèle
  `mistral-medium-latest`.
- Pipeline : copie exacte de `.acp/pipelines/simple.yaml`, un nœud
  `implementation`, skill `implement`, instructions `simple-implementer.md`,
  droits d’écriture et `promotion: auto-apply`.
- Exécution par la CLI compilée du projet actuel, dans un dépôt Git temporaire
  propre. Seuls le pipeline, ses instructions, sa skill et la configuration Vibe
  sont copiés ; le code Slopify exécuté vient du workspace actuel.
- Politique réseau Docker déjà initialisée, consultée sans modification.
- Timeout de prompt du scénario : 180 secondes ; garde-fou du harness : 360 secondes.

La première consultation `sbx ls --json` depuis l’environnement restreint de
l’outil échouait avec `docker login service unavailable`. La même commande avec
accès au service local a réussi. Cette erreur d’environnement n’est pas la cause
de l’échec du pipeline réel, lancé ensuite avec cet accès.

## Étapes et résultats

| Étape | Résultat | Preuve |
| --- | --- | --- |
| `rtk npm run build` | Code 0 | Observation de la session d’audit |
| `rtk npm test` | Code 0, aucune défaillance rapportée | Observation de la session d’audit ; runtime sandbox 56 tests, workspace 23, CLI 66, plus pipeline/runtime |
| Liste des pipelines | `simple`, `moyen`, `full` et trois identifiants spécialisés disponibles | Catalogue consulté dans le workspace ; liste de la fixture dans `logs/fixture-list.stdout.log` |
| Lancement dans le dépôt actuel | Refus préalable : workspace Git sale, code 1 | `logs/dirty-workspace.stderr.log` |
| Création de la fixture propre | Réussie, commit initial créé | `summary.json`, logs `init`, `add`, `commit` |
| Inventaire et politique Docker | Réussis | `logs/sandboxes-before.stdout.log`, `logs/network-policy.stdout.log` |
| `simple --agent 'Vibe Sandbox'` | Échec, code 2, durée 9 740 ms | `logs/pipeline.stdout.log`, `logs/pipeline.stderr.log` |
| Création et lancement sandbox | Création réussie ; exécution Codex observée au lieu de Vibe | Diagnostic sandbox et état durable |
| Fichier et checkpoint | Fichier absent, aucun checkpoint réussi | `summary.json`, snapshot du run |
| Promotion | Non atteinte, HEAD inchangé | `logs/base-head.stdout.log`, `logs/final-head.stdout.log`, diff vide |
| Nettoyage | Suppression réussie, inventaire identique avant/après | Diagnostic `cleanup.exitCode: 0`, `verification.json` |

Les sorties brutes de build/tests n’ont pas été archivées lors de leur première
exécution ; leur succès est une observation de session. Les logs du scénario
réel, les durées, les codes de sortie et les états persistés sont archivés ici.

## Reproduction minimale

Le harness conservé dans ce dossier prépare un dépôt temporaire et lance :

```bash
rtk node /Users/dhuyet/Documents/POC/Slopify/slopify/dist/src/cli.js run simple \
  'Create only audit-marker.txt containing exactly slopify audit ok followed by one newline. Verify its exact contents using the terminal. Do not change any other file. Do not commit or launch other pipelines or agents. Return the verification command and its result.' \
  --agent 'Vibe Sandbox' --cwd '<fixture Git propre>' --json --verbose
```

Résultat obtenu, run `26745401-79bb-43e2-8391-b6b04944a63a` :

```json
{
  "status": "failed",
  "error": {
    "nodeId": "implementation",
    "attempt": 1,
    "code": "agent_failed",
    "message": "Unable to run Codex non-interactively: Reading additional input from stdin..."
  }
}
```

Le vrai message fournisseur se trouve dans stdout :

```text
The 'mistral-medium-latest' model is not supported when using Codex with a ChatGPT account.
```

Pour une validation après correction, depuis la racine du projet :

```bash
rtk npm run build
rtk node docs/audits/2026-10-02-vibe/run-audit.mjs
```

Le harness utilise un véritable agent, crée une sandbox et peut entraîner la
consommation associée. Il conserve le dépôt temporaire pour inspection. Une
nouvelle exécution écrase ses fichiers de résultats : copier ce dossier pour
garder la preuve initiale. La version finale du harness renvoie 1 en cas de
validation incomplète ; sa première version archivait `success: false` tout en
terminant avec 0. Le code 2 de la vraie CLI est conservé dans `summary.json`.
Les contrôles supplémentaires du harness ont été ajoutés après ce run ; aucun
second lancement d’agent n’a été effectué.

## Cause confirmée et correction à préparer

### P1 — Le type d’agent est perdu entre le catalogue et le bridge

Dans `acp-workspace/src/runtime/workspaceRuntime.ts:122`, les options du
`DockerSandboxAcpBridgeAgent` transmettent `model: config.model` et
`effort: config.effort`, **sans `agent: config.agent`**.

Le bridge transmet ces options au runtime avec `...this.options`
(`acp-sandbox/src/acpBridge.ts:79`). Le runtime utilise `input.agent ?? 'codex'`
pour créer la sandbox (`runtime.ts:266`) puis pour choisir la commande
(`runtime.ts:318`). La valeur absente entraîne donc le chemin Codex, avec le
modèle Mistral bien transmis. Les logs du fournisseur confirment ce chemin.

Correction proposée : transmettre `agent: config.agent` dans les options du
bridge. Ajouter un test d’intégration **au niveau WorkspaceRuntime**, avec une
configuration `agent: 'vibe'` et un exécuteur sbx instrumenté. Vérifier à la fois
`sbx create ... vibe .` et `sbx exec ... vibe --prompt ...`, et l’absence de
lancement Codex. Le test actuel `launches Mistral Vibe programmatically inside
a Vibe sandbox` injecte directement `agent: 'vibe'` au runtime et ne traverse
pas le code fautif ; le test du catalogue vérifie seulement le parsing.

Cette correction est proposée, pas appliquée dans cet audit. Le bon routage ne
garantit pas encore que l’authentification, le modèle et le réseau Vibe
fonctionneront : leur chemin réel n’a pas été atteint.

### P2 — Le résumé d’erreur masque la cause utile

`acp-sandbox/src/runtime.ts:658` choisit `stderr.trim() || stdout.trim()`.
Ici stderr contient un message relatif à stdin, tandis que stdout contient
l’erreur structurée du fournisseur. Le résumé CLI oriente donc le diagnostic
vers stdin au lieu du couple agent/modèle.

Correction proposée : conserver les deux flux et extraire, pour les sorties
JSON connues, les événements d’erreur du fournisseur. Le résumé doit exposer
la cause fournisseur et un lien vers les diagnostics, avec le code de sortie.
Tester ce cas exact : stderr non vide et informatif mais non causal, vraie
erreur dans stdout.

### P2 — Le smoke test fourni n’est plus aligné sur la CLI

`acp-sandbox/smoke/docker-sandbox-codex.mjs:102` invoque `run` sans
`--agent 'Vibe Sandbox'`, alors que cet argument est obligatoire. La lecture du
script et le contrat CLI montrent ce défaut ; ce smoke test n’a pas été lancé.
Il choisit aussi encore l’agent dans le YAML, contrairement au contrat décrit
dans le README de la CLI.

Correction proposée : fournir l’argument CLI, retirer le choix d’agent du YAML,
renommer clairement le smoke Vibe et conserver la fixture/logs sur échec.
Le script actuel supprime sa fixture dans `finally`, rendant le diagnostic
plus difficile.

## Autres améliorations

- **Consignes contradictoires** : `.agents/skills/implement/SKILL.md:15` demande
  un commit, tandis que `.acp/agents/simple-implementer.md:12` l’interdit et
  confie la Promotion à l’hôte. Harmoniser ces consignes pour les agents de
  pipeline. Le prompt d’audit interdisait explicitement le commit.
- **Identité du bridge** : `acp-sandbox/src/acpBridge.ts:59` annonce toujours
  `Docker Sandbox Codex`. Exposer l’agent configuré pour faciliter le diagnostic.
- **Journaliser le routage effectif** : enregistrer agent, modèle, transport et
  commande exécutée avec arguments sensibles expurgés. Actuellement le nom
  convivial `Vibe Sandbox` donne une impression trompeuse du lancement réel.
- **Validation indépendante du pipeline simple** : il possède un seul nœud ;
  la vérification repose sur l’agent. Garder un contrôle hôte du fichier attendu,
  du diff, du statut Git et du nettoyage dans le smoke automatisé.
- **Validation de `VIBE_ACTIVE_MODEL`** : le runtime place cette variable dans
  l’environnement du processus hôte `sbx`. Vérifier après correction qu’elle
  atteint effectivement Vibe dans la sandbox et que le modèle demandé est
  utilisé. Le test avec exécuteur simulé ne prouve pas cette transmission.

## Critères de validation après correction

1. La configuration Vibe aboutit à une sandbox Vibe et à une commande Vibe,
   vérifiées depuis WorkspaceRuntime.
2. Le run réel `simple` retourne `completed` avec code 0.
3. `audit-marker.txt` contient exactement `slopify audit ok\n`.
4. Le checkpoint est récupéré et le Pipeline Change Set promu ; HEAD avance.
5. Le diff contient seulement ce fichier et le dépôt hôte reste propre.
6. La sandbox créée disparaît ; les ressources antérieures restent présentes.
7. Les diagnostics en cas d’échec exposent la vraie cause fournisseur.
8. Un second scénario dédié valide le rejet sans mutation de l’hôte.

Seuls le chemin d’échec et le nettoyage ont été observés en conditions réelles.
La réussite Vibe, les checkpoints, la Promotion, le rejet réel et la reprise
restent à valider. Les tests existants couvrent plusieurs de ces comportements
avec des exécuteurs simulés.

## Dossier de preuves

- `summary.json` : commandes exactes, fixture, durées, codes et commits.
- `verification.json` : vérification a posteriori du dépôt inchangé et de
  l’inventaire Docker identique.
- `logs/pipeline.stdout.log` et `logs/pipeline.stderr.log` : sorties réelles.
- `runtime-logs/` : événements JSONL, stack trace et diagnostic sandbox,
  comprenant stdout/stderr et le résultat de suppression.
- `runs-v3/` : snapshot durable et événements du run.
- `fixture-config/pipelines/simple.yaml` : pipeline testé.
- `run-audit.mjs` : harness reproductible, sans modification du code applicatif.

La fixture conservée est indiquée dans `summary.json`. Les quatre sandboxes
préexistantes n’ont pas été supprimées. Aucun déploiement ou commit du projet
principal n’a été effectué.
