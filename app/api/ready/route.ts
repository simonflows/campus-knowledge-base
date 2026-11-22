import { isRuntimeStorageReady } from "@/lib/deploy-storage";

export const dynamic = "force-dynamic";

export async function GET() {
  const ready = await isRuntimeStorageReady();
  return Response.json(
    { status: ready ? "ready" : "unavailable" },
    { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } }
  );
}
