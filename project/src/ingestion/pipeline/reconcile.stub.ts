import type { AdmittedMemory } from './embed-store.stage';
import type { PipelineLog } from './pipeline-log';

/**
 * Stage 6 (reconcile) — stub. Session 4 fills it: dedup (similarity shortlist →
 * arbitration), contradiction detection, supersession and interval maintenance,
 * acting only through Memory-aggregate status transitions. Until then it logs
 * and passes through.
 */
export function reconcileStub(admitted: AdmittedMemory[], log: PipelineLog): AdmittedMemory[] {
  log(
    { stage: 'reconcile', admitted: admitted.length, implemented: false },
    'reconcile stub: dedup, contradiction and supersession arrive in Session 4',
  );
  return admitted;
}
