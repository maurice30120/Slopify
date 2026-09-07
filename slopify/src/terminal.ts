import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { Readable, Writable } from 'node:stream';
import { highlightMarkdown } from 'markstream-cli';

export interface CliTerminal {
  write(message: string, format?: 'markdown'): void;
  writeError(message: string): void;
  /** Écrit sur stderr sans ajouter de saut de ligne, pour le streaming de chunks. */
  writeErrorRaw(message: string): void;
  ask(question: string): Promise<string>;
  confirm(title: string, message?: string): Promise<boolean>;
  select(title: string, options: string[]): Promise<string | undefined>;
  close(): void;
  /** True si le flux d'erreur est un TTY capable d'interpréter les séquences ANSI. */
  readonly supportsAnsi: boolean;
  /** Largeur en colonnes du flux d'erreur, pour le wrapping Markdown. */
  readonly columns: number;
}

export class NodeCliTerminal implements CliTerminal {
  private readonly inputClosed = new AbortController();
  private readonly abortInput = () => this.inputClosed.abort(new Error('Terminal input closed.'));
  private closed = false;
  readonly supportsAnsi: boolean;
  readonly columns: number;

  constructor(
    private readonly inputStream: Readable = input,
    private readonly outputStream: Writable = output,
    private readonly errorStream: Writable = process.stderr,
  ) {
    inputStream.once('end', this.abortInput);
    inputStream.once('close', this.abortInput);
    this.supportsAnsi = (this.errorStream as { isTTY?: boolean }).isTTY === true;
    this.columns = (this.errorStream as { columns?: number }).columns ?? 80;
  }

  write(message: string, format?: 'markdown'): void {
    const stream = this.outputStream as Writable & { isTTY?: boolean; columns?: number };
    const rendered = format === 'markdown' && stream.isTTY === true
      ? highlightMarkdown(message, { render: { color: true, width: stream.columns ?? 80 } })
      : message;
    this.outputStream.write(`${rendered}\n`);
  }

  writeError(message: string): void {
    this.errorStream.write(`${message}\n`);
  }

  writeErrorRaw(message: string): void {
    this.errorStream.write(message);
  }

  async ask(question: string): Promise<string> {
    return (await this.question(`${question} `)).trim();
  }

  async confirm(title: string, message?: string): Promise<boolean> {
    const label = message ? `${title}\n${message}\nConfirm? [y/N]` : `${title} [y/N]`;
    const answer = (await this.question(`${label} `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes' || answer === 'o' || answer === 'oui';
  }

  async select(title: string, options: string[]): Promise<string | undefined> {
    if (options.length === 0) {
      return undefined;
    }
    this.write(title);
    options.forEach((option, index) => this.write(`  ${index + 1}. ${option}`));
    const answer = await this.ask(`Choose [1-${options.length}] or press Enter to cancel:`);
    if (!answer) {
      return undefined;
    }
    const index = Number.parseInt(answer, 10) - 1;
    return Number.isInteger(index) && index >= 0 && index < options.length
      ? options[index]
      : undefined;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.inputStream.off('end', this.abortInput);
    this.inputStream.off('close', this.abortInput);
    this.inputClosed.abort(new Error('Terminal input closed.'));
    if (this.inputStream !== input) {
      this.inputStream.destroy();
    }
  }

  private async question(query: string): Promise<string> {
    // Une interface readline fraîche est créée à chaque prompt. Un agent TUI
    // (ex. OpenCode en mode ACP) peut ouvrir /dev/tty et modifier le mode du
    // terminal (raw, echo, line discipline) ; tué par SIGTERM, il laisse le
    // terminal dans un état inattendu qu'une interface readline créée avant
    // son exécution ne récupère pas.
    //
    // Repartir d'une interface neuve ne suffit pas : createInterface appelle
    // setRawMode(true) qui réapplique les flags raw, mais ne restaure pas les
    // flags termios individuels (ECHO, ICANON, ISIG, IEXTEN, etc.) modifiés
    // par l'agent. Un setRawMode(false) préalable restaure l'état termios
    // original capturé à la création de process.stdin, puis createInterface
    // ré-applique un raw mode propre à partir d'un état connu.
    const ttyStream = this.inputStream as Readable & { setRawMode?(mode: boolean): void };
    if (typeof ttyStream.setRawMode === 'function') {
      try { ttyStream.setRawMode(false); } catch { /* not a TTY or already closed */ }
    }
    const rl = createInterface({ input: this.inputStream, output: this.errorStream });
    try {
      return await rl.question(query, { signal: this.inputClosed.signal });
    } catch (error: unknown) {
      if (this.inputClosed.signal.aborted) {
        throw new Error('Terminal input closed.');
      }
      throw error;
    } finally {
      rl.close();
    }
  }
}
