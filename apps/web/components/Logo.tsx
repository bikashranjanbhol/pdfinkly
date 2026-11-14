import Link from "next/link";

const NIB = "M12 10A6 6 0 0 1 18 4H39L52 17V33.6Q52 35 51.1 36.1L33.7 58.3Q32 60.5 30.3 58.3L12.9 36.1Q12 35 12 33.6Z";
const FOLD = "M40.5 8.6V13.5A2 2 0 0 0 42.5 15.5H47.4Z";

/** The PDFInkly nib mark. On white backgrounds the cutouts are painted white. */
export function Mark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="2 2.2 60 60" aria-hidden="true" className={className}>
      <path d={NIB} fill="#2563EB" />
      <path d={FOLD} fill="#FFFFFF" />
      <circle cx="32" cy="37.2" r="4.6" fill="#FFFFFF" />
      <rect x="30.7" y="37.2" width="2.6" height="24" fill="#FFFFFF" />
    </svg>
  );
}

export function Logo({ href = "/", size = 32 }: { href?: string; size?: number }) {
  return (
    <Link href={href} className="flex items-center gap-2 text-ink no-underline" aria-label="PDFInkly home">
      <Mark size={size} />
      <span className="font-display text-xl font-bold tracking-tight">
        PDF<span className="text-brand-600">Inkly</span>
      </span>
    </Link>
  );
}
