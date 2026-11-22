export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NODE_ENV === "production" &&
      process.env.CANON_DISK_RECOVERY === "true") {
    const { startDiskRecovery } = await import("./lib/disk-recovery");
    startDiskRecovery();
  }
}
