import { z } from 'zod';
import { loadPrompt, MistralModelGateway } from '../model-gateway/index';

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
  const apiKey = process.env.COGETO_MISTRAL_API_KEY ?? process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    console.log(
      'gateway:smoke SKIPPED — set COGETO_MISTRAL_API_KEY (or MISTRAL_API_KEY) to run ' +
        'a live structured extraction against the Mistral API.',
    );
    return;
  }

  const prompt = await loadPrompt('smoke', 'v0001');
  console.log(
    `prompt: ${prompt.family}/${prompt.version} (sha256 ${prompt.contentHash.slice(0, 12)}…)`,
  );
  console.log(`input:  ${INPUT}`);

  const gateway = new MistralModelGateway({ apiKey });
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
