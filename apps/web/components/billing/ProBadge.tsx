/** Small "PRO" tag on tools that need the Pro plan. */
export function ProBadge({ className = "absolute right-0.5 top-0.5" }: { className?: string }) {
  return (
    <span className={`${className} rounded bg-amber-100 px-1 py-px text-[9px] font-bold leading-tight tracking-wide text-amber-900`}>
      PRO
    </span>
  );
}
