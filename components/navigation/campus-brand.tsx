import { cn } from "@/lib/utils";

export function CampusMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 40 40"
      fill="none"
      className={cn("atlas-mark-svg", className)}
    >
      <rect width="40" height="40" rx="9" fill="#102c3c" />
      <path
        className="atlas-mark-peaks"
        d="M6 25 15.5 11l5.2 7.6L25 12l9 13-8-4-6 5-6-5z"
        fill="#f6a273"
      />
      <path
        className="atlas-mark-wave"
        d="m6 28 9-3.5 5 4 5-4 9 3.5-9-.5-5 4-5-4z"
        fill="#f4f2e7"
      />
    </svg>
  );
}

export function CampusBrand() {
  return (
    <span className="atlas-brand">
      <CampusMark />
      <span>
        <strong>Южный Урал</strong>
        <small>Справочник кампуса</small>
      </span>
    </span>
  );
}
