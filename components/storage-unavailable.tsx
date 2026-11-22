import { storageUnavailableMessage } from "@/lib/runtime-storage-policy";

export function StorageUnavailable({ title }: { title: string }) {
  return (
    <section className="wrap atlas-wrap py-12">
      <h1>{title}</h1>
      <p role="status">{storageUnavailableMessage}</p>
    </section>
  );
}
