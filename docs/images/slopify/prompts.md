# Prompts des infographies

## Corrections finales de la planche 1

Outil : imagegen intégré ; cibles successives : versions harmonisées de la planche 1.

### Retour des rapports vers la CLI

```text
Use case: infographic-diagram, correction locale d’une infographie. La référence fournie est la CIBLE. Préserver STRICTEMENT toute sa mise en page, tous les textes, les couleurs, les titres, le badge 01 / 03, le format, les marges, la lisibilité et le plafond 10. Corriger UNIQUEMENT les flèches et la petite légende de retour comme décrit :

1. Sous CHAQUE carte AGENT PRINCIPAL, les DEUX traits de revue doivent partir de la carte de l’agent principal turquoise, JAMAIS de la boîte de skills à droite. Un trait descend vers Standards ; un autre part du bas de la même carte principale, tourne horizontalement SOUS la boîte skills puis descend vers Spec. Les deux traits ont des pointes dans les DEUX sens : vers les reviewers pour la délégation, vers le principal pour les constats. Légende commune « délégation / constats ». Ne rien connecter aux skills. Pour éviter toute ambiguïté, décaler les points de départ vers l’intérieur de la largeur de la carte principale.

2. Le retour des sandboxes vers la CLI est actuellement faux : des pointes montent vers les sandboxes et une pointe « checkpoint Git » descend depuis la CLI. EFFACER entièrement ces traits sous les sandboxes et la verticale au milieu entre elles.
Dessiner un SEUL nouveau réseau de retour très simple, entièrement bleu :
- depuis le BAS du cadre de sandbox A, un trait SANS pointe descend vers un rail horizontal sous les deux cadres ;
- depuis le BAS du cadre de sandbox B, un trait SANS pointe descend vers le même rail ;
- le milieu de ce rail remonte verticalement dans l’espace blanc ENTRE les deux cadres, jusqu’au BORD INFÉRIEUR de la grande boîte CLI ; la SEULE pointe de tout ce réseau de retour est dirigée VERS LE HAUT, touche la boîte CLI.
- étiqueter chaque branche horizontale « rapport + verdict ».
Aucune flèche de ce réseau ne doit pointer vers un cadre sandbox. Ne pas mettre de pointe vers le bas sur le segment central.

3. Remplacer la légende « checkpoint Git » près du rail par un petit texte sans flèche « CLI : crée le checkpoint Git », à un emplacement disponible au bas du panneau CLI ou au-dessus de la bande sur l’agrégation. La création du checkpoint est une opération de la CLI, pas un envoi depuis la CLI vers l’agent.

Tout le reste doit rester identique, notamment les deux flèches CLI → sandbox « 1 tâche → 1 sandbox par tentative », les échanges utilisateur/hôte, les instructions, le stockage, la note 10 et le bas de page.
```

### Relation explicite entre principal et reviewers

```text
Correction locale finale de l'infographie jointe. Conserver exactement le titre, le badge 01 / 03, les textes, le plafond 10, la mise en page, les couleurs, la taille et toutes les flèches BLEUES, ORANGES et VIOLETTES, notamment le retour rapport + verdict vers la CLI qui est maintenant correct.
La SEULE modification concerne les flèches VERTES à l'intérieur des deux sandboxes :
SUPPRIMER TOUTES LES FLÈCHES ET TOUS LES TRAITS VERTS entre les cartes agent principal / skills et les cartes SOUS-AGENT Standards / Spec. N'en redessiner AUCUN. Ni flèche, ni trait vert, ni chevron. Garder les deux cartes de sous-agents verts en place.
Dans l'espace libéré entre la rangée agent principal / skills et la rangée des deux sous-agents, remplacer les petites légendes « délégation / constats » par UNE ligne de texte bleu nuit pour chaque sandbox :
« Agent principal : délègue les revues et reçoit les constats »
Ce texte doit être centré au-dessus des deux cartes reviewers, tenir sur une ligne ou deux courtes lignes avec une taille lisible, sans chevaucher aucune carte. Les reviewers restent groupés dans le cadre de leur tâche ; la phrase explique leur relation au principal sans connecteur trompeur.
Ne toucher à aucun autre élément. Le résultat final doit contenir ZÉRO trait de connexion vert : seules les surfaces des cartes reviewers et leurs icônes restent vertes.
```


Outil : imagegen intégré, édition des trois premières planches conservées dans les pièces de travail. Chaque image utilise sa version précédente comme cible ; les planches 2 et 3 utilisent aussi la première comme référence de style. Fond opaque, format paysage 3:2.

## 1. 01-roles-et-delegation.png

```text
Use case: infographic-diagram / image editing. Harmonisation LÉGÈRE d'une série de trois infographies de documentation logicielle en français. L'utilisateur aime les images actuelles : préserver leur contenu détaillé, la disposition principale et leur esprit. Ne pas inventer de comportement. Image 1 fournie = CIBLE à modifier. Si une image 2 est fournie, c'est une RÉFÉRENCE DE STYLE UNIQUEMENT, ne pas recopier son contenu.

CHARTE IDENTIQUE POUR LES TROIS PLANCHES :
- format paysage 3:2, même dimension de sortie que les références, haute netteté pour lecture dans un README GitHub ;
- fond blanc uniforme ; titres et texte bleu nuit ; panneaux très légèrement teintés avec bordures fines et coins arrondis constants ; aucune ombre lourde ;
- une seule famille sans serif. Grand titre aligné à gauche en haut, une ligne de sous-titre dessous ; même taille apparente de titre pour la série, garder une marge pour un badge discret en haut à droite « 01 / 03 », « 02 / 03 » ou « 03 / 03 » ;
- palette stable : utilisateur ambre, agent hôte violet, CLI et commandes bleus, agents principaux turquoise, reviewers verts ; rouge pour échec / limite, ambre pour avertissement ;
- mêmes icônes simples, même épaisseur de trait et même traitement visuel sur toutes les planches ;
- pied de page de hauteur régulière, texte source discret puis « Code inspecté · 08/10/2026 ». Retirer les anciens HEAD d6504a4b0 et anciennes étiquettes de planche. Le code présent dans l'espace de travail contient maintenant WAVE_SIZE = 10.
- Ne jamais remplacer « 5 » par « 10 » dans une numérotation d'étapes. Seul le plafond de parallélisme doit changer : 10 TÂCHES/AGENTS PRINCIPAUX maximum par vague. Le nombre de sous-agents de revue n'est pas compris dans ce plafond.
- Respecter les accents, les identifiants et la lisibilité. Préserver toutes les informations fonctionnelles sauf modifications demandées ci-dessous.
Planche « Slopify — Qui parle à qui ? », badge « 01 / 03 ». Remplacer « 5 tâches prêtes maximum » par « 10 tâches prêtes maximum ». Remplacer le bandeau du bas par « 10 = plafond de tâches par vague, pas de sous-agents. La CLI ne crée pas un sandbox Docker distinct pour chaque reviewer. » Garder deux sandboxes dessinées comme EXEMPLE, ajouter « Exemple : deux tâches parmi dix possibles ». Harmoniser les deux cadres sandbox et cartes AGENT PRINCIPAL en turquoise pâle (l'hôte seul reste violet), les sous-agents en vert. Corriger les deux flèches de délégation pour qu'elles partent bien du principal, pas des skills. Corriger la lecture du retour : « rapport + verdict » remonte vers la CLI, laquelle produit le checkpoint Git. La phrase « Le principal agrège les revues, corrige et rend son verdict » doit rester près des sandboxes, sans prétendre que le code garantit la revue. Garder les échanges hôte, stdout / stderr, stockage et note acp-sandbox.
```

## 2. 02-cycle-et-vagues.png

```text
Use case: infographic-diagram / image editing. Harmonisation LÉGÈRE d'une série de trois infographies de documentation logicielle en français. L'utilisateur aime les images actuelles : préserver leur contenu détaillé, la disposition principale et leur esprit. Ne pas inventer de comportement. Image 1 fournie = CIBLE à modifier. Si une image 2 est fournie, c'est une RÉFÉRENCE DE STYLE UNIQUEMENT, ne pas recopier son contenu.

CHARTE IDENTIQUE POUR LES TROIS PLANCHES :
- format paysage 3:2, même dimension de sortie que les références, haute netteté pour lecture dans un README GitHub ;
- fond blanc uniforme ; titres et texte bleu nuit ; panneaux très légèrement teintés avec bordures fines et coins arrondis constants ; aucune ombre lourde ;
- une seule famille sans serif. Grand titre aligné à gauche en haut, une ligne de sous-titre dessous ; même taille apparente de titre pour la série, garder une marge pour un badge discret en haut à droite « 01 / 03 », « 02 / 03 » ou « 03 / 03 » ;
- palette stable : utilisateur ambre, agent hôte violet, CLI et commandes bleus, agents principaux turquoise, reviewers verts ; rouge pour échec / limite, ambre pour avertissement ;
- mêmes icônes simples, même épaisseur de trait et même traitement visuel sur toutes les planches ;
- pied de page de hauteur régulière, texte source discret puis « Code inspecté · 08/10/2026 ». Retirer les anciens HEAD d6504a4b0 et anciennes étiquettes de planche. Le code présent dans l'espace de travail contient maintenant WAVE_SIZE = 10.
- Ne jamais remplacer « 5 » par « 10 » dans une numérotation d'étapes. Seul le plafond de parallélisme doit changer : 10 TÂCHES/AGENTS PRINCIPAUX maximum par vague. Le nombre de sous-agents de revue n'est pas compris dans ce plafond.
- Respecter les accents, les identifiants et la lisibilité. Préserver toutes les informations fonctionnelles sauf modifications demandées ci-dessous.
Planche « Slopify — Du lot au résultat intégré », badge « 02 / 03 ». Remplacer « les 5 premières tâches prêtes » par « les 10 premières tâches prêtes ». Garder le petit exemple A/B puis C puis R (il illustre les dépendances, pas le plafond) et toutes ses barrières d'intégration. En conservant le rail d'étapes et le diagramme de vagues, harmoniser à la charte : cartes de tâches turquoise, commandes et intégration CLI bleues ; violet réservé aux éléments hôte si présents. En bas le marqueur doit rester EXACTEMENT SLOPIFY_RESULT={"status":"succeeded"}. Conserver les différences completed / succeeded, la revue finale facultative pour la CLI, la branche locale, la conservation des preuves et les limites du verdict. Petit texte sous le plafond : « jusqu’à 10 agents principaux en parallèle ; les sous-agents ne sont pas comptés ».
```

## 3. 03-suivi-reprises-conflits.png

```text
Use case: infographic-diagram / image editing. Harmonisation LÉGÈRE d'une série de trois infographies de documentation logicielle en français. L'utilisateur aime les images actuelles : préserver leur contenu détaillé, la disposition principale et leur esprit. Ne pas inventer de comportement. Image 1 fournie = CIBLE à modifier. Si une image 2 est fournie, c'est une RÉFÉRENCE DE STYLE UNIQUEMENT, ne pas recopier son contenu.

CHARTE IDENTIQUE POUR LES TROIS PLANCHES :
- format paysage 3:2, même dimension de sortie que les références, haute netteté pour lecture dans un README GitHub ;
- fond blanc uniforme ; titres et texte bleu nuit ; panneaux très légèrement teintés avec bordures fines et coins arrondis constants ; aucune ombre lourde ;
- une seule famille sans serif. Grand titre aligné à gauche en haut, une ligne de sous-titre dessous ; même taille apparente de titre pour la série, garder une marge pour un badge discret en haut à droite « 01 / 03 », « 02 / 03 » ou « 03 / 03 » ;
- palette stable : utilisateur ambre, agent hôte violet, CLI et commandes bleus, agents principaux turquoise, reviewers verts ; rouge pour échec / limite, ambre pour avertissement ;
- mêmes icônes simples, même épaisseur de trait et même traitement visuel sur toutes les planches ;
- pied de page de hauteur régulière, texte source discret puis « Code inspecté · 08/10/2026 ». Retirer les anciens HEAD d6504a4b0 et anciennes étiquettes de planche. Le code présent dans l'espace de travail contient maintenant WAVE_SIZE = 10.
- Ne jamais remplacer « 5 » par « 10 » dans une numérotation d'étapes. Seul le plafond de parallélisme doit changer : 10 TÂCHES/AGENTS PRINCIPAUX maximum par vague. Le nombre de sous-agents de revue n'est pas compris dans ce plafond.
- Respecter les accents, les identifiants et la lisibilité. Préserver toutes les informations fonctionnelles sauf modifications demandées ci-dessous.
Planche « Slopify — Suivre, reprendre, résoudre », badge « 03 / 03 ». Garder les trois colonnes et tous les faits déjà présents. Harmoniser les en-têtes de colonnes avec fond très clair et texte bleu nuit, éviter les gros en-têtes pleins ; observer et commandes en bleu, erreurs en rouge/ambre, preuves en turquoise, aucune couleur arbitraire. Dans la colonne conflit : garder « slopify tasks conflict <runId> » comme consultation, puis AJOUTER une ligne de commande distincte avant les branches de stratégies « slopify tasks resolve-conflict <runId> --strategy … ». Cette deuxième commande est celle qui choisit use-current / use-incoming / manual. Réorganiser légèrement pour que tout reste très lisible. Conserver les nuances use-current → tâche failed ; use-incoming → retente intégration, conflit possible ; manual → clone Git LOCAL, pas Docker ; validation ascendance, pas tests. Ajouter discrètement dans la colonne reprise « Plafond d’exécution : 10 tâches ; dépendances déjà succeeded ». Préserver arbres du store, nextActions informatives, running n'est pas présence, codes 0 / 2 / 1 et absence de garantie automatique de revue. Les commandes longues peuvent revenir sur deux lignes, sans couper les mots ou les identifiants.
```
