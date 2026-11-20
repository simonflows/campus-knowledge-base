import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { AnimatedNumber } from "@/components/motion/animated-number";
import styles from "./workspace-masthead.module.css";

type MastheadProps = {
  id: string;
  icon: LucideIcon;
  title: string;
  description: string;
  note?: ReactNode;
  children?: ReactNode;
  access?: boolean;
};

export function WorkspaceMasthead({
  id,
  icon: Icon,
  title,
  description,
  note,
  children,
  access = false,
}: MastheadProps) {
  return (
    <header
      className={styles.masthead}
      data-layout={access ? "access" : undefined}
      aria-labelledby={id}
    >
      <div className={styles.art} aria-hidden="true">
        <span className={styles.contours} />
      </div>
      <div className={styles.identity}>
        <span className={styles.icon} aria-hidden="true">
          <Icon strokeWidth={1.65} />
        </span>
        <h1 className={styles.title} id={id}>
          {title}
        </h1>
        <p className={styles.description}>{description}</p>
        {note && <div className={styles.note}>{note}</div>}
      </div>
      {children && <div className={styles.aside}>{children}</div>}
    </header>
  );
}

export function MastheadCount({
  count,
  label,
  children,
}: {
  count: number;
  label: string;
  children?: ReactNode;
}) {
  return (
    <div className={styles.metric}>
      <strong>
        <AnimatedNumber value={count} />
      </strong>
      <span>{label}</span>
      {children}
    </div>
  );
}
