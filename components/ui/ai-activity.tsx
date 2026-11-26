import { LoaderCircle } from "lucide-react";

import { cn } from "@/lib/utils";
import styles from "./ai-activity.module.css";

export function AiActivity({
  label,
  detail,
  className,
  active = true,
}: {
  label: string;
  detail?: string;
  className?: string;
  active?: boolean;
}) {
  return (
    <div className={cn(styles.activity, active && styles.active, className)} role="status">
      {active && (
        <span className={styles.icon} aria-hidden="true">
          <LoaderCircle size={18} />
        </span>
      )}
      <span className={styles.copy}>
        <span>{label}</span>
        {detail && <span className={styles.detail}>{detail}</span>}
      </span>
    </div>
  );
}
