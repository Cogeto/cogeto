/**
 * Public interface of the operations context: the instance's health report,
 * its capability registry, the queue administration view and the audit trail's
 * paged browse.
 *
 * Owns no tables. Everything it reports on belongs to another module and is
 * read through that module's public interface.
 */
export { OperationsModule } from './operations.module';
export { OPERATIONS_OPTIONS } from './operations.options';
export type { OperationsOptions } from './operations.options';
export {
  CapabilitiesService,
  CAPABILITY_JOB_SOURCES,
  CAPABILITY_CACHE_TTL_MS,
  formatCapabilitiesBanner,
} from './capabilities';
export type { CapabilitiesSnapshot, CapabilityJobSources } from './capabilities';
export { redactHealthReport, isLoopbackRequest } from './health-access.guard';
export type { HealthRequest } from './health-access.guard';
