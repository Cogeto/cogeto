import type { ResolvedModelProviders } from './provider-config';

/**
 * The process's ONE live model configuration (V2.4 item 7.1).
 *
 * Before this, the resolved configuration was a value computed at boot and
 * handed to a dozen consumers, which was correct while it could only come from
 * the environment: nothing could change it without restarting the process that
 * read it. Once an admin can reassign a tier in the interface, that stops being
 * true, and a value copied into a dozen places becomes a dozen stale copies.
 *
 * So the object is a SINGLETON that is mutated in place rather than replaced.
 * Every consumer that was handed `config.modelProviders` holds a reference to
 * this same object and therefore always reads the current configuration; the
 * gateway notices a change through {@link ResolvedModelProviders.version} and
 * rebuilds its adapters, and nothing else has to know that reloading exists.
 *
 * The two places that captured a DERIVED STRING rather than the object (the
 * reconcile ledger's model label, the findings report's configuration) take a
 * getter instead, because a string cannot be updated in place.
 *
 * Embeddings are deliberately not part of what may change here: V2.4 item 7.1
 * refuses an embeddings change outright until the managed reindex ships, so the
 * embedding model a consumer captured at boot cannot go stale.
 */
export class LiveModelConfiguration {
  private readonly state: ResolvedModelProviders;

  constructor(initial: ResolvedModelProviders) {
    // A private copy: the caller's object must not become mutable state by
    // accident, and the eval harness passes the same resolver output around.
    this.state = { ...initial };
  }

  /** The live object. Callers may hold this reference indefinitely. */
  get current(): ResolvedModelProviders {
    return this.state;
  }

  /**
   * Adopt a newly resolved configuration. Mutates the live object in place and
   * bumps its version, so every holder sees the change and the gateway rebuilds
   * exactly once. A configuration that resolved identically still bumps the
   * version only when something actually differs, so an idle poll is free.
   */
  replace(next: ResolvedModelProviders): boolean {
    if (sameConfiguration(this.state, next)) return false;
    const version = this.state.version + 1;
    Object.assign(this.state, next, { version });
    return true;
  }
}

/**
 * Do two resolutions describe the same routing? Compared field by field over
 * what actually reaches a provider — bindings, endpoints, credentials, the
 * answer options — rather than by serializing the object, because the object
 * carries key material and JSON.stringify of a secret is a secret in a log
 * line waiting to happen.
 */
function sameConfiguration(a: ResolvedModelProviders, b: ResolvedModelProviders): boolean {
  // The served-name map is part of what reaches a provider: a reconciled
  // alias change on an unchanged binding must still rebuild the adapter,
  // because the wire identifier behind the same served name moved.
  const aliases = (map?: Readonly<Record<string, string>>): string =>
    map
      ? Object.entries(map)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([served, upstream]) => `${served}=${upstream}`)
          .join(',')
      : '';
  const binding = (
    x: {
      provider: string;
      model: string;
      endpoint?: { id: string; baseUrl: string; modelAliases?: Readonly<Record<string, string>> };
    } | null,
  ): string =>
    x
      ? `${x.provider}/${x.model}@${x.endpoint?.id ?? ''}:${x.endpoint?.baseUrl ?? ''}#${aliases(
          x.endpoint?.modelAliases,
        )}`
      : '-';
  if (a.configured !== b.configured || a.id !== b.id) return false;
  for (const tier of ['pipeline', 'answer', 'embedding'] as const) {
    if (binding(a.tiers[tier]) !== binding(b.tiers[tier])) return false;
    // A rotated key on an unchanged binding must still rebuild the adapter.
    if (a.tiers[tier].endpoint?.apiKey !== b.tiers[tier].endpoint?.apiKey) return false;
  }
  if (binding(a.vision) !== binding(b.vision)) return false;
  if (a.vision?.endpoint?.apiKey !== b.vision?.endpoint?.apiKey) return false;
  if (a.answerOptions.length !== b.answerOptions.length) return false;
  return a.answerOptions.every((option, index) => {
    const other = b.answerOptions[index]!;
    return (
      option.id === other.id &&
      option.label === other.label &&
      binding(option.binding) === binding(other.binding)
    );
  });
}
