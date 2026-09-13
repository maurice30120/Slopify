# 03: Clarifier les phases et le rendu du streaming

**What to build:** Réviser les commentaires du streaming des pensées et des réponses pour rendre explicites la transition de phase, la prévention des duplications et le choix entre rendu Markdown par blocs et texte brut dans les différents flux du terminal.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Les commentaires de `reportSessionUpdate` expliquent le filtrage aux seuls événements `agent_thought_chunk` et `agent_message_chunk`, puis la détection de la phase et le streaming en mode verbose.
- [ ] Le vidage du tampon lors du passage « réfléchit » → « répond » (ou inversement) est décrit comme une séparation des phases, sans déplacement ni effacement du curseur.
- [ ] `streamedTextByNode` est décrit précisément comme une comparaison avec le dernier texte reçu pour ne rendre que le suffixe lorsque l’adaptateur renvoie du texte cumulatif ; aucune généralisation à tous les formats ACP n’est ajoutée.
- [ ] L’usage de `MarkdownBlockStream` est documenté pour un TTY compatible ANSI, avec rendu par blocs terminés et écriture append-only sans réécriture du contenu précédent.
- [ ] Les flux non-TTY et `SLOPIFY_ANSI_STREAM=0` sont documentés comme des replis vers le texte brut inchangé, sans modification du contenu streamé.
- [ ] La frontière entre affichage verbose des pensées et non-persistance de leur contenu est cohérente avec `sanitizeSessionNotification`, et seul le texte des commentaires de streaming est modifié.

