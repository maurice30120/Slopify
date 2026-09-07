import { getDefaultMarkdown, highlightMarkdown } from 'markstream-cli';

/**
 * Tampon de rendu Markdown par blocs pour le streaming en direct.
 *
 * Contrairement au renderer à déplacements de curseur (patches ANSI avec
 * save/restore/erase), chaque bloc terminé est rendu une seule fois via
 * `highlightMarkdown` puis écrit sans être réécrit. Le dernier bloc de haut
 * niveau est conservé tant qu'il peut encore grandir (liste, tableau, bloc de
 * code, paragraphe en cours) : il n'est émis qu'à l'arrivée du bloc suivant
 * ou au vidage final. Les couleurs ANSI restent autorisées ; aucune commande
 * de déplacement ou d'effacement du curseur n'est produite.
 *
 * Les limites de blocs sont identifiées avec le parseur Markdown de la
 * dépendance existante (`markdown-it` via `markstream-cli`) : on repère la
 * ligne de départ du dernier bloc de haut niveau et l'on n'émet rien à
 * partir de cette ligne.
 */
export interface MarkdownBlockStreamOptions {
  /** Largeur en colonnes passée au rendu (wrapping). */
  width: number;
  /** Active les couleurs ANSI dans le rendu. */
  color?: boolean;
}

export class MarkdownBlockStream {
  private readonly md: ReturnType<typeof getDefaultMarkdown>;
  private readonly width: number;
  private readonly color: boolean;
  private buffer = '';
  private flushedOffset = 0;

  constructor(options: MarkdownBlockStreamOptions) {
    this.md = getDefaultMarkdown();
    this.width = options.width;
    this.color = options.color ?? true;
  }

  /**
   * Ajoute un chunk et renvoie le rendu ANSI des blocs nouvellement terminés
   * (chaîne vide si rien de nouveau n'est prêt à être affiché).
   */
  push(chunk: string): string {
    if (!chunk) return '';
    this.buffer += chunk;
    return this.emitUpto(this.lastTopBlockStartOffset());
  }

  /**
   * Rend et renvoie le contenu restant (fin de phase, fin de nœud, sortie
   * d'erreur). Le tampon est ensuite vidé.
   */
  flush(): string {
    const rendered = this.emitUpto(this.buffer.length);
    this.buffer = '';
    this.flushedOffset = 0;
    return rendered;
  }

  /** Réinitialise le tampon sans rien émettre. */
  reset(): void {
    this.buffer = '';
    this.flushedOffset = 0;
  }

  private emitUpto(boundary: number): string {
    if (boundary <= this.flushedOffset) return '';
    const slice = this.buffer.slice(this.flushedOffset, boundary);
    this.flushedOffset = boundary;
    return this.render(slice);
  }

  private render(markdown: string): string {
    if (!markdown.trim()) return '';
    return highlightMarkdown(markdown, {
      render: { color: this.color, streaming: true, width: this.width },
    });
  }

  /**
   * Décalage (en caractères) du début du dernier bloc de haut niveau. Tout ce
   * qui précède est « stabilisé » et peut être émis ; le dernier bloc peut
   * encore grandir, on le retient.
   */
  private lastTopBlockStartOffset(): number {
    const tokens = this.md.parse(this.buffer, {}) as Array<{
      map?: [number, number] | null;
      level?: number;
      nesting?: number;
    }>;
    let startLine = -1;
    for (const token of tokens) {
      // Block-level open tokens (nesting === 1) and self-contained block
      // tokens (nesting === 0, e.g. fence/code_block) carry a `map` with their
      // source line range. `level === 0` keeps us at the document top level,
      // ignoring blocks nested inside list items or blockquotes.
      if (token.map && token.level === 0 && (token.nesting === 1 || token.nesting === 0)) {
        startLine = token.map[0];
      }
    }
    if (startLine < 0) return this.flushedOffset;
    return this.lineToOffset(startLine);
  }

  private lineToOffset(line: number): number {
    let offset = 0;
    let current = 0;
    while (current < line) {
      const next = this.buffer.indexOf('\n', offset);
      if (next < 0) return this.buffer.length;
      offset = next + 1;
      current += 1;
    }
    return offset;
  }
}
