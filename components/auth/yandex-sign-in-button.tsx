import { Button } from "@/components/ui/button";
import styles from "./yandex-sign-in-button.module.css";

/** Yandex ID mark: official OAuth design assets, see release plan sources. */
export function YandexSignInButton() {
  return (
    <Button type="submit" className={styles.button} size="lg">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        focusable="false"
        data-icon="inline-start"
      >
        <path
          fill="currentColor"
          fillRule="evenodd"
          d="M7.67 19.14V4.96H5.19v14.18h2.48Zm8.21-13.81a8.77 8.77 0 0 0-2.62-.37H9.92v14.2h3.13c.97 0 1.9-.17 2.72-.48a5.8 5.8 0 0 0 2.14-1.38 6.3 6.3 0 0 0 1.4-2.24c.33-.9.5-1.92.5-3.08 0-1.31-.15-2.41-.5-3.3a5.55 5.55 0 0 0-1.37-2.16 5.67 5.67 0 0 0-2.07-1.19Zm-1.2 11.55a4.9 4.9 0 0 1-1.83.34v-.02h-.44V6.86h.65c.64 0 1.22.08 1.73.26.53.17.97.46 1.35.85.38.39.67.92.87 1.56.21.65.31 1.45.31 2.4 0 .88-.12 1.65-.33 2.31a4.66 4.66 0 0 1-.91 1.65c-.4.42-.86.77-1.41.99Z"
        />
      </svg>
      Войти с Яндекс ID
    </Button>
  );
}
