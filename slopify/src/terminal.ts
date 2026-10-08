import { createInterface, type Interface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { Readable, Writable } from 'node:stream';

/** Contrat fonctionnel de CliTerminal dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface CliTerminal {
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  write(message: string): void;
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  writeError(message: string): void;
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  ask(question: string): Promise<string>;
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  confirm(title: string, message?: string): Promise<boolean>;
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  select(title: string, options: string[]): Promise<string | undefined>;
/** Termine cette étape du cycle de vie et libère les ressources qui lui appartiennent. */
  close(): void;
}

/** Composant NodeCliTerminal qui coordonne une étape observable du cycle de vie du pipeline et en préserve les invariants. */
export class NodeCliTerminal implements CliTerminal {
  private readonly readline: Interface;
  private readonly inputClosed = new AbortController();
  private readonly abortInput = () => this.inputClosed.abort(new Error('Terminal input closed.'));
  private closed = false;

/** Initialise ce composant pour le cycle de vie du pipeline concerné. */
  constructor(
    private readonly inputStream: Readable = input,
    private readonly outputStream: Writable = output,
    private readonly errorStream: Writable = process.stderr,
  ) {
    this.readline = createInterface({ input: inputStream, output: outputStream });
    inputStream.once('end', this.abortInput);
    inputStream.once('close', this.abortInput);
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  write(message: string): void {
    this.outputStream.write(`${message}\n`);
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  writeError(message: string): void {
    this.errorStream.write(`${message}\n`);
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async ask(question: string): Promise<string> {
    return (await this.question(`${question} `)).trim();
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async confirm(title: string, message?: string): Promise<boolean> {
    const label = message ? `${title}\n${message}\nConfirm? [y/N]` : `${title} [y/N]`;
    const answer = (await this.question(`${label} `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes' || answer === 'o' || answer === 'oui';
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
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

/** Termine cette étape du cycle de vie et libère les ressources qui lui appartiennent. */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.inputStream.off('end', this.abortInput);
    this.inputStream.off('close', this.abortInput);
    this.readline.close();
    if (this.inputStream !== input) {
      this.inputStream.destroy();
    }
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  private async question(query: string): Promise<string> {
    try {
      return await this.readline.question(query, { signal: this.inputClosed.signal });
    } catch (error: unknown) {
      if (this.inputClosed.signal.aborted) {
        throw new Error('Terminal input closed.');
      }
      throw error;
    }
  }
}
