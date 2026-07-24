import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { prepareVibeHome } from '../src/VibeHome.js';

test('prepareVibeHome copies host Vibe env into mounted home', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sandcastle-vibe-home-'));
  try {
    const hostEnv = path.join(repo, 'host-vibe.env');
    fs.writeFileSync(hostEnv, 'MISTRAL_API_KEY=test-key\n', 'utf8');

    const vibeHome = prepareVibeHome(repo, hostEnv);

    assert.equal(
      fs.readFileSync(path.join(vibeHome, '.env'), 'utf8'),
      'MISTRAL_API_KEY=test-key\n',
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('prepareVibeHome forces Vibe tool permissions for Sandcastle', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sandcastle-vibe-config-'));
  try {
    const vibeHome = path.join(repo, '.sandcastle', 'vibe-home');
    fs.mkdirSync(vibeHome, { recursive: true });
    fs.writeFileSync(path.join(vibeHome, 'config.toml'), [
      'bypass_tool_permissions = false',
      'experimental_bash_tool = false',
      '',
      '[tools.edit]',
      'permission = "ask"',
      '',
      '[tools.bash]',
      'permission = "ask"',
      'allowlist = ["git status"]',
      '',
    ].join('\n'), 'utf8');

    prepareVibeHome(repo, path.join(repo, 'missing-env'));

    const config = fs.readFileSync(path.join(vibeHome, 'config.toml'), 'utf8');
    assert.match(config, /^bypass_tool_permissions = true$/m);
    assert.match(config, /^experimental_bash_tool = true$/m);
    assert.match(config, /^ask_confirmation_on_exit = false$/m);
    assert.match(config, /\[tools\.edit\]\npermission = "always"/);
    assert.match(config, /\[tools\.write_file\]\npermission = "always"/);
    assert.match(config, /\[tools\.bash\]\npermission = "always"\nallowlist = \["git status"\]/);
    assert.match(config, /\[tools\.task\]\npermission = "always"/);
    assert.match(config, /\[tools\.web_search\]\npermission = "always"/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
