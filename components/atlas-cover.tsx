import type { ReactNode } from "react";

export function AtlasCover({
  children,
  links,
}: {
  children: ReactNode;
  links: ReactNode;
}) {
  return (
    <section className="atlas-hero hero" aria-labelledby="campus-title">
      <div className="wrap atlas-wrap">
        <div className="atlas-hero-main">{children}</div>
        <nav className="atlas-scene" aria-label="Материалы и сервисы кампуса">
          {links}
        </nav>
      </div>
    </section>
  );
}
