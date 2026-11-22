import type { ReactNode } from "react";
import { UralTopography } from "@/components/motion/ural-topography";

export function AtlasCover({
  children,
  links,
}: {
  children: ReactNode;
  links: ReactNode;
}) {
  return (
    <section
      className="atlas-hero atlas-hero--topography hero"
      aria-labelledby="campus-title"
    >
      <UralTopography />
      <div className="wrap atlas-wrap">
        <div className="atlas-hero-main">{children}</div>
        <nav className="atlas-scene" aria-label="Материалы и сервисы кампуса">
          {links}
        </nav>
      </div>
    </section>
  );
}
