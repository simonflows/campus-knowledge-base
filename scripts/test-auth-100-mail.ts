import assert from "node:assert/strict";
import { test } from "node:test";
import nodemailer from "nodemailer";
import { accountMailboxReady, sendAccountEmail } from "../lib/account-email";

test("Yandex SMTP waits for valid transport settings and sends the same-origin proof through TLS", async () => {
  process.env.CAMPUS_EMAIL_PROVIDER = "yandex-smtp";
  process.env.CAMPUS_PUBLIC_ORIGIN = "https://canon.example.test";
  process.env.CAMPUS_SMTP_USER = "mailer@example.test";
  delete process.env.CAMPUS_SMTP_APP_PASSWORD;
  assert.equal(await accountMailboxReady(), false);
  process.env.CAMPUS_SMTP_APP_PASSWORD = "test-only";

  const options: unknown[] = [];
  const messages: Array<{ from: string; to: string; subject: string; text: string }> = [];
  const original = nodemailer.createTransport;
  let probes = 0;
  nodemailer.createTransport = ((settings: unknown) => {
    options.push(settings);
    return {
      async verify() { probes++; return true; },
      async sendMail(message: (typeof messages)[number]) { messages.push(message); },
    };
  }) as typeof nodemailer.createTransport;
  try {
    assert.deepEqual(await Promise.all([accountMailboxReady(), accountMailboxReady()]), [true, true]);
    assert.equal(probes, 1);
    assert.equal(messages.length, 0);
    await sendAccountEmail({ email: "reader@example.test", purpose: "verify", token: "fixture-proof" });
    assert.equal(messages[0].from, "mailer@example.test");
    assert.equal(messages[0].to, "reader@example.test");
    assert.match(messages[0].text, /https:\/\/canon\.example\.test\/login\?account=verify#fixture-proof/);
    for (const option of options) {
      assert.equal((option as { host: unknown }).host, "smtp.yandex.ru");
      assert.equal((option as { port: unknown }).port, 465);
      assert.equal((option as { secure: unknown }).secure, true);
      assert.equal((option as { logger: unknown }).logger, false);
    }
  } finally {
    nodemailer.createTransport = original;
  }
});
