import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Logger } from '../types.js';

const LEGACY_CODEX_REASONING_LEVELS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

export function normalizeCodexModelsCacheForLegacyCli(logger?: Logger): void {
	const cachePath = join(homedir(), '.codex', 'models_cache.json');
	if (!existsSync(cachePath)) {
		return;
	}

	try {
		const cache = JSON.parse(readFileSync(cachePath, 'utf8')) as { models?: unknown[] };
		let changed = false;

		for (const model of cache.models ?? []) {
			if (!model || typeof model !== 'object') {
				continue;
			}
			const entry = model as Record<string, unknown>;
			const levels = entry.supported_reasoning_levels;
			if (Array.isArray(levels)) {
				const nextLevels = levels.filter(level => {
					if (!level || typeof level !== 'object') {
						return true;
					}
					const effort = (level as Record<string, unknown>).effort;
					return typeof effort !== 'string' || LEGACY_CODEX_REASONING_LEVELS.has(effort);
				});
				if (nextLevels.length !== levels.length) {
					entry.supported_reasoning_levels = nextLevels;
					changed = true;
				}
			}
			if (entry.default_reasoning_level === 'max' || entry.default_reasoning_level === 'ultra') {
				entry.default_reasoning_level = 'xhigh';
				changed = true;
			}
			if (!Object.prototype.hasOwnProperty.call(entry, 'supports_reasoning_summaries')) {
				entry.supports_reasoning_summaries = false;
				changed = true;
			}
		}

		if (changed) {
			writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
			logger?.log('Normalized Codex models cache for legacy codex-acp compatibility.');
		}
	} catch (error) {
		logger?.error('Failed to normalize Codex models cache for legacy codex-acp compatibility', error);
	}
}

export function isCodexAcpCommand(command: string, args: readonly string[] = []): boolean {
	return command === 'codex'
		|| args.some(arg => arg === '@zed-industries/codex-acp' || arg.startsWith('@zed-industries/codex-acp@'));
}
