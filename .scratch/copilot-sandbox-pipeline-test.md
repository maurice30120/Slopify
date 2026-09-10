# Test pipeline Copilot Sandbox

## Objectif

Vérifier que le pipeline par défaut s’exécute exclusivement avec `Copilot Sandbox`,
produit un changement de code minimal et termine avec succès après promotion.

## Tâche minimale

Ajouter un seul commentaire de code court dans `slopify/src/args.ts`, juste au-dessus
de `DEFAULT_PIPELINE`, sans modifier le comportement ni aucun autre fichier.

## Commande de reprise

Depuis la racine du dépôt :

```bash
SLOPIFY_RESOURCES_STATE_ROOT=/private/tmp/slopify-resources-state \
node slopify/dist/src/cli.js run --yes --keep-sandboxes --verbose \
  "Ajoute un seul commentaire de code court dans slopify/src/args.ts, juste au-dessus de DEFAULT_PIPELINE. Ne modifie aucun autre fichier et ne change aucun comportement."
```

`--yes` approuve les pauses ordinaires. La promotion du Pipeline Change Set doit
être confirmée explicitement lorsque le diff est présenté.

## Prérequis

- `npm run build` terminé avec succès ;
- `sbx daemon status` indique `running` ;
- Copilot CLI authentifié (`copilot login`) ;
- `~/.copilot/config.json` contient l’état d’authentification Copilot ; Slopify
  le copie automatiquement dans chaque sandbox Copilot ;
- workspace propre avant le lancement, car les pipelines qui écrivent exigent un
  commit de base propre.

## Vérifications attendues

- les événements indiquent `plan · Copilot Sandbox`, puis les nœuds de livraison
  utilisent eux aussi `Copilot Sandbox` ;
- le preview contient uniquement le commentaire ajouté dans `slopify/src/args.ts` ;
- la décision `Promote Pipeline Change Set` est acceptée ;
- la sortie finale est `Pipeline completed` et le code retour vaut `0` ;
- `git diff` montre le commentaire promu.

## Historique de cette tentative

- La configuration Copilot-only est dans le commit `4b158a6`.
- Le premier lancement a atteint le sandbox Copilot mais a échoué sur un token
  Copilot expiré.
- Copilot a ensuite été réauthentifié avec le compte GitHub CLI actif `dhuyet`.
- Le second lancement a de nouveau atteint `Copilot Sandbox`, mais le secret
  global Docker `github` injecté dans le sandbox est resté expiré.
- Le runtime a ensuite été ajusté pour copier `~/.copilot/config.json` avant
  l’appel Copilot ; la suite sandbox vérifie ce transfert.

## Blocage actuel

Si la copie de `config.json` ne suffit pas parce que `GH_TOKEN` est prioritaire,
le fallback est de remplacer le secret global Docker Sandbox par le token `gh`
actif :

```bash
sbx secret set github --command 'gh auth token'
```

Cette commande modifie le credential global utilisé par tous les sandboxes. Ne
la lancer qu’après validation explicite de ce périmètre, puis reprendre avec la
commande ci-dessus.
