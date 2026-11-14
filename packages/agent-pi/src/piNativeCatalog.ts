import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { load } from 'js-yaml';

/**
 * Catalogue des providers nativement pris en charge par Pi que le runner Slopify
 * sait configurer dans une sandbox : chaque entrée reprend l'identité, l'endpoint
 * et les modèles du provider natif Pi correspondant (catalogue @earendil-works/pi-ai
 * 1.5.2, providers/data/<id>.json, modèles de chat uniquement). Aucun provider,
 * adaptateur, bridge ni endpoint local n'est ajouté ici ; les providers natifs dont
 * l'authentification ne peut pas être reproduite par l'injection de credentials du
 * kit sandbox (ex. opencode-go et son en-tête de session dynamique) restent hors
 * catalogue jusqu'à ce que le mécanisme les couvre.
 */
export interface PiNativeModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Record<string, string | null>;
  compat?: Record<string, unknown>;
}

export interface PiNativeProvider {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  apiKeyEnv: string;
  credentialService: string;
  models: PiNativeModel[];
}

export const PI_NATIVE_PROVIDERS: readonly PiNativeProvider[] = [
  {
    id: 'mistral', name: 'Mistral', baseUrl: 'https://api.mistral.ai', api: 'mistral-conversations',
    apiKeyEnv: 'MISTRAL_API_KEY', credentialService: 'mistral',
    models: [
      { id: 'codestral-2508', name: 'Codestral 25.08', reasoning: false, input: ['text'], contextWindow: 256000, maxTokens: 8192 },
      { id: 'codestral-latest', name: 'Codestral (latest)', reasoning: false, input: ['text'], contextWindow: 256000, maxTokens: 4096 },
      { id: 'deepseek-v4-1-flash-1017', name: 'DeepSeek V4.1 Flash 1017', reasoning: true, input: ['text'], contextWindow: 1048576, maxTokens: 128000, thinkingLevelMap: { off: 'none', minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' } },
      { id: 'devstral-2512', name: 'Devstral 2', reasoning: false, input: ['text'], contextWindow: 262144, maxTokens: 262144 },
      { id: 'devstral-latest', name: 'Devstral 2', reasoning: false, input: ['text'], contextWindow: 262144, maxTokens: 262144 },
      { id: 'devstral-medium-latest', name: 'Devstral 2 (latest)', reasoning: false, input: ['text'], contextWindow: 262144, maxTokens: 262144 },
      { id: 'glm-5-2', name: 'GLM-5.2', reasoning: true, input: ['text'], contextWindow: 1048576, maxTokens: 131072, thinkingLevelMap: { off: 'none', minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: 'max' } },
      { id: 'labs-devstral-small-2512', name: 'Devstral Small 2', reasoning: false, input: ['text', 'image'], contextWindow: 256000, maxTokens: 262144 },
      { id: 'labs-leanstral-1-5-1', name: 'Leanstral 1.5', reasoning: true, input: ['text', 'image'], contextWindow: 262144, maxTokens: 128000, thinkingLevelMap: { off: 'none', minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: null } },
      { id: 'magistral-medium-latest', name: 'Magistral Medium (latest)', reasoning: true, input: ['text', 'image'], contextWindow: 262144, maxTokens: 16384, thinkingLevelMap: { off: 'none', minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: null } },
      { id: 'ministral-14b-2512', name: 'Ministral 3 14B', reasoning: false, input: ['text', 'image'], contextWindow: 262144, maxTokens: 262144 },
      { id: 'ministral-3b-2512', name: 'Ministral 3 3B', reasoning: false, input: ['text', 'image'], contextWindow: 131072, maxTokens: 262144 },
      { id: 'ministral-3b-latest', name: 'Ministral 3B (latest)', reasoning: false, input: ['text', 'image'], contextWindow: 131072, maxTokens: 128000 },
      { id: 'ministral-8b-2512', name: 'Ministral 3 8B', reasoning: false, input: ['text', 'image'], contextWindow: 262144, maxTokens: 262144 },
      { id: 'ministral-8b-latest', name: 'Ministral 8B (latest)', reasoning: false, input: ['text', 'image'], contextWindow: 262144, maxTokens: 128000 },
      { id: 'mistral-large-2512', name: 'Mistral Large 3', reasoning: false, input: ['text', 'image'], contextWindow: 262144, maxTokens: 262144 },
      { id: 'mistral-large-4', name: 'Mistral Large 4', reasoning: true, input: ['text', 'image'], contextWindow: 1048576, maxTokens: 262144, thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null } },
      { id: 'mistral-large-4-0-8', name: 'Mistral Large 4.0.8', reasoning: true, input: ['text', 'image'], contextWindow: 1048576, maxTokens: 262144, thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null } },
      { id: 'mistral-large-latest', name: 'Mistral Large (latest)', reasoning: false, input: ['text', 'image'], contextWindow: 262144, maxTokens: 262144 },
      { id: 'mistral-medium-2505', name: 'Mistral Medium 3', reasoning: false, input: ['text', 'image'], contextWindow: 131072, maxTokens: 131072 },
      { id: 'mistral-medium-2508', name: 'Mistral Medium 3.1', reasoning: false, input: ['text', 'image'], contextWindow: 262144, maxTokens: 262144 },
      { id: 'mistral-medium-2604', name: 'Mistral Medium 3.5', reasoning: true, input: ['text', 'image'], contextWindow: 262144, maxTokens: 262144, thinkingLevelMap: { off: 'none', minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: null } },
      { id: 'mistral-medium-3.5', name: 'Mistral Medium 3.5', reasoning: true, input: ['text', 'image'], contextWindow: 262144, maxTokens: 262144, thinkingLevelMap: { off: 'none', minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: null } },
      { id: 'mistral-medium-latest', name: 'Mistral Medium (latest)', reasoning: true, input: ['text', 'image'], contextWindow: 262144, maxTokens: 262144, thinkingLevelMap: { off: 'none', minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: null } },
      { id: 'mistral-small-2506', name: 'Mistral Small 3.2', reasoning: false, input: ['text', 'image'], contextWindow: 128000, maxTokens: 16384 },
      { id: 'mistral-small-2603', name: 'Mistral Small 4', reasoning: true, input: ['text', 'image'], contextWindow: 262144, maxTokens: 256000, thinkingLevelMap: { off: 'none', minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: null } },
      { id: 'mistral-small-latest', name: 'Mistral Small (latest)', reasoning: true, input: ['text', 'image'], contextWindow: 262144, maxTokens: 256000, thinkingLevelMap: { off: 'none', minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: null } },
      { id: 'open-mistral-nemo', name: 'Open Mistral Nemo', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 128000 },
      { id: 'pixtral-12b', name: 'Pixtral 12B', reasoning: false, input: ['text', 'image'], contextWindow: 128000, maxTokens: 128000 },
      { id: 'voxtral-small-2507', name: 'Voxtral Small', reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 32000 },
      { id: 'voxtral-small-latest', name: 'Voxtral Small (latest)', reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 32000 },
      { id: 'zai-glm-5-2', name: 'GLM-5.2', reasoning: true, input: ['text'], contextWindow: 1048576, maxTokens: 131072, thinkingLevelMap: { off: 'none', minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: 'max' } },
      { id: 'zai-glm-5-3', name: 'GLM-5.3', reasoning: true, input: ['text'], contextWindow: 1048576, maxTokens: 131072, thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' } },
      { id: 'zai-glm-5-3-flash', name: 'GLM-5.3-Flash', reasoning: true, input: ['text', 'image'], contextWindow: 1048576, maxTokens: 131072, thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' } },
    ],
  },
  {
    id: 'zai', name: 'Z.AI', baseUrl: 'https://api.z.ai/api/coding/paas/v4', api: 'openai-completions',
    apiKeyEnv: 'ZAI_API_KEY', credentialService: 'zai',
    models: [
      { id: 'glm-4.7', name: 'GLM-4.7', reasoning: true, input: ['text'], contextWindow: 204800, maxTokens: 131072, compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: 'max_tokens', thinkingFormat: 'zai', supportsStrictMode: true, zaiToolStream: true } },
      { id: 'glm-5-turbo', name: 'GLM-5-Turbo', reasoning: true, input: ['text'], contextWindow: 200000, maxTokens: 131072, compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: 'max_tokens', thinkingFormat: 'zai', supportsStrictMode: true, zaiToolStream: true } },
      { id: 'glm-5.2', name: 'GLM-5.2', reasoning: true, input: ['text'], contextWindow: 1000000, maxTokens: 131072, thinkingLevelMap: { off: 'none', minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: 'max' }, compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: true, maxTokensField: 'max_tokens', thinkingFormat: 'zai', supportsStrictMode: true, zaiToolStream: true } },
      { id: 'glm-5.2-highspeed', name: 'GLM-5.2 Highspeed', reasoning: true, input: ['text'], contextWindow: 1000000, maxTokens: 131072, thinkingLevelMap: { off: 'none', minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: 'max' }, compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: true, maxTokensField: 'max_tokens', thinkingFormat: 'zai', supportsStrictMode: true, zaiToolStream: true } },
      { id: 'glm-5.3', name: 'GLM-5.3', reasoning: true, input: ['text'], contextWindow: 1000000, maxTokens: 131072, thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' }, compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: true, maxTokensField: 'max_tokens', thinkingFormat: 'zai', supportsStrictMode: true, zaiToolStream: true } },
      { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', reasoning: true, input: ['text', 'image'], contextWindow: 1000000, maxTokens: 131072, thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' }, compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: true, maxTokensField: 'max_tokens', thinkingFormat: 'zai', supportsStrictMode: true, zaiToolStream: true } },
      { id: 'glm-5.3-highspeed', name: 'GLM-5.3 Highspeed', reasoning: true, input: ['text'], contextWindow: 1000000, maxTokens: 131072, thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' }, compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: true, maxTokensField: 'max_tokens', thinkingFormat: 'zai', supportsStrictMode: true, zaiToolStream: true } },
    ],
  },
];

/** Sélection effective retenue pour une exécution Pi : couple provider/modèle natif et origine du choix. */
export interface PiModelSelection {
  provider: PiNativeProvider;
  model: PiNativeModel;
  source: 'configured' | 'default';
}

const DEFAULT_PROVIDER = 'mistral';
const DEFAULT_MODEL = 'zai-glm-5-3';

/** Erreur de sélection invalide : toujours explicite et actionnable, jamais de bascule silencieuse. */
class PiModelSelectionError extends Error {
  readonly code = 'pi_model_selection_invalid';
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Valide le couple provider/modèle demandé contre le catalogue des providers natifs Pi.
 * L'absence de sélection retient le couple par défaut documenté ; toute sélection
 * partielle, inconnue ou incompatible échoue avec la liste des choix valides.
 */
export function resolvePiModelSelection(provider: unknown, model: unknown): PiModelSelection {
  const configuredProvider = nonEmptyString(provider);
  const configuredModel = nonEmptyString(model);
  if ((provider !== undefined || model !== undefined) && (!configuredProvider || !configuredModel)) {
    throw new PiModelSelectionError(
      `Invalid Pi model selection: provider and model must be configured together in .slopify/runtime.yaml under pi: (got provider ${JSON.stringify(provider ?? undefined)}, model ${JSON.stringify(model ?? undefined)}).`);
  }
  if (configuredProvider === undefined && configuredModel === undefined) {
    const defaultProvider = PI_NATIVE_PROVIDERS.find(entry => entry.id === DEFAULT_PROVIDER)!;
    return { provider: defaultProvider, model: defaultProvider.models.find(entry => entry.id === DEFAULT_MODEL)!, source: 'default' };
  }
  const providerEntry = PI_NATIVE_PROVIDERS.find(entry => entry.id === configuredProvider);
  if (!providerEntry) {
    throw new PiModelSelectionError(
      `Pi provider "${configuredProvider}" is not a natively supported Pi provider configurable by Slopify. Supported providers: ${PI_NATIVE_PROVIDERS.map(entry => entry.id).join(', ')}. Fix pi.provider in .slopify/runtime.yaml.`);
  }
  const modelEntry = providerEntry.models.find(entry => entry.id === configuredModel);
  if (!modelEntry) {
    throw new PiModelSelectionError(
      `Pi model "${configuredModel}" is not offered by the native Pi provider "${providerEntry.id}". Available models: ${providerEntry.models.map(entry => entry.id).join(', ')}. Fix pi.model in .slopify/runtime.yaml.`);
  }
  return { provider: providerEntry, model: modelEntry, source: 'configured' };
}

/**
 * Lit la sélection explicite dans la section pi de .slopify/runtime.yaml du dépôt :
 * pi: { provider: <id natif Pi>, model: <id modèle du provider> }. La section est
 * optionnelle ; toute valeur invalide échoue avant la création de la sandbox.
 */
export async function loadPiModelSelection(repositoryPath: string): Promise<PiModelSelection> {
  let text: string;
  try {
    text = await readFile(path.join(repositoryPath, '.slopify', 'runtime.yaml'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolvePiModelSelection(undefined, undefined);
    throw error;
  }
  let document: unknown;
  try {
    document = load(text);
  } catch (error) {
    throw new Error(`Cannot read .slopify/runtime.yaml: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('Cannot read .slopify/runtime.yaml: the file must be a YAML object.');
  }
  const pi = (document as Record<string, unknown>).pi;
  if (pi === undefined) return resolvePiModelSelection(undefined, undefined);
  if (!pi || typeof pi !== 'object' || Array.isArray(pi)) {
    throw new Error('Invalid .slopify/runtime.yaml: pi must be an object with provider and model.');
  }
  for (const key of Object.keys(pi as Record<string, unknown>)) {
    if (key !== 'provider' && key !== 'model') {
      throw new Error(`Invalid .slopify/runtime.yaml: unknown key "${key}" in the pi section; only provider and model are supported.`);
    }
  }
  return resolvePiModelSelection((pi as Record<string, unknown>).provider, (pi as Record<string, unknown>).model);
}
