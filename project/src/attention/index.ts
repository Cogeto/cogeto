/**
 * Public interface of the attention context: the aggregated "what needs my
 * attention" feed and the dashboard statistics, both computed per Principal.
 *
 * Owns `attention_state` and `attention_dismissal` (its read-state pair);
 * the tables stay private to this directory (spec §15.2).
 */
export { AttentionModule } from './attention.module';
export { AttentionService } from './attention.service';
