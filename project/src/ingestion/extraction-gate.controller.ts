import { Body, Controller, Delete, Get, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { EXTRACTION_GATE_DIMENSIONS, SOURCE_TYPES, sourceTypeDescriptor } from '@cogeto/shared';
import type {
  ExtractionGateConfigDto,
  ExtractionGateDto,
  ExtractionGateRuleDto,
  ExtractionRefusalDto,
} from '@cogeto/shared';
import { BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { parseOrBadRequest, userError } from '../infrastructure/index';
import { ExtractionGateStore } from './persistence/extraction-gate.store';
import type {
  ExtractionGateRefusalRow,
  ExtractionGateRow,
  ExtractionGateRuleRow,
} from './persistence/tables';

/**
 * /api/extraction-gate — the settings surface over the per-source extraction
 * gate (V2.1 item 4.3, spec 1.6). Owned by ingestion, the module that owns the
 * tables and enforces the decisions; rendered on the Settings page the way the
 * email module's capture section is.
 *
 * The controllable set is the registry's extraction-capable source types: a
 * gate over a type that never extracts would be a control that controls
 * nothing, and the API refuses to create one.
 */

/** Registered, extraction-capable, current — the types a gate may control. */
const GATEABLE_SOURCE_TYPES = Object.entries(SOURCE_TYPES)
  .filter(([, descriptor]) => descriptor.extraction && !descriptor.defunct)
  .map(([key]) => key)
  .sort();

const setGateSchema = z.object({
  enabled: z.boolean().optional(),
  factBudget: z.number().int().min(1).max(10_000).nullable().optional(),
  retentionDays: z.number().int().min(1).max(3_650).nullable().optional(),
});

const addRuleSchema = z
  .object({
    sourceType: z.string().min(1),
    dimension: z.enum(EXTRACTION_GATE_DIMENSIONS),
    value: z.string().min(1).max(500),
    effect: z.enum(['allow', 'deny']),
    factBudget: z.number().int().min(1).max(10_000).nullable().optional(),
    retentionDays: z.number().int().min(1).max(3_650).nullable().optional(),
  })
  .refine((rule) => rule.dimension !== 'source_id' || rule.effect === 'deny', {
    message:
      'source_id rules are deny-only: allowing a single document would silently disable the rest of its connector',
  })
  .refine(
    (rule) =>
      rule.dimension !== 'source_id' || (rule.factBudget == null && rule.retentionDays == null),
    {
      message: 'per-rule bounds apply to folder and document_class rules only',
    },
  );

@Controller('extraction-gate')
@UseGuards(BearerAuthGuard)
export class ExtractionGateController {
  constructor(private readonly store: ExtractionGateStore) {}

  @Get()
  async config(@Req() request: AuthenticatedRequest): Promise<ExtractionGateConfigDto> {
    const config = await this.store.configFor(request.principal);
    return {
      sourceTypes: GATEABLE_SOURCE_TYPES,
      gates: config.gates.map(toGateDto),
      rules: config.rules.map(toRuleDto),
      recentRefusals: config.recentRefusals.map(toRefusalDto),
    };
  }

  @Put(':sourceType')
  async setGate(
    @Req() request: AuthenticatedRequest,
    @Param('sourceType') sourceType: string,
    @Body() body: unknown,
  ): Promise<ExtractionGateDto> {
    assertGateable(sourceType);
    const patch = parseOrBadRequest(setGateSchema, body);
    return toGateDto(await this.store.setGate(request.principal, sourceType, patch));
  }

  @Post('rules')
  async addRule(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<ExtractionGateRuleDto> {
    const rule = parseOrBadRequest(addRuleSchema, body);
    assertGateable(rule.sourceType);
    return toRuleDto(await this.store.addRule(request.principal, rule));
  }

  @Delete('rules/:id')
  async removeRule(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{ removed: boolean }> {
    const removed = await this.store.removeRule(request.principal, parseOrBadRequest(z.uuid(), id));
    if (!removed) throw userError.notFound('extractionGate.ruleNotFound', 'no such rule');
    return { removed };
  }
}

function assertGateable(sourceType: string): void {
  const descriptor = sourceTypeDescriptor(sourceType);
  if (!descriptor || descriptor.defunct || !descriptor.extraction) {
    throw userError.badRequest(
      'extractionGate.notGateable',
      "'{{sourceType}}' is not an extraction-capable source type; the gate controls: {{gateable}}",
      { sourceType, gateable: GATEABLE_SOURCE_TYPES.join(', ') },
    );
  }
}

function toGateDto(row: ExtractionGateRow): ExtractionGateDto {
  return {
    sourceType: row.sourceType,
    enabled: row.enabled,
    factBudget: row.factBudget,
    retentionDays: row.retentionDays,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toRuleDto(row: ExtractionGateRuleRow): ExtractionGateRuleDto {
  return {
    id: row.id,
    sourceType: row.sourceType,
    dimension: row.dimension as ExtractionGateRuleDto['dimension'],
    value: row.value,
    effect: row.effect,
    factBudget: row.factBudget,
    retentionDays: row.retentionDays,
    createdAt: row.createdAt.toISOString(),
  };
}

function toRefusalDto(row: ExtractionGateRefusalRow): ExtractionRefusalDto {
  return {
    id: row.id,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    reason: row.reason,
    documentClass: row.documentClass,
    refusedAt: row.refusedAt.toISOString(),
  };
}
