# @acp-client/pipeline

Module npm local qui contient l'orchestration pipeline d'ACP Client.

Ce package est volontairement indépendant de VS Code. Il ne lit pas les settings,
ne parcourt pas le workspace, ne lance pas d'agent concret, ne fait pas de `git diff`
et ne connaît aucun runtime d’isolation concret. Ces responsabilités restent dans les hôtes, qui les
injectent via des callbacks.

## Ce que le package fournit

- Les types publics de pipeline v3 : `PipelineV3Definition`,
  `CompiledPipelineProgram`, événements pipeline, etc.
- La compilation et validation des définitions pipeline v3.
- L'exécution de pipeline par DAG de `nodes`, pauses d'approbation, reprise,
  annulation, parallèle, événements de statut et session updates.
- Les helpers autour de `<proposed_plan>`.
- La résolution des `instructionsFile` attachés aux nodes v3.
- Le contrat `PipelineNodePrompt` et son rendu portable en blocs ACP.

## Contrat de prompt

Un node agent conserve les couches suivantes jusqu'à la frontière ACP :

```ts
interface PipelineNodePrompt {
  skills: string[];
  instructions?: string;
  task: string;
  context: PipelineArtifact[];
}
```

Dans le YAML :

- `skills` désigne les méthodes réutilisables ;
- `instructionsFile` contient le rôle et les règles invariantes ;
- `prompt` contient la tâche et les données propres au run.

`promptFile` reste accepté comme alias de migration, mais les nouvelles définitions
doivent utiliser `instructionsFile`.

À la frontière ACP, `renderAcpPrompt` produit des blocs texte séparés :

```ts
[
  { type: 'text', text: '<skills>...</skills>' },
  { type: 'text', text: '<instructions>...</instructions>' },
  { type: 'text', text: '<task>...</task>' },
]
```

Cette représentation permet aux hôtes de prévisualiser, tracer, mesurer ou modifier
une couche sans reconstruire une chaîne concaténée.

## Ce qui reste côté hôte

Les hôtes VS Code et Pi jouent le rôle d'adapter. Ils fournissent notamment :

- la lecture de `.acp/pipelines/*.yaml` ;
- la lecture de la configuration des agents ;
- la résolution du workspace courant ;
- le runner d’agent concret ;
- la détection des capacités du transport ;
- la projection des événements vers leur UI.

## Utilisation

Dans le monorepo, le package est référencé comme workspace local :

```json
{
  "dependencies": {
    "@acp-client/pipeline": "file:root/acp-pipeline"
  }
}
```

Le package émet des événements `status`, `plan-ready` et `session-update`.
Les consommateurs doivent les projeter vers leur interface.

## Build

```bash
npm run build -w @acp-client/pipeline
```

Le build produit `dist/`, qui est consommé par les hôtes pendant leur compilation.

## Tests

Les tests sont écrits avec le runner natif Node.js (`node:test` + `node:assert/strict`).

```bash
# Lancer la suite complète (build package + compilation tests + exécution)
npm run test -w @acp-client/pipeline

# Watch mode (dev only)
npm run test:watch -w @acp-client/pipeline
```

Structure :

- `test/PipelineAgentRunner.test.ts` — rendu des couches en blocs ACP.
- `test/PipelineV3Compiler.test.ts` — compilation YAML v3, DAG, inputs et erreurs structurelles.
- `test/PipelineV3DefinitionCompiler.test.ts` — normalisation publique de `instructionsFile`.
- `test/PipelineV3Catalog.test.ts` — résolution séparée de `instructionsFile`, sécurité path, taille max et alias de migration.
- `test/PipelineRuntime.test.ts` — exécution, pauses, reprise, annulation et parallèle.
- `test/PipelineService.test.ts` — intégration service/runtime/adaptateur.
- `test/helpers.ts` — fixtures et utilitaires partagés.

Les tests importent l'**API publique compilée** (`../dist/index.js`) et non les sources.
Le script `test` s'assure toujours de `npm run build` avant de compiler et exécuter la suite.

## Roadmap

Voir la section `@acp-client/pipeline` dans [`../ROADMAP.md`](../ROADMAP.md).
