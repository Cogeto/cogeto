import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateKeyPairSync, sign as edSign, verify as edVerify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
// Ajv 2020 draft build (the passport precedent): validates against the
// PUBLISHED schema file, not the in-code zod.
import Ajv2020 from 'ajv/dist/2020';
import { canonicalize } from '../memory/index';
import { buildReportFixturePayload } from '../testing/index';
import {
  assertReportPayloadSafe,
  reportArtifactBytes,
  reportArtifactSchema,
  reportPayloadSchema,
  sanitizeReportText,
  sha256Hex,
  rateString,
} from './report-format';
import type { ReportArtifact } from './report-format';
import { readTrustScoresFor } from './report-assembler';

/**
 * The findings-report format contract (V2.3 item 6.2): the fixture payload
 * validates, the published JSON Schema cannot drift from the zod authority,
 * the integers-only invariant holds, and the sign/verify round trip works
 * exactly as the published procedure describes it.
 */

const SCHEMA_DIR = join(__dirname, '..', '..', '..', 'docs', 'findings-report-schema');

function fixtureArtifact(): ReportArtifact {
  const payload = reportPayloadSchema.parse(buildReportFixturePayload());
  const payloadSha256 = sha256Hex(Buffer.from(canonicalize(payload), 'utf8'));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const signature = edSign(null, Buffer.from(payloadSha256, 'utf8'), privateKey).toString('base64');
  return {
    findings_report_version: '1.0',
    payload,
    integrity: {
      algorithm: 'ed25519',
      canonicalization: 'sorted-keys-compact-json',
      payload_sha256: payloadSha256,
      signature,
      public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      public_key_endpoint: '/api/instance/public-key',
    },
  };
}

describe('report format', () => {
  it('report_fixture_valid: the fixture payload passes the zod contract and the integer walk', () => {
    const payload = reportPayloadSchema.parse(buildReportFixturePayload());
    expect(() => assertReportPayloadSafe(payload)).not.toThrow();
  });

  it('report_integers_only: a fractional number anywhere in the payload is refused', () => {
    const payload = buildReportFixturePayload() as unknown as Record<string, unknown>;
    (payload['summary'] as Record<string, unknown>)['facts_extracted'] = 63.5;
    expect(() => assertReportPayloadSafe(payload)).toThrow(/non-integer/);
  });

  it('report_schema_published: the published JSON Schema matches the zod authority byte for byte', () => {
    const generated = z.toJSONSchema(reportArtifactSchema, {
      target: 'draft-2020-12',
    }) as Record<string, unknown>;
    generated['$id'] = 'https://cogeto.eu/schemas/findings-report/1.0/findings-report.schema.json';
    generated['title'] = 'Cogeto findings report artifact';
    generated['description'] =
      'The signed findings-report JSON artifact: the payload plus the integrity block a third party verifies. Version 1.0.';
    const published = JSON.parse(
      readFileSync(join(SCHEMA_DIR, '1.0', 'findings-report.schema.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(generated).toEqual(published);
  });

  it('report_artifact_matches_published_schema: a generated artifact validates against the published file', () => {
    const artifact = fixtureArtifact();
    const schema = JSON.parse(
      readFileSync(join(SCHEMA_DIR, '1.0', 'findings-report.schema.json'), 'utf8'),
    ) as Record<string, unknown>;
    delete schema['$id'];
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validate = ajv.compile(schema);
    const parsed = JSON.parse(reportArtifactBytes(artifact).toString('utf8')) as unknown;
    const valid = validate(parsed);
    expect(validate.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
  });

  it('report_sample_published: the fictional sample in the schema directory is a valid artifact', () => {
    const sample = JSON.parse(
      readFileSync(join(SCHEMA_DIR, '1.0', 'sample', 'findings-report.json'), 'utf8'),
    ) as unknown;
    expect(() => reportArtifactSchema.parse(sample)).not.toThrow();
  });

  it('report_sign_verify_roundtrip: the documented procedure verifies what the executor produces', () => {
    const artifact = fixtureArtifact();
    // Step 1 + 2 of the published procedure: canonicalize the payload
    // (sorted keys, compact), hash it, compare.
    const recomputed = sha256Hex(Buffer.from(canonicalize(artifact.payload), 'utf8'));
    expect(recomputed).toBe(artifact.integrity.payload_sha256);
    // Step 3: ed25519 over the ASCII hex hash string.
    const ok = edVerify(
      null,
      Buffer.from(artifact.integrity.payload_sha256, 'utf8'),
      artifact.integrity.public_key_pem,
      Buffer.from(artifact.integrity.signature, 'base64'),
    );
    expect(ok).toBe(true);
    // A single flipped byte in the payload breaks the chain of custody.
    const tampered = structuredClone(artifact.payload);
    tampered.summary.findings_open += 1;
    expect(sha256Hex(Buffer.from(canonicalize(tampered), 'utf8'))).not.toBe(
      artifact.integrity.payload_sha256,
    );
  });

  it('report_canonicalization_pinned: the golden hash of a known payload never moves', () => {
    // Changing canonicalization breaks this test ON PURPOSE: it would break
    // every historical signature (the receipt-chain golden-hash rule).
    const known = { b: [1, 2], a: { y: 'ž', x: null }, c: 'text' };
    expect(canonicalize(known)).toBe('{"a":{"x":null,"y":"ž"},"b":[1,2],"c":"text"}');
    expect(sha256Hex(Buffer.from(canonicalize(known), 'utf8'))).toBe(
      '7aabb873ea92f064dbf69ee97572b34dd777fef1145cf89bbc75e4f6bc8c89ed',
    );
  });

  it('report_text_sanitized: control characters cannot reach the canonical bytes', () => {
    expect(sanitizeReportText('a\r\nb\u0000c\u009fd\te')).toBe('a\nb c d\te');
    expect(sanitizeReportText('verbatim ostaje: čćđšž')).toBe('verbatim ostaje: čćđšž');
  });

  it('report_rates_are_strings: metric fractions travel as fixed decimal strings', () => {
    expect(rateString(0.8235294)).toBe('0.824');
    expect(rateString(1)).toBe('1.000');
    expect(rateString(null)).toBeNull();
  });
});

// Pinned against the REAL published artifacts: the reader must match the
// document shape trust-scores actually publish (configurations[] entries),
// so a shape change cannot silently turn every report into "not_published".
describe('trust score lookup', () => {
  const trustDir = join(__dirname, '..', '..', '..', 'eval', 'trust-scores');

  it('report_trust_lookup: finds the published mistral-default scores', async () => {
    const result = await readTrustScoresFor(trustDir, 'mistral-default');
    expect(result.status).toBe('published');
    expect(result.matched_configuration_id).toBe('mistral-default');
    expect(result.release).toMatch(/^v\d/);
    expect(result.aggregate?.extraction_precision).toMatch(/^0\.\d{3}$/);
    expect(result.per_language?.some((lang) => lang.language === 'hr')).toBe(true);
  });

  it('report_trust_lookup_honest_miss: an unmeasured configuration states not_published', async () => {
    const result = await readTrustScoresFor(
      trustDir,
      'pipe-openai-ff711--ans-openai-ff711--emb-openai-bge-m3',
    );
    expect(result.status).toBe('not_published');
    expect(result.aggregate).toBeNull();
  });
});
