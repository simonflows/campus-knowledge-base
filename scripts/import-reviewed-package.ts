import { readFile } from "node:fs/promises";
import { docClient } from "../lib/db";
import {
  importReviewedPackage,
  ReviewedPackageError,
} from "../lib/reviewed-package-import";

async function main() {
  const [packageFile, verificationFile, ...flags] = process.argv.slice(2);
  const apply = flags.includes("--apply");
  const sync = flags.includes("--sync");
  if (
    !packageFile ||
    !verificationFile ||
    packageFile.startsWith("-") ||
    verificationFile.startsWith("-") ||
    flags.some((flag) => !["--apply", "--sync"].includes(flag)) ||
    new Set(flags).size !== flags.length
  ) {
    console.error(JSON.stringify({ status: "invalid-arguments" }));
    process.exitCode = 1;
    return;
  }
  if (sync && !apply) throw new ReviewedPackageError("sync-requires-apply");

  const [bytes, proofBytes] = await Promise.all([
    readFile(packageFile).catch(() => null),
    readFile(verificationFile).catch(() => null),
  ]);
  if (!bytes || !proofBytes) {
    console.error(JSON.stringify({ status: "input-unreadable" }));
    process.exitCode = 1;
    return;
  }
  let verification: unknown;
  try {
    verification = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(proofBytes)
    );
  } catch {
    throw new ReviewedPackageError("invalid-verification");
  }
  const result = await importReviewedPackage(bytes, verification, {
    apply,
    sync,
  });
  console.log(JSON.stringify(result));
  if (
    apply &&
    (result.writeFailed || result.conflicts || result.syncUnresolved)
  )
    process.exitCode = 2;
}

main()
  .catch((error: unknown) => {
    const result =
      error instanceof ReviewedPackageError
        ? { status: error.code, ...(error.cardId && { id: error.cardId }) }
        : { status: "import-failed" };
    console.error(JSON.stringify(result));
    process.exitCode = 1;
  })
  .finally(() => docClient.destroy());
