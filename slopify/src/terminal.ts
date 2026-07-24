import { createInterface, type Interface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { Readable, Writable } from 'node:stream';

export interface CliTerminal {
  write(message: string): void;
  writeError(message: string): void;
  ask(question: string): Promise<string>;
  confirm(title: string, message?: string): Promise<boolean>;
  select(title: string, options: string[]): Promise<string | undefined>;
  close(): void;
}

export class NodeCliTerminal implements CliTerminal {
  private readonly readline: Interface;
  private readonly inputClosed = new AbortController();
  private readonly abortInput = () => this.inputClosed.abort(new Error('Terminal input closed.'));
  private closed = false;

  constructor(
    private readonly inputStream: Readable = input,
    private readonly outputStream: Writable = output,
    private readonly errorStream: Writable = process.stderr,
  ) {
    this.readline = createInterface({ input: inputStream, output: outputStream });
    inputStream.once('end', this.abortInput);
    inputStream.once('close', this.abortInput);
  }

  write(message: string): void {
    this.outputStream.write(`${message}\n`);
  }

  writeError(message: string): void {
    this.errorStream.write(`${message}\n`);
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
    this.readline.close();
    if (this.inputStream !== input) {
      this.inputStream.destroy();
    }
  }

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
