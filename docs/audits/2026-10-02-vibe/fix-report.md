# Corrections et retests Vibe Sandbox

## État actuel

**Le pipeline `simple` avec Vibe Sandbox fonctionne désormais de bout en bout.**
Le retest final retourne `completed` avec code 0, crée le marqueur exact,
promeut son commit, laisse le dépôt propre et supprime la sandbox. **303 tests
passent**, ainsi qu’un contrôle de configuration dans le vrai runtime Vibe.

Les corrections couvrent le routage, le kit de lancement, la définition du
modèle et la confiance temporaire du clone. Après l’accord explicite de
l’utilisateur, le binding Docker Mistral a été créé pour les trois domaines
déclarés par le kit. Aucune clé n’a été lue ou modifiée.

## Changements appliqués

- `acp-workspace/src/runtime/workspaceRuntime.ts` transmet désormais
  `agent: config.agent` au bridge ACP.
- `acp-workspace/test/workspace.test.ts` couvre la configuration Vibe depuis
  le catalogue, à travers ACP, jusqu’aux commandes sbx. Le nouveau test a
  d’abord échoué avec `'codex' !== 'vibe'`, puis passé après correction.
- `acp-sandbox/src/runtime.ts` crée Vibe via
  `docker.io/sbx/vibe-kit:latest`, puis transmet la sélection active et la
  définition du modèle avec `sbx exec --env VIBE_ACTIVE_MODEL=... --env
  VIBE_MODELS=...`. `--trust` autorise les instructions du clone pour cette
  invocation uniquement.
- `acp-sandbox/test/runtime.test.ts` vérifie le kit, les variables réellement
  transmises dans la sandbox, la définition du modèle et l’option de confiance.
  Ces assertions ont été observées en échec avant la correction.
- Le smoke existant fournit maintenant `--agent 'Vibe Sandbox'` à la CLI
  et n’essaie plus de choisir l’agent dans le YAML.
- Le harness d’audit accepte un dossier de sortie pour préserver les preuves
  initiales et celles de chaque retest. La fixture et le smoke désactivent
  localement `core.autocrlf` pour vérifier exactement les fins de ligne LF.
- Le README sandbox précise le kit et les prérequis Mistral.

Le chemin Codex conserve ses commandes précédentes. Les modifications locales
préexistantes du projet sont conservées. Aucun commit du projet n’a été fait.

## Résultats des retests réels

| Retest | Résultat | Conclusion |
| --- | --- | --- |
| `fix-retest-1` | Code CLI 2, 2 704 ms ; `unknown agent "vibe"` | Le routage est corrigé, mais Vibe n’est pas intégré dans sbx 0.45.1 |
| `fix-retest-2` | Code CLI 2, 41 548 ms ; Vibe lancé, modèle par défaut, erreur d’authentification | Le kit fonctionne ; la définition du modèle et le binding credential manquent |
| Contrôle de modèle après correction | Code 0 ; `Model catalogue and active selection verified: mistral-medium-latest` | Le chargement réel des variables Vibe trouve le modèle demandé dans son catalogue |
| `fix-retest-3` | Code CLI 0, 17 108 ms ; commit promu, mais contrôle binaire du fichier en échec | Git global convertit LF en CRLF à cause de `core.autocrlf=true` ; le blob commité contient bien LF |
| `fix-retest-4` | Code CLI et harness 0, 16 621 ms ; `success: true` | Fixture LF déterministe : toutes les assertions de bout en bout passent |

Le second retest précède les dernières corrections de définition du modèle et
de `--trust`. Le troisième confirme l’authentification et la promotion après
l’autorisation utilisateur. Le quatrième confirme le contenu exact après
normalisation de la fixture. La sandbox diagnostique supplémentaire et les
sandboxes de tous les runs ont été supprimées. Les ressources préexistantes
restent présentes.

Retest final : run `975a5c10-5d22-41dc-ba93-08e89055f26a`, résultat JSON archivé
dans `fix-retest-4/logs/pipeline.stdout.log`. Base
`46eb777d2a9548678f8470382fba92a9c4bca5fa`, commit promu
`039c9bc276ad8ff722765d2abc4e05a8fb6ebdee`. Seul `audit-marker.txt` change et
contient exactement `slopify audit ok\n`. Voir `fix-retest-4/summary.json`.

## Pourquoi l’authentification échoue

Une création diagnostique du kit a affiché :

```text
credential not sent: no binding authorizes this service
no binding authorizes mistral — the credential was not injected
```

Le service `mistral` était présent dans le magasin de secrets. En revanche,
`/Users/dhuyet/.config/sbx/credentials.yaml` n’existait pas. Le manifeste du kit,
archivé dans `vibe-kit.json`, demande l’injection proxy du service `mistral`
uniquement vers `api.mistral.ai`, `chat.mistral.ai` et `console.mistral.ai`.
Le refus API observé ne prouve donc pas que la clé stockée est invalide :
Docker ne l’avait pas transmise.

Docker distingue le stockage d’un secret de l’autorisation de l’utiliser dans
un kit. En mode non interactif, un binding absent empêche son injection.
[Documentation Docker des credentials](https://docs.docker.com/ai/sandboxes/configuration/credentials/).

L’autorisation préparée est la suivante, à fusionner avec les éventuelles
autres entrées existantes :

```yaml
bindings:
  mistral:
    apiKey:
      domains:
        - api.mistral.ai
        - chat.mistral.ai
        - console.mistral.ai
```

Cette autorisation est persistante et s’applique au service Mistral pour les
kits qui demandent ces domaines ; ce n’est pas une autorisation limitée à un
seul run. Le proxy garde la clé hors de la sandbox.

La validation automatique a d’abord rejeté cette écriture parce que la
délégation persistante n’était pas explicitement autorisée. L’utilisateur a
ensuite répondu « Oui, autoriser ces trois domaines ». L’écriture du binding
a alors été autorisée et réalisée. Les retests 3 et 4 confirment que
l’authentification fonctionne. Le fichier contient uniquement cette
autorisation, pas la valeur du secret.

## Vérifications locales finales

`rtk npm test` : **303 tests, 0 échec** (128 pipeline, 29 runtime,
56 sandbox, 24 workspace, 66 CLI). Chaque workspace est compilé par sa
commande de test. Sortie complète : `fix-tests-final.log`.

`rtk git diff --check` : code 0.

Le contrôle de configuration dans la sandbox lit uniquement le code public
Vibe et les variables de modèle du scénario ; il n’effectue aucun appel API
et ne lit aucune valeur de credential. Preuve : `model-verification.log`.

## Améliorations restantes

Le kit et l’image utilisent actuellement `latest` : les épingler à une version
ou un digest améliorerait la reproductibilité. La sortie JSON de Vibe est
encore publiée telle quelle dans l’artefact déclaré Markdown ; extraire la
réponse finale rendrait cet artefact plus lisible. Le résumé d’erreur et les
consignes contradictoires de commit signalés par l’audit initial restent à
améliorer. Le smoke réel de rejet passe : code du smoke 0, statut `passed`,
code de la CLI 2 attendu pour `rejected`, dépôt hôte inchangé et nettoyage
vérifié. Preuve : `fix-smoke-reject.log`.

Référence du kit utilisé : [Docker Vibe kit](https://hub.docker.com/r/sbx/vibe-kit).
