# providers: the instance's model and provider configuration (bounded context)

V2.4 item 7.1. Providers, models and their API keys are records an administrator
manages in the interface, stored in the database with the keys encrypted under
`COGETO_MASTER_KEY`. The interface is the ONLY place models are configured: the
environment carries no model configuration at all, and an instance with no provider
configured boots cleanly with model features off, which is the normal first-run
state.

Owns six tables (migration 0052): `model_provider`, `model_assignment`,
`model_answer_option`, `user_answer_model`, `model_configuration_change`,
`model_config_state`. Owns the two admin surfaces over them
(`/api/admin/providers`, `/api/admin/model-configuration`) and the one model choice a
user makes for themselves (`/api/settings/answer-model`).

May depend on: `infrastructure` (the database handle and the audit trail),
`identity` (the bearer and admin guards), and the `model-gateway` seam. Depends on no
other domain module, and no other domain module depends on it except `chat`, which
asks it which answer model this user chose.

## The rules this module exists to keep

**A saved key never comes back out.** It is sealed on write and opened only where a
call is about to be made. `persistence/provider-store.ts` selects the ciphertext
column in exactly ONE function, `listProvidersWithSecrets`; every other read names its
columns and omits it, so no DTO can carry key material even by accident.
`key-confinement.spec.ts` asserts that against the source rather than trusting it.

**The seam does the talking.** Discovery and validation both open sockets to a
provider endpoint, so both live in `model-gateway` (`provider-probe.ts`) and are
called from here. A module that manages provider RECORDS is not a module that speaks
a provider's HTTP.

**A model is validated by use.** Every assignment probes the tier's real job before it
is stored: a completion, an embedding, a 32-pixel image. Never a pattern match on a
model name.

**The embeddings tier changes only through the managed rebuild** (item 7.1 second
half). A direct assignment still gets a server-side refusal, because it would serve
a mixed embedding space; the plan/confirm/rebuild endpoints on this module's
controller drive memory's rebuild engine instead, and the switch reaches this
module's assignment through `embeddingsSwitchPort`, bound in the worker root.

**One live configuration per process.** `LiveModelConfiguration` (the seam's) is
mutated in place, so every consumer that holds it is current; the gateway rebuilds its
stack on a version change, and this module's watcher polls the version column for
changes another process made.

## Files

| File | What it is |
|---|---|
| `load-configuration.ts` | The boot path: resolve from the database. Called by every composition root and by the CLIs that talk to models. |
| `domain/resolve.ts` | Stored rows into the seam's `ResolvedModelProviders`. The one place keys are decrypted. |
| `../infrastructure/secret-box.ts` | AES-256-GCM under the instance master key. Moved to infrastructure in V2.5 item 8.1 so provider keys and connector credentials share ONE mechanism; this module keeps consuming it unchanged. |
| `domain/provider-types.ts` | What each provider family is: adapter, endpoint, key and embeddings capability. |
| `domain/trust-lookup.ts` | What the published trust scores say about the configuration in force, or plainly that nothing does. |
| `provider-config.service.ts` | The admin operations, the validation, the audit, the reload. |
