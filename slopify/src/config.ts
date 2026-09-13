import manifest from '../resources.manifest.json' with { type: 'json' };

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid Slopify configuration: ${name} must be a non-empty string.`);
  }
  return value;
}

const defaultPipeline = requireNonEmptyString(manifest.defaultPipeline, 'defaultPipeline');
if (!manifest.pipelines.includes(`${defaultPipeline}.yaml`)) {
  throw new Error('Invalid Slopify configuration: defaultPipeline must reference a packaged pipeline.');
}

export const cliConfig = Object.freeze({
  defaultPipeline,
});
