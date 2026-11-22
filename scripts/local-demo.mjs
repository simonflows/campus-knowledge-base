import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { require as requireTs } from "tsx/cjs/api";

export async function startDemoDatabase(root, tools, data) {
  const java =
    process.env.CAMPUS_DEMO_JAVA || path.join(tools, "jdk", "bin", "java.exe");
  const dynamo =
    process.env.CAMPUS_DEMO_DYNAMODB || path.join(tools, "dynamodb");
  const jar = path.join(dynamo, "DynamoDBLocal.jar");
  const nativeLibraries = path.join(dynamo, "DynamoDBLocal_lib");
  if (
    ![java, jar, nativeLibraries].every(
      (file) => path.isAbsolute(file) && fs.existsSync(file)
    )
  ) {
    throw new Error(
      "Нужны JDK 21 и DynamoDB Local 3.3.2. См. README.md, «Быстрый запуск на Windows»."
    );
  }

  fs.mkdirSync(data, { recursive: true });
  const javaEnv = {
    SystemRoot: process.env.SystemRoot,
    Path: process.env.Path,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    USERPROFILE: process.env.USERPROFILE,
  };
  const child = spawn(
    java,
    [
      `-Djava.library.path=${nativeLibraries}`,
      "-cp",
      jar,
      path.join(root, "scripts", "LocalDemoDynamo.java"),
      data,
    ],
    {
      cwd: root,
      env: javaEnv,
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
    }
  );
  child.stdin.on("error", () => {});
  const closed = new Promise((resolve) => child.once("close", resolve));
  const stop = async () => {
    child.stdin.end();
    await closed;
  };

  try {
    const port = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () =>
        reject(new Error("DynamoDB Local завершилась до запуска."))
      );
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        const match = /^CAMPUS_DEMO_DB_PORT=([1-9][0-9]*)$/.exec(line);
        if (match) resolve(Number(match[1]));
        else console.log(line);
      });
    });
    return { endpoint: `http://127.0.0.1:${port}`, closed, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

const credentials = {
  accessKeyId: "CampusDemoLocal",
  secretAccessKey: "CampusDemoLocal",
};

export async function initializeDemoDatabase(endpoint) {
  const { ensureLocalDemoTables, seedLocalDemoCorpus } = requireTs(
    "./init-local-demo.ts",
    import.meta.url
  );
  const client = new DynamoDBClient({
    endpoint,
    region: "us-east-1",
    credentials,
  });
  try {
    await ensureLocalDemoTables(client);
    await seedLocalDemoCorpus(client);
  } finally {
    client.destroy();
  }
}

export async function runFullDemo(root, nextBin, url, onLaunch) {
  if (process.platform !== "win32" || !process.env.LOCALAPPDATA) {
    throw new Error("Этот пункт предназначен для Windows.");
  }
  const tools = path.join(process.env.LOCALAPPDATA, "CampusKnowledgeDemoTools");
  const data = path.join(process.env.LOCALAPPDATA, "CampusKnowledgeDemoData");
  const database = await startDemoDatabase(root, tools, data);
  try {
    await initializeDemoDatabase(database.endpoint);
    const env = {
      ...process.env,
      NODE_ENV: "development",
      NEXT_TELEMETRY_DISABLED: "1",
      CAMPUS_FULL_LOCAL_DEMO: "true",
      CAMPUS_DEMO_LOGIN: "true",
      CAMPUS_LOCAL_DEMO: "false",
      CAMPUS_PILOT_ACCOUNTS: "",
      CAMPUS_PUBLIC_ORIGIN: url,
      SESSION_SECRET: randomBytes(32).toString("hex"),
      ADMIN_ACCESS_PIN: "",
      USE_DATABASE: "true",
      DOCUMENT_API_ENDPOINT: database.endpoint,
      DOCUMENT_API_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: credentials.accessKeyId,
      AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
      YANDEX_AI_STUDIO_API_KEY: "",
      YANDEX_AI_STUDIO_FOLDER_ID: "",
      YANDEX_DISK_OAUTH_TOKEN: "",
      ALIBABA_DASHSCOPE_API_KEY: "",
      NEXT_PUBLIC_DEMO_MODE: "false",
      BASE_PATH: "",
      OUTPUT_MODE: "",
    };
    console.log(`\nЗапускаю полное локальное демо на ${url}\nДанные: ${data}`);
    const { hostname, port } = new URL(url);
    const app = spawn(
      process.execPath,
      [nextBin, "dev", "-H", hostname, "-p", port],
      { cwd: root, stdio: "inherit", env }
    );
    const appFinished = new Promise((resolve, reject) => {
      app.once("error", reject);
      app.once("close", (code) => resolve(code ?? 1));
    });
    onLaunch?.(url);
    try {
      return await Promise.race([
        appFinished,
        database.closed.then(() => {
          throw new Error("DynamoDB Local завершилась.");
        }),
      ]);
    } finally {
      if (app.exitCode === null && app.signalCode === null) app.kill();
    }
  } finally {
    await database.stop();
  }
}
