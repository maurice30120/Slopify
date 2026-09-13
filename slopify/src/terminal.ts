import { createInterface, type Interface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { Readable, Writable } from 'node:stream';

export interface CliTerminal {
  progress?(key: string, message: string): void;
  clearProgress?(): void;
  write(message: string): void;
  writeError(message: string): void;
  ask(question: string): Promise<string>;
  confirm(title: string, message?: string): Promise<boolean>;
  select(title: string, options: string[]): Promise<string | undefined>;
  close(): void;
}

export class NodeCliTerminal implements CliTerminal {
  private readonly progressRows = new Map<string, string>();
  private renderedRows = 0;

  progress(key: string, message: string): void {
    const text = `[${key}] ${message}`.replace(/[\x00-\x1f\x7f]/g, ' ');
    if (!(this.errorStream as NodeJS.WriteStream).isTTY) { this.writeError(text); return; }
    this.eraseProgress();
    this.progressRows.set(key, text);
    this.drawProgress();
  }
  clearProgress(): void { this.eraseProgress(); this.progressRows.clear(); }
  private eraseProgress(): void {
    if (this.renderedRows) this.errorStream.write(`\x1b[${this.renderedRows}A\r\x1b[J`);
    this.renderedRows = 0;
  }
  private drawProgress(): void {
    const width = (this.errorStream as NodeJS.WriteStream).columns || 80;
    for (const text of this.progressRows.values()) this.errorStream.write(`${text.slice(0, Math.max(1, Math.floor((width - 1) / 2)))}\n`);
    this.renderedRows = this.progressRows.size;
  }
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
    this.clearProgress();
    this.outputStream.write(`${message}\n`);
  }

  writeError(message: string): void {
    this.clearProgress();
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
    this.clearProgress();
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
    this.clearProgress();
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
