# Rétrospective — image de l’étape 2 du tour CodeTour

Session du 19 octobre 2026 : `01a1550d-a2aa-7920-b526-330a1caa9ac6`. Périmètre : génération puis correction du sketchnote dans le tour d’architecture V2. Cette rétrospective propose des améliorations de l’environnement ; elle ne modifie pas le serveur MCP CodeTour.

## Incident et preuves

Le tour initial associait deux choses à l’étape 2 : une ancre `file` vers le PNG et une image encodée en base64 dans `description`. Le MCP a accepté cette proposition après correction de motifs d’autres étapes. L’agent a ensuite vérifié l’existence des fichiers et l’identité des octets de l’image, puis livré sans ouvrir le tour dans son lecteur.

L’utilisateur a signalé l’étape défectueuse. La correction a retiré l’ancre vers le PNG et remplacé le base64 par une référence Markdown locale :

```markdown
![Architecture V2](./docs/images/slopify/04-v2-architecture-actuelle-2026-10-19.png)
```

La capture du lecteur VS Code après correction montre le sketchnote dans le commentaire de l’étape 2. Le tour est passé de **2 767 399 à 31 795 octets**, soit un fichier environ **87 fois plus petit**.

Sources primaires :

- [Journal de la session](/Users/dhuyet/.codex/sessions/2026/10/19/rollout-2026-10-19T18-45-19-01a1550d-a2aa-7920-b526-330a1caa9ac6.jsonl). Appels pertinents : création `call_c4087f0c2f664f429a31ff7795c05246`, contrôle des octets `call_7481d62877f84b8285bdd8ab963761fa`, correction `call_414c0ceb99b9427ea2ad79d057476f1e`, capture visuelle `call_b04d1a1bb6a8400c94b989287dae45e2`.
- [Tour corrigé](../../../.tours/slopify-v2-architecture-actuelle.tour), étape 2 sans `file`, `line` ni `pattern`.
- [Guide CodeTour, File References](/Users/dhuyet/Documents/POC/codetour/docs/user-guide.md:95), qui documente déjà `![Image](./icon.png)`.
- [Validation des ancres](/Users/dhuyet/Documents/POC/codetour/packages/mcp-server/src/validation.ts:430) : un fichier existant est lu en UTF-8 sans garde explicite contre une ancre binaire.
- [Ouverture d’une ancre par le lecteur](/Users/dhuyet/Documents/POC/codetour/src/player/index.ts:576) : ce chemin utilise `window.showTextDocument`.

L’ancre binaire est incompatible avec ce chemin de navigation textuel. La correction a changé simultanément l’ancre et la représentation de l’image : elle ne démontre pas que le base64 était la cause unique du défaut. Le base64 reste notamment utilisé par CodeTour pour transporter ses diagrammes Mermaid rendus.

## Améliorations proposées, par priorité

### 1. Haute — détecter une ancre binaire avant de persister le tour

**Catégorie : contrôles automatisés.** La validation MCP a donné un résultat positif sur une proposition que le lecteur ne pouvait pas traiter comme du code. Le contrôle d’existence d’un fichier et sa lecture UTF-8 ne suffisent pas à établir qu’il est ancrable dans un éditeur texte.

Ajouter une garde déterministe des ancres binaires dans la validation commune aux deux outils. Le diagnostic doit indiquer le champ concerné et proposer la référence Markdown locale dans une étape de contenu. Garder les fichiers textuels, dont les sources SVG, utilisables comme code lorsqu’ils sont réellement destinés à être lus ainsi.

Critères : une proposition avec `file: "sketch.png"` est refusée en dry-run et à la création, sans écraser le tour précédent ; une étape sans ancre contenant `![Schéma](./sketch.png)` est acceptée. Couvrir ces cas dans les tests d’intégration MCP existants.

### 2. Haute — distinguer validation structurelle et preuve d’affichage

**Catégorie : contrôles automatisés et critère de fin.** La première livraison prouvait la présence de l’image et la validité du tour, pas son affichage. La preuve utile n’est arrivée qu’après le signalement utilisateur.

Compléter les tests du lecteur avec une étape de contenu illustrée par un PNG local : résolution depuis la racine du workspace, rendu du contenu et maintien de la navigation vers l’étape suivante. Distinguer les assertions du lecteur simulé de la vérification réelle dans VS Code ; une balise `img` produite ne prouve pas à elle seule que les pixels ont chargé.

Pour une livraison avec nouveau média, le critère de fin est : ouvrir l’étape concernée dans le lecteur utilisé et constater le média visible. La validation MCP reste une vérification préalable.

La CI existe déjà : [test.yml](/Users/dhuyet/Documents/POC/codetour/.github/workflows/test.yml) lance `npm run test` sur trois OS lorsque le dépôt est public. Cette commande inclut les tests du lecteur, du renderer et du MCP. Le défaut est une couverture manquante de ce cas, pas une absence générale de garde-fous. Aucun passage de cette suite n’est revendiqué pendant la rétrospective.

### 3. Moyenne — rendre le format des images visible au moment de l’appel MCP

**Catégorie : navigation et économie d’outils.** Le bon format était accessible dans le guide utilisateur. L’agent a exploré le renderer et supposé une solution en base64 avant de consulter cette référence ciblée.

Ajouter à la documentation partagée des descriptions d’outils, dans [server.ts](/Users/dhuyet/Documents/POC/codetour/packages/mcp-server/src/server.ts:72), une indication courte : « Images locales : `![Schéma](./docs/schema.png)`, chemin depuis la racine du workspace. Une étape purement illustrée n’a pas d’ancre de code. » Pointer vers la section File References pour les détails.

Cela place le renseignement au point d’usage, sans ajouter une règle globale à `AGENTS.md` ni recopier le guide dans un nouveau skill. Le PNG reste un fichier du dépôt ; la description du tour garde une référence courte. Un avertissement ciblé sur une image auteur encodée en base64 pourrait conseiller ce format, sans interdire le transport base64 des diagrammes générés par le lecteur.

## Bilan

La responsabilité initiale est celle de l’agent : mauvaise distinction entre contenu et ancre, puis livraison sans vérifier le lecteur. L’environnement peut empêcher la répétition avec une garde sur les ancres binaires, un test au niveau du lecteur et un exemple d’image locale dans l’aide MCP.

L’information et l’accès à VS Code existaient déjà. Aucun besoin supplémentaire d’accès, de reviewer ou de longues consignes globales n’est établi par cet incident.
