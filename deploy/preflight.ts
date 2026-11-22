import { sessionDirectory } from "../lib/pilot-auth";

const environment = process.env;
const errors: string[] = [];
const requiredFlags = {
  NODE_ENV: "production",
  NEXT_PUBLIC_DEMO_MODE: "false",
  CAMPUS_DEMO_LOGIN: "false",
  CAMPUS_LOCAL_DEMO: "false",
  CAMPUS_FULL_LOCAL_DEMO: "false",
  SEED_DEMO_ARTICLES: "false",
  USE_DATABASE: "true",
};

for (const [name, value] of Object.entries(requiredFlags)) {
  if (environment[name] !== value) {
    errors.push(`${name} должен быть равен ${value}`);
  }
}

if (environment.OUTPUT_MODE === "export") {
  errors.push("OUTPUT_MODE=export отключает работу сервера с общей базой");
}

function parseHttpsUrl(value: string | undefined) {
  const url = URL.parse(value ?? "");
  if (url?.protocol === "https:" && !url.username && !url.password) return url;
  return null;
}

const origin = parseHttpsUrl(environment.CAMPUS_PUBLIC_ORIGIN);
if (!origin || origin.origin !== environment.CAMPUS_PUBLIC_ORIGIN) {
  errors.push(
    "CAMPUS_PUBLIC_ORIGIN должен содержать внешний HTTPS-адрес без пути"
  );
}

const endpoint = parseHttpsUrl(environment.DOCUMENT_API_ENDPOINT);
if (!endpoint || endpoint.search || endpoint.hash) {
  errors.push(
    "DOCUMENT_API_ENDPOINT должен содержать HTTPS-адрес базы без учётных данных, запроса и фрагмента"
  );
}

for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]) {
  if (!environment[name]?.trim()) errors.push(`${name} отсутствует`);
}

if ((environment.SESSION_SECRET?.trim().length ?? 0) < 32) {
  errors.push("SESSION_SECRET должен содержать не менее 32 символов");
}

if (environment.CAMPUS_DEMO_LOGIN !== "true" && !sessionDirectory().length) {
  errors.push(
    "CAMPUS_PILOT_ACCOUNTS должен содержать непустой JSON-справочник с действующими профилями и уникальными логинами и отпечатками"
  );
}

if (errors.length) {
  console.error("Запуск пилота остановлен. Проверьте настройки:");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log("Настройки запуска пилота проверены.");
}
