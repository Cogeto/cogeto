/**
 * Ana sandbox (decision 0022 §4): a subtle, permanent banner in demo mode — a
 * live sandbox with fictional data that resets periodically, and a single
 * unobtrusive link to cogeto.eu. No signup prompts anywhere. Fixed to the bottom
 * so it never shifts page layout; pointer-events pass through except the link.
 */
export function DemoBanner() {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center">
      <div className="pointer-events-auto mb-3 flex items-center gap-2 rounded-full border border-slate-200 bg-white/95 px-4 py-1.5 text-xs text-slate-500 shadow-sm backdrop-blur">
        <span className="inline-block h-2 w-2 rounded-full bg-brand-teal" aria-hidden />
        <span>
          Live sandbox · <span className="font-medium text-slate-600">Ana Kovač</span> · fictional
          data, resets periodically
        </span>
        <span className="text-slate-300">·</span>
        <a
          href="https://cogeto.eu"
          target="_blank"
          rel="noreferrer"
          className="font-semibold text-brand-teal hover:underline"
        >
          Learn more
        </a>
      </div>
    </div>
  );
}
