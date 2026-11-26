import nodemailer from "nodemailer";
import { z } from "zod";
import type { AccountMessage } from "./account-service";
import { getMetadataIamToken, readYandexJson } from "./yandex-metadata-iam";

const postboxOrigin = "https://postbox.cloud.yandex.net";
function mailSettings() {
  let origin: string;
  try {
    const url = new URL(process.env.CAMPUS_PUBLIC_ORIGIN ?? "");
    if (url.protocol !== "https:" || url.username || url.password) return null;
    origin = url.origin;
  } catch {
    return null;
  }

  if (process.env.CAMPUS_EMAIL_PROVIDER === "yandex-smtp") {
    const sender = z.email().safeParse(process.env.CAMPUS_SMTP_USER?.trim());
    const password = process.env.CAMPUS_SMTP_APP_PASSWORD?.trim();
    if (!sender.success || !password) return null;
    return { kind: "smtp" as const, origin, sender: sender.data, password };
  }
  if (process.env.CAMPUS_EMAIL_PROVIDER !== "postbox") return null;
  const sender = z.email().safeParse(process.env.CAMPUS_POSTBOX_FROM?.trim());
  const token = process.env.CAMPUS_POSTBOX_IAM_TOKEN?.trim();
  const metadata = process.env.CAMPUS_POSTBOX_USE_METADATA === "true";
  if (!sender.success || (!metadata && !token)) return null;
  const identity = process.env.CAMPUS_POSTBOX_IDENTITY?.trim() || sender.data.split("@").at(-1)!;
  return { kind: "postbox" as const, origin, sender: sender.data, identity, token, metadata };
}

type MailSettings = NonNullable<ReturnType<typeof mailSettings>>;
type SmtpSettings = Extract<MailSettings, { kind: "smtp" }>;
type PostboxSettings = Extract<MailSettings, { kind: "postbox" }>;

function smtpTransport(settings: SmtpSettings) {
  return nodemailer.createTransport({
    host: "smtp.yandex.ru",
    port: 465,
    secure: true,
    auth: { user: settings.sender, pass: settings.password },
    connectionTimeout: 4000,
    greetingTimeout: 4000,
    socketTimeout: 8000,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
}

async function postboxToken(settings: PostboxSettings) {
  return settings.metadata ? getMetadataIamToken() : settings.token!;
}

const readinessSchema = z.object({
  VerifiedForSendingStatus: z.boolean(),
  DkimAttributes: z.object({ Status: z.string() }),
});
async function probePostbox(settings: PostboxSettings) {
  const iam = await postboxToken(settings);
  const url = postboxOrigin + "/v2/email/identities/" + encodeURIComponent(settings.identity);
  const signal = AbortSignal.timeout(3500);
  const response = await fetch(url, {
    cache: "no-store",
    redirect: "error",
    signal,
    headers: { "X-YaCloud-SubjectToken": iam },
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return false;
  }
  const result = readinessSchema.safeParse(await readYandexJson(response, 16_384, signal));
  return result.success && result.data.VerifiedForSendingStatus && result.data.DkimAttributes.Status === "SUCCESS";
}

let mailboxStatus: { key: string; expiresAt: number; ready: boolean } | undefined;
let mailboxProbe: Promise<boolean> | undefined;

export async function accountMailboxReady() {
  const settings = mailSettings();
  if (!settings) return false;
  const key = [settings.kind, settings.sender, settings.kind === "postbox" ? settings.identity : ""].join(":");
  if (mailboxStatus?.key === key && mailboxStatus.expiresAt > Date.now()) return mailboxStatus.ready;
  if (!mailboxProbe) mailboxProbe = (async () => {
    let ready = false;
    try {
      ready = settings.kind === "smtp"
        ? await smtpTransport(settings).verify()
        : await probePostbox(settings);
    } catch {
      // Return the same readiness result for every recipient.
    }
    mailboxStatus = { key, ready, expiresAt: Date.now() + (ready ? 120_000 : 20_000) };
    return ready;
  })().finally(() => { mailboxProbe = undefined; });
  return mailboxProbe;
}

export async function sendAccountEmail({ email, purpose, token }: AccountMessage) {
  const settings = mailSettings();
  if (!settings) throw new Error("Account mail is not configured");
  const verification = purpose === "verify";
  const link = new URL(settings.origin);
  link.pathname = (process.env.BASE_PATH || "") + "/login";
  link.searchParams.set("account", purpose);
  link.hash = token;
  const subject = verification ? "Подтвердите адрес для Канона" : "Новый пароль для Канона";
  const text = [
    verification ? "Откройте ссылку и задайте пароль для входа в Канон." : "Откройте ссылку, чтобы задать новый пароль в Каноне.",
    link.href,
    verification ? "Ссылка действует 24 часа." : "Ссылка действует 30 минут.",
    "Если вы не запрашивали это письмо, его можно проигнорировать.",
  ].join("\n\n");

  if (settings.kind === "smtp") {
    try {
      await smtpTransport(settings).sendMail({ from: settings.sender, to: email, subject, text });
    } catch {
      mailboxStatus = undefined;
      throw new Error("SMTP delivery rejected");
    }
    return;
  }

  const iam = await postboxToken(settings);
  const response = await fetch(postboxOrigin + "/v2/email/outbound-emails", {
    method: "POST",
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(5500),
    headers: {
      "Content-Type": "application/json",
      "X-YaCloud-SubjectToken": iam,
    },
    body: JSON.stringify({
      FromEmailAddress: settings.sender,
      Destination: { ToAddresses: [email] },
      Content: {
        Simple: {
          Subject: { Charset: "UTF-8", Data: subject },
          Body: { Text: { Charset: "UTF-8", Data: text } },
        },
      },
    }),
  });
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok) {
    mailboxStatus = undefined;
    throw new Error("Postbox delivery rejected");
  }
}
