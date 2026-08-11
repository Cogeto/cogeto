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
export {
  CapabilitiesService,
  CAPABILITY_JOB_SOURCES,
  CONNECTOR_HEALTH,
  formatCapabilitiesBanner,
} from './capabilities';
export type { ConnectorHealthPort } from './capabilities';
