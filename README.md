# Slopify

Slopify est une CLI autonome pour exécuter des pipelines ACP v3 depuis un terminal.
Ce dépôt conserve une structure monorepo minimale avec uniquement la CLI et ses
quatre bibliothèques d'exécution.

## Prérequis

- Node.js 22.19 ou plus récent
- npm

## Installation et utilisation

```bash
npm install
npm run build
npm link -w slopify
slopify --help
```

Sans installation globale :

```bash
npm run slopify -- list
npm run slopify -- run <pipeline> "<prompt>"
```

## Workspaces

- `slopify` : interface en ligne de commande ;
- `acp-workspace` : chargement de la configuration du workspace ;
- `acp-pipeline` : compilation et exécution des pipelines ;
- `acp-runtime` : hôtes d'agents ACP ;
- `acp-sandcastle` : intégration Sandcastle.

Lancer toute la suite avec `npm test`.
