import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";

const ROOT = process.cwd();
const DEFAULT_PORT = 8080;
const MAX_PORT = 8080;
const FULL_DEMO_HOST = "127.0.0.3";
const IS_DRY_RUN = process.argv.includes("--dry-run");
const NEXT_BIN = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");

function checkPortFree(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

async function launchFullDemo() {
  const url = `http://${FULL_DEMO_HOST}:${DEFAULT_PORT}`;
  const showBrowser = !process.argv.includes("--no-browser");
  if (!(await checkPortFree(DEFAULT_PORT, FULL_DEMO_HOST))) {
    let existingDemo = false;
    try {
      const response = await fetch(`${url}/api/health`, {
        redirect: "error",
        signal: AbortSignal.timeout(1_500),
      });
      existingDemo =
        response.ok && response.headers.get("X-Campus-Full-Local-Demo") === "1";
    } catch {
      // An unrelated listener may not respond to HTTP.
    }
    if (existingDemo) {
      console.log(`Полное локальное демо уже работает на ${url}.`);
      if (showBrowser) openBrowser(url);
      return 0;
    }
    throw new Error(
      `Адрес ${FULL_DEMO_HOST}:${DEFAULT_PORT} занят. Возможно, полное демо уже запущено.`
    );
  }
  const { runFullDemo } = await import("./local-demo.mjs");
  return runFullDemo(
    ROOT,
    NEXT_BIN,
    url,
    showBrowser ? openBrowserWhenReady : undefined
  );
}

async function findFreePort(
  startPort = DEFAULT_PORT,
  maxPort = MAX_PORT,
  host
) {
  for (let port = startPort; port <= maxPort; port += 1) {
    if (await checkPortFree(port, host)) {
      return port;
    }
  }
  throw new Error(
    `Порт ${startPort} занят. Освободите его или используйте уже работающий сервер; другой порт не выбирается.`
  );
}

function runNpmSync(args) {
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmCmd, args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  return result.status ?? 1;
}

function runCommandSync(cmd, args, useShell = false) {
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: useShell,
  });
  return result.status ?? 1;
}

function checkDockerDataBeforeStart() {
  const lookup = spawnSync(
    "docker",
    ["ps", "-a", "--filter", "name=^/dynamodb-local$", "--format", "{{.ID}}"],
    { encoding: "utf8", windowsHide: true }
  );
  if (lookup.error || lookup.status !== 0)
    throw new Error(
      "Docker недоступен. Для полного запуска можно указать внешний DOCUMENT_API_ENDPOINT и выбрать [1]; отдельная установка DynamoDB на Windows не требуется."
    );
  const id = lookup.stdout.trim();
  if (!id) return;
  const inspected = spawnSync(
    "docker",
    ["inspect", "--format", "{{json .Mounts}}", id],
    { encoding: "utf8", windowsHide: true }
  );
  if (inspected.status !== 0)
    throw new Error(
      "Не удалось проверить сохранность контейнера DynamoDB; запуск остановлен без его изменения."
    );
  const mounts = JSON.parse(inspected.stdout);
  if (
    !mounts.some(
      (mount) =>
        mount.Type === "volume" &&
        mount.Name === "campus-knowledge-dynamodb-data" &&
        mount.Destination === "/home/dynamodblocal/data"
    )
  )
    throw new Error(
      "Найден прежний контейнер DynamoDB без нового долговечного тома. Он сохранён без изменений. Перед пересозданием выполните согласованный перенос по DEPLOY.md, раздел 9.4; новый пустой том не заменяет старые данные."
    );
}

function openBrowser(url) {
  if (process.platform === "win32") {
    const child = spawn("cmd.exe", ["/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } else if (process.platform === "darwin") {
    const child = spawn("open", [url], { detached: true, stdio: "ignore" });
    child.unref();
  } else {
    const child = spawn("xdg-open", [url], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }
}

function openBrowserWhenReady(url) {
  const deadline = Date.now() + 25_000;
  const poll = async () => {
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${url}/api/health`);
        if (res.ok) {
          openBrowser(url);
          return;
        }
      } catch {
        // Server is still booting; retry shortly.
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    openBrowser(url);
  };

  void poll();
}

function runNextServer(mode, port) {
  if (mode === "dev") process.env.CAMPUS_DEMO_LOGIN ??= "true";
  const url = `http://localhost:${port}`;
  console.log(`\nЗапускаю сервер (${mode}) на ${url} ...`);
  console.log("Для остановки нажмите Ctrl+C или закройте окно.\n");

  openBrowserWhenReady(url);

  if (fs.existsSync(NEXT_BIN)) {
    return runCommandSync(process.execPath, [
      NEXT_BIN,
      mode,
      "-H",
      "127.0.0.1",
      "-p",
      String(port),
    ]);
  }

  return runNpmSync(["run", mode === "start" ? "start" : "dev"]);
}

function ensureDependencies() {
  if (fs.existsSync(path.join(ROOT, "node_modules"))) {
    return true;
  }

  console.log(
    "[1/2] Папка node_modules не найдена — устанавливаю зависимости..."
  );
  const status = runNpmSync(["install"]);
  if (status !== 0) {
    console.error("[ОШИБКА] Не удалось установить зависимости npm.");
    return false;
  }
  return true;
}

function runAllChecks() {
  const steps = [
    { label: "[1/4] Регрессионные автотесты (npm test)...", args: ["test"] },
    {
      label: "[2/4] ESLint + TypeScript (npm run check)...",
      args: ["run", "check"],
    },
    { label: "[3/4] Проверка backlog...", args: ["run", "check:backlog"] },
    {
      label: "[4/4] Production-сборка (npm run build)...",
      args: ["run", "build"],
    },
  ];

  for (const step of steps) {
    console.log(`\n${step.label}`);
    const status = runNpmSync(step.args);
    if (status !== 0) {
      console.error(
        "\n[ОШИБКА] Проверка завершилась с ошибкой. Подробности выше."
      );
      return false;
    }
  }

  console.log("\n[OK] Все тесты, проверки и сборка прошли без единой ошибки!");
  return true;
}

async function main() {
  console.log(
    "===================================================================="
  );
  console.log(
    "  Справочник кампуса «Южный Урал» — Локальный запуск и проверка сервиса"
  );
  console.log(
    "====================================================================\n"
  );

  if (IS_DRY_RUN) {
    const port = await findFreePort(DEFAULT_PORT, MAX_PORT);
    console.log(`DRY-RUN OK: порт ${port} свободен, каталог проекта ${ROOT}`);
    process.exit(0);
  }

  if (!ensureDependencies()) {
    process.exit(1);
  }
  if (process.argv.includes("--full-demo")) {
    process.exit(await launchFullDemo());
  }

  const port = DEFAULT_PORT;
  console.log(
    "Выберите действие (или просто нажмите Enter для быстрого запуска):\n"
  );
  console.log(
    `  [1] Запустить сайт для проверки (http://localhost:${port}) [по умолчанию]`
  );
  console.log(
    `  [2] Собрать и запустить production-версию (npm run build + start на порту ${port})`
  );
  console.log(
    "  [3] Прогнать полную проверку кода (Тесты + ESLint + TypeScript + Build)"
  );
  console.log(
    "  [4] Показать имена переменных для подключения интеграций"
  );
  console.log(
    "  [5] Запустить в Docker с локальной БД DynamoDB/YDB (http://localhost:8080)"
  );
  console.log(
    "  [6] Явно включить локальное демо с сохранением .data/local-store.json"
  );
  console.log(
    `  [7] Полное локальное демо с DynamoDB, черновиками и запросами (http://${FULL_DEMO_HOST}:${port})\n`
  );
  if (fs.existsSync(path.join(ROOT, ".data", "local-store.json")))
    console.log(
      "Найдены сохранённые локальные данные: режим [6] продолжит работу с ними, не заменяя их примерами."
    );
  console.log(
    "Режимы [1]/[2] требуют Document API для записи. Без БД показываются примеры только для чтения.\n"
  );

  const rl = readline.createInterface({ input, output });
  let choice = "";
  try {
    choice = (await rl.question("Введите номер (1-7) [1]: ")).trim() || "1";
  } finally {
    rl.close();
  }

  if (choice === "7") {
    process.exit(await launchFullDemo());
  }

  if (choice !== "4") {
    await findFreePort(
      port,
      MAX_PORT,
      choice === "5" ? undefined : "127.0.0.1"
    );
  }

  if (choice === "6") {
    process.env.CAMPUS_LOCAL_DEMO = "true";
    console.log(
      "Локальное демо включено. Данные остаются в .data, повреждённый файл не сбрасывается. Совместная редактура/запросы требуют Document API."
    );
    process.exit(runNextServer("dev", port));
  }

  if (choice === "1") {
    process.exit(runNextServer("dev", port));
  }

  if (choice === "2") {
    console.log("\nВыполняю production-сборку...");
    const buildStatus = runNpmSync(["run", "build"]);
    if (buildStatus !== 0) {
      console.error("[ОШИБКА] Ошибка сборки проекта.");
      process.exit(buildStatus);
    }
    process.exit(runNextServer("start", port));
  }

  if (choice === "3") {
    if (!runAllChecks()) {
      process.exit(1);
    }

    const rlLaunch = readline.createInterface({ input, output });
    let launchAnswer = "";
    try {
      launchAnswer = (
        await rlLaunch.question(
          `\nЗапустить сайт на http://localhost:${port} прямо сейчас? (Y/n): `
        )
      )
        .trim()
        .toLowerCase();
    } finally {
      rlLaunch.close();
    }

    if (
      launchAnswer === "" ||
      launchAnswer === "y" ||
      launchAnswer === "yes" ||
      launchAnswer === "д"
    ) {
      process.exit(runNextServer("dev", port));
    }
    process.exit(0);
  }

  if (choice === "4") {
    process.exit(
      runCommandSync(process.execPath, [
        path.join(ROOT, "scripts", "setup-keys.mjs"),
      ])
    );
  }

  if (choice === "5") {
    checkDockerDataBeforeStart();
    console.log("\nЗапускаю Docker Compose (http://localhost:8080)...");
    process.exit(
      runCommandSync(
        "docker",
        ["compose", "up", "--build"],
        process.platform === "win32"
      )
    );
  }

  console.log(`Неизвестный выбор "${choice}", запускаю режим [1]...`);
  process.exit(runNextServer("dev", port));
}

main().catch((error) => {
  console.error("[ОШИБКА] Сбой лаунчера:", error);
  process.exit(1);
});
