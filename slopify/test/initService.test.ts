import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { createInitPlan, InitService } from '../src/initService.js';

const packageRoot = path.resolve(import.meta.dirname, '../..');

test('plans host destinations purely from the supplied manifest catalog', () => {
  const common = [{ source: '/assets/spec', destination: '.scratch/spec.md' }];
  const hosts = new Map([['future-host', [{ source: '/assets/skill', destination: '.future/skill.md' }]]]);
  assert.deepEqual(createInitPlan('/target', 'future-host', ['future-host'], common, hosts), {
    target: '/target', files: [...common, { source: '/assets/skill', destination: '.future/skill.md' }],
  });
});

test('plans and installs common and selected host assets, then overwrites owned files', async t => {
  const target = await mkdtemp(path.join(tmpdir(), 'slopify-init-'));
  t.after(() => rm(target, { recursive: true, force: true }));
  const service = new InitService({ packageRoot });
  const plan = await service.plan(target, 'pi');
  assert.ok(plan.files.some(file => file.destination === '.scratch/slopify/batch.json'));
  assert.ok(plan.files.some(file => file.destination === '.pi/skills/slopify-launch/SKILL.md'));
  assert.ok(!plan.files.some(file => file.destination.startsWith('.agents/')));
  const first = await service.apply(plan);
  assert.equal(first.result, 'succeeded');
  assert.deepEqual(first.overwritten, []);
  await writeFile(path.join(target, '.scratch/slopify/spec.md'), 'custom');
  const second = await service.apply(plan);
  assert.ok(second.overwritten.includes('.scratch/slopify/spec.md'));
  assert.match(await readFile(path.join(target, '.scratch/slopify/spec.md'), 'utf8'), /Slopify V2/);
});

test('all installs both manifest hosts without changing unrelated or outside files', async t => {
  const target = await mkdtemp(path.join(tmpdir(), 'slopify-init-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'slopify-outside-'));
  t.after(() => Promise.all([rm(target, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  const unrelated = path.join(target, 'keep.txt');
  const outsideFile = path.join(outside, 'keep.txt');
  await writeFile(unrelated, 'target unchanged');
  await writeFile(outsideFile, 'outside unchanged');

  const service = new InitService({ packageRoot });
  const result = await service.apply(await service.plan(target, 'all'));

  await access(path.join(target, '.pi/skills/slopify-launch/SKILL.md'));
  await access(path.join(target, '.agents/skills/slopify-launch/SKILL.md'));
  assert.equal(await readFile(unrelated, 'utf8'), 'target unchanged');
  assert.equal(await readFile(outsideFile, 'utf8'), 'outside unchanged');
  assert.ok(result.created.includes('.pi/skills/slopify-launch/SKILL.md'));
  assert.ok(result.created.includes('.agents/skills/slopify-launch/SKILL.md'));
});

test('validates every destination before mutation and rejects escaping symlinks', async t => {
  const target = await mkdtemp(path.join(tmpdir(), 'slopify-init-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'slopify-outside-'));
  t.after(() => Promise.all([rm(target, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await mkdir(path.join(target, '.scratch'));
  await symlink(outside, path.join(target, '.scratch/slopify'));
  const service = new InitService({ packageRoot });
  await assert.rejects(service.plan(target, 'all'), /symlinked init destination/);
  await assert.rejects(access(path.join(target, '.pi')), /ENOENT/);
});

test('Pi-only planning rejects every symlink route used by the external skills installer', async t => {
  for (const route of ['.agents', '.agents/skills', 'skills-lock.json']) {
    const target = await mkdtemp(path.join(tmpdir(), 'slopify-init-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'slopify-outside-'));
    t.after(() => Promise.all([rm(target, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
    if (route === '.agents/skills') await mkdir(path.join(target, '.agents'));
    const linkTarget = route === 'skills-lock.json' ? path.join(outside, 'skills-lock.json') : outside;
    if (route === 'skills-lock.json') await writeFile(linkTarget, 'outside unchanged');
    await symlink(linkTarget, path.join(target, route));

    await assert.rejects(new InitService({ packageRoot }).plan(target, 'pi'), new RegExp(`symlinked init destination.*${route.replace('.', '\\.')}`));
    await assert.rejects(access(path.join(target, '.pi')), /ENOENT/);
  }
});
