export function sanitizeTextForDisplay(text: string): string {
  return text
    .replace(
      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
      "[контакт скрыт]"
    )
    .replace(
      /(?:\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/g,
      "[контакт скрыт]"
    );
}
