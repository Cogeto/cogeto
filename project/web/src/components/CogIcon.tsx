/**
 * The settings cog: a real eight-tooth gear, one definition used everywhere a
 * settings door renders (the navbar's instance-settings button, the
 * switcher's space-settings row, the instance area's settings section). The
 * previous glyph radiated spokes from a circle and read as a sun at small
 * sizes; teeth on the perimeter are what make a gear a gear. Same family
 * rules as the Nav icon set: 20px viewBox, 1.6 stroke, currentColor.
 */
export function CogIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10.47 3.32 11.98 1.43 14 2.16 13.94 4.58 15.06 5.6 17.46 5.34 18.37 7.28 16.62 8.95 16.68 10.47 18.57 11.98 17.84 14 15.42 13.94 14.4 15.06 14.66 17.46 12.72 18.37 11.05 16.62 9.53 16.68 8.02 18.57 6 17.84 6.06 15.42 4.94 14.4 2.54 14.66 1.63 12.72 3.38 11.05 3.32 9.53 1.43 8.02 2.16 6 4.58 6.06 5.6 4.94 5.34 2.54 7.28 1.63 8.95 3.38Z" />
      <circle cx="10" cy="10" r="2.9" />
    </svg>
  );
}
