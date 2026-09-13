# 02: Clarifier la journalisation et l’assainissement

**What to build:** Réviser les commentaires qui décrivent l’association des événements ACP aux runs et aux nœuds, les journaux de diagnostic et la frontière de confidentialité des notifications, afin que les évolutions de l’observabilité conservent le contexte global sans persister le raisonnement de l’agent.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Le traitement des événements explique la différence entre journal de run et journal de nœud, ainsi que le rattachement des événements à `eventNode` ou au run lorsqu’aucun nœud agent ne correspond.
- [ ] Le rôle de `activeAgentNodes` est explicité : rattachement des logs d’un agent au nœud actif, puis détachement à la terminaison du nœud.
- [ ] Les commentaires de `PipelineRunLog` précisent la persistance JSONL, le nettoyage des journaux et la conservation du diagnostic asynchrone de fin de processus.
- [ ] Le message `Agent "…" exited (code=…, signal=SIGTERM)` est décrit comme potentiellement normal lors d’une pause : conservé dans les logs, mais filtré de l’affichage terminal pour ne pas évoquer un échec.
- [ ] `sanitizeSessionNotification` indique que `agent_message_chunk` reste journalisé, tandis que `agent_thought_chunk` ne conserve que son type et sa taille en octets ; son affichage verbose suit un chemin distinct.
- [ ] Les noms techniques et événements ACP restent inchangés, et seul le texte des commentaires de la zone de journalisation est modifié.

