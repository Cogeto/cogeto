import { z } from 'zod';
import { createModelGateway, loadPrompt, resolveModelProviders } from '../model-gateway/index';
import { redactionFromEnv } from './config';

/**
 * gateway:smoke — proves the model-gateway round trip (S1-B §5).
 * With COGETO_MISTRAL_API_KEY (or MISTRAL_API_KEY) set: runs a trivial structured
 * extraction through the versioned smoke prompt and prints the validated result.
 * Without a key: prints a clear skip message and exits 0.
 */
const smokeSchema = z.object({
  people: z.array(z.string()),
  commitment: z.string().nullable(),
});

const INPUT = 'Ana will send the revised proposal to Marko after he confirms the budget.';

async function main(): Promise<void> {
  const redaction = redactionFromEnv();
  const providers = resolveModelProviders(process.env, { redacted: redaction !== undefined });
  if (!providers.configured) {
    console.log(
      'gateway:smoke SKIPPED — set COGETO_MISTRAL_API_KEY (or a COGETO_PROVIDER_* ' +
        'configuration) to run a live structured extraction against the configured provider.',
    );
    return;
  }

  const prompt = await loadPrompt('smoke', 'v0001');
  console.log(
    `configuration: ${providers.id} · prompt: ${prompt.family}/${prompt.version} ` +
      `(sha256 ${prompt.contentHash.slice(0, 12)}…)`,
  );
  console.log(`input:  ${INPUT}`);

  const gateway = createModelGateway({ providers, redaction });
  const result = await gateway.extractStructured(smokeSchema, {
    system: prompt.content,
    input: INPUT,
  });

  console.log('validated result:');
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  console.error('gateway:smoke failed:', error);
  process.exit(1);
});
