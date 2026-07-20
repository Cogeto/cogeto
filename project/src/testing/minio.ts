import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';

/**
 * Integration-test MinIO: the same image the compose stack runs, with the
 * single-node KMS key set so bucket encryption (SSE-S3, decision 0008) is
 * testable exactly as deployed. Credentials mirror the compose dev defaults.
 */
export interface TestMinio {
  container: StartedTestContainer;
  url: string;
  accessKey: string;
  secretKey: string;
  stop(): Promise<void>;
}

export async function startTestMinio(): Promise<TestMinio> {
  const accessKey = 'cogeto';
  const secretKey = 'cogeto-dev-password';
  const container = await new GenericContainer('minio/minio:latest')
    .withEnvironment({
      MINIO_ROOT_USER: accessKey,
      MINIO_ROOT_PASSWORD: secretKey,
      // Test-only KMS key material (same format as the compose dev default).
      MINIO_KMS_SECRET_KEY: 'cogeto-test-key:bxaADytwX4au7d/HYGegSGd0uloQlb30uz6Vh5opUvg=',
    })
    .withCommand(['server', '/data'])
    .withExposedPorts(9000)
    // `ready`, not `live`: the live endpoint answers while the server is still
    // initializing, and the first S3 call then races a 503
    // XMinioServerNotInitialized (seen as a CI flake). Ready gates on the
    // server actually serving requests.
    .withWaitStrategy(Wait.forHttp('/minio/health/ready', 9000))
    .start();
  const url = `http://${container.getHost()}:${container.getMappedPort(9000)}`;
  return {
    container,
    url,
    accessKey,
    secretKey,
    stop: async () => {
      await container.stop();
    },
  };
}
