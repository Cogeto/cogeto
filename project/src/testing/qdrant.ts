import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';

/** Integration-test Qdrant: the same image the compose stack runs. */
export interface TestQdrant {
  container: StartedTestContainer;
  url: string;
  stop(): Promise<void>;
}

export async function startTestQdrant(): Promise<TestQdrant> {
  const container = await new GenericContainer('qdrant/qdrant:v1.14.0')
    .withExposedPorts(6333)
    .withWaitStrategy(Wait.forHttp('/readyz', 6333))
    .start();
  const url = `http://${container.getHost()}:${container.getMappedPort(6333)}`;
  return {
    container,
    url,
    stop: async () => {
      await container.stop();
    },
  };
}

/**
 * Deterministic unit-norm pseudo-embedding: same text → same vector. Lets
 * integration tests exercise real Qdrant search without a live model.
 */
export function fakeEmbedding(text: string, dims: number): number[] {
  let seed = 0;
  for (const ch of text) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const vector = Array.from({ length: dims }, () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return (seed % 2000) / 1000 - 1;
  });
  const norm = Math.hypot(...vector) || 1;
  return vector.map((x) => x / norm);
}
