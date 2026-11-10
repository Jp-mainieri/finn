/** Finn mark: rising rounded bars (voice level) with the fin notch. Single color via currentColor. */
const MARK_PATH =
  "M244 1393A33 33 0 0 1 310 1393V1459A33 33 0 0 1 244 1459ZM350 1293A33 33 0 0 1 416 1293V1459A33 33 0 0 1 350 1459ZM456 1188A33 33 0 0 1 522 1188V1459A33 33 0 0 1 456 1459ZM562 1070A33 33 0 0 1 628 1070V1459A33 33 0 0 1 562 1459ZM668 951A33 33 0 0 1 734 951V1459A33 33 0 0 1 668 1459ZM774 838A33 33 0 0 1 840 838V1459A33 33 0 0 1 774 1459ZM880 749A33 33 0 0 1 946 749V1459A33 33 0 0 1 880 1459ZM985 667A33 33 0 0 1 1051 667V1459A33 33 0 0 1 985 1459ZM1091 603A33 33 0 0 1 1157 603V1459A33 33 0 0 1 1091 1459ZM1197 548A33 33 0 0 1 1263 548V1459A33 33 0 0 1 1197 1459ZM1302 501A33 33 0 0 1 1368 501V790A535 535 0 0 0 1368 1080V1459A33 33 0 0 1 1302 1459ZM1408 676V485Q1408 440 1452 440Q1497 440 1497 482Q1497 492 1490 505ZM1408 1178Q1440 1225 1475 1252V1459A33 33 0 0 1 1408 1459ZM1514 1378A33 33 0 0 1 1580 1378V1459A33 33 0 0 1 1514 1459ZM1620 1426A33 33 0 0 1 1686 1426V1459A33 33 0 0 1 1620 1459Z";

export function FinnMark({ className = "h-8 w-auto" }: { className?: string }) {
  return (
    <svg viewBox="244 440 1443 1052" fill="currentColor" aria-hidden="true" className={className}>
      <path d={MARK_PATH} />
    </svg>
  );
}

export function FinnWordmark({ size = "md" }: { size?: "md" | "lg" }) {
  const lg = size === "lg";
  return (
    <span className={`inline-flex items-center ${lg ? "gap-4" : "gap-3"} text-accent-ink`}>
      <FinnMark className={lg ? "h-14 w-auto" : "h-8 w-auto"} />
      <span className={`${lg ? "text-5xl" : "text-2xl"} font-semibold tracking-tight text-foreground`}>Finn</span>
    </span>
  );
}
