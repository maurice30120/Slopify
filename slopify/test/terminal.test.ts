import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import { NodeCliTerminal } from '../src/terminal.js';

class MemoryWritable extends Writable {
  readonly chunks: string[] = [];

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(String(chunk));
    callback();
  }
}

test('cancels pending questions when stdin closes', async () => {
  const input = new PassThrough();
  const output = new MemoryWritable();
  const errors = new MemoryWritable();
  const terminal = new NodeCliTerminal(input, output, errors);

  const answer = terminal.ask('Answer [/done to finish]:');
  input.end();

  await assert.rejects(answer, /Terminal input closed/);
  assert.ok(output.chunks.join('').startsWith('Answer [/done to finish]: '));

  terminal.close();
});

test('ask returns user input with whitespace trimmed', async () => {
  const input = new PassThrough();
  const output = new MemoryWritable();
  const errors = new MemoryWritable();
  const terminal = new NodeCliTerminal(input, output, errors);

  const answerPromise = terminal.ask('Question:');
  input.write('  hello world  \n');

  const answer = await answerPromise;
  assert.equal(answer, 'hello world');
  assert.ok(output.chunks.join('').startsWith('Question: '));

  terminal.close();
});

test('confirm with y returns true', async () => {
  const input = new PassThrough();
  const output = new MemoryWritable();
  const errors = new MemoryWritable();
  const terminal = new NodeCliTerminal(input, output, errors);

  const resultPromise = terminal.confirm('Confirm?');
  input.write('y\n');

  const result = await resultPromise;
  assert.equal(result, true);
  assert.ok(output.chunks.join('').includes('Confirm? [y/N]'));

  terminal.close();
});

test('confirm with n returns false', async () => {
  const input = new PassThrough();
  const output = new MemoryWritable();
  const errors = new MemoryWritable();
  const terminal = new NodeCliTerminal(input, output, errors);

  const resultPromise = terminal.confirm('Confirm?');
  input.write('n\n');

  const result = await resultPromise;
  assert.equal(result, false);

  terminal.close();
});

test('confirm with yes returns true', async () => {
  const input = new PassThrough();
  const output = new MemoryWritable();
  const errors = new MemoryWritable();
  const terminal = new NodeCliTerminal(input, output, errors);

  const resultPromise = terminal.confirm('Confirm?');
  input.write('yes\n');

  const result = await resultPromise;
  assert.equal(result, true);

  terminal.close();
});

test('confirm with oui returns true', async () => {
  const input = new PassThrough();
  const output = new MemoryWritable();
  const errors = new MemoryWritable();
  const terminal = new NodeCliTerminal(input, output, errors);

  const resultPromise = terminal.confirm('Confirm?');
  input.write('oui\n');

  const result = await resultPromise;
  assert.equal(result, true);

  terminal.close();
});

test('confirm with o returns true', async () => {
  const input = new PassThrough();
  const output = new MemoryWritable();
  const errors = new MemoryWritable();
  const terminal = new NodeCliTerminal(input, output, errors);

  const resultPromise = terminal.confirm('Confirm?');
  input.write('o\n');

  const result = await resultPromise;
  assert.equal(result, true);

  terminal.close();
});

test('confirm with empty string returns false', async () => {
  const input = new PassThrough();
  const output = new MemoryWritable();
  const errors = new MemoryWritable();
  const terminal = new NodeCliTerminal(input, output, errors);

  const resultPromise = terminal.confirm('Confirm?');
  input.write('\n');

  const result = await resultPromise;
  assert.equal(result, false);

  terminal.close();
});

test('confirm with message displays full message', async () => {
  const input = new PassThrough();
  const output = new MemoryWritable();
  const errors = new MemoryWritable();
  const terminal = new NodeCliTerminal(input, output, errors);

  const resultPromise = terminal.confirm('Title', 'Message content');
  input.write('y\n');

  const result = await resultPromise;
  assert.equal(result, true);
  assert.ok(output.chunks.join('').includes('Title'));
  assert.ok(output.chunks.join('').includes('Message content'));
  assert.ok(output.chunks.join('').includes('Confirm? [y/N]'));

  terminal.close();
});

test('write outputs to stdout with newline', async () => {
  const input = new PassThrough();
  const output = new MemoryWritable();
  const errors = new MemoryWritable();
  const terminal = new NodeCliTerminal(input, output, errors);

  terminal.write('test message');
  terminal.write('another message');

  assert.equal(output.chunks.join(''), 'test message\nanother message\n');

  terminal.close();
});

test('writeError outputs to stderr with newline', async () => {
  const input = new PassThrough();
  const output = new MemoryWritable();
  const errors = new MemoryWritable();
  const terminal = new NodeCliTerminal(input, output, errors);

  terminal.writeError('error message');

  assert.equal(errors.chunks.join(''), 'error message\n');

  terminal.close();
});
