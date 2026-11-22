"use client";

import { useWorkspaceRequest } from "@/components/demo/workspace-transport";

import { useEffect, useRef, useState } from "react";
import { Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { updateInformationRequestSchema, type InformationRequest } from "@/lib/information-requests";
import type { SessionUser } from "@/lib/auth";

type Person = { id: string; name: string };
type Draft = { responsibleId: string; dueDate: string; revision: number };
export function RequestFollowup({ item, user, available, onUpdated }: { item: InformationRequest; user: SessionUser; available: boolean; onUpdated: (item: InformationRequest) => void }) {
  const workspaceRequest = useWorkspaceRequest();
  const [people, setPeople] = useState<Person[]>([]), [participants, setParticipants] = useState<Person[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null), [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false), [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const operation = useRef<{ signature: string; id: string } | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    void workspaceRequest(`/api/requests/${encodeURIComponent(item.id)}`, { signal: abort.signal, cache: "no-store" }).then(async response => {
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (!abort.signal.aborted) { setPeople(data.people); setParticipants(data.participants); setLoadError(false); }
    }).catch(() => { if (!abort.signal.aborted) setLoadError(true); });
    return () => abort.abort();
  }, [item.id, item.revision, reload, workspaceRequest]);
  const form = draft ?? { responsibleId: item.responsibleId ?? "", dueDate: item.dueDate ?? "", revision: item.revision };
  const joined = (item.participantIds ?? [item.authorId]).includes(user.id);
  const change = (fields: Partial<Draft>) => { setDraft({ ...form, ...fields }); operation.current = null; };
  async function mutate(action: "assign" | "join" | "leave") {
    if (busy) return;
    const values = action === "assign" ? { responsibleId: form.responsibleId || null, dueDate: form.dueDate || null } : {};
    const revision = action === "assign" ? form.revision : item.revision;
    const signature = JSON.stringify({ action, revision, ...values });
    if (operation.current?.signature !== signature) operation.current = { signature, id: crypto.randomUUID() };
    const parsed = updateInformationRequestSchema.safeParse({ action, revision, ...values, operationId: operation.current.id });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? "Проверьте поля"); return; }
    setBusy(true); setError("");
    try {
      const response = await workspaceRequest(`/api/requests/${item.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(parsed.data) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Не удалось сохранить сведения запроса");
      if (action === "assign") setDraft(null);
      operation.current = null; onUpdated(data);
      toast.success(action === "assign" ? "Ответственный и срок сохранены" : action === "join" ? "Результат появится в вашей работе" : "Вы больше не следите за запросом");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Не удалось сохранить. Повторите попытку"); }
    finally { setBusy(false); }
  }
  const options = [{ value: "none", label: "Не назначен" }, ...people.map(person => ({ value: person.id, label: person.name }))];
  return (
    <section aria-label="Участники и срок запроса" className="flex flex-col gap-4 border-b border-border pb-5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-2 text-sm"><Users size={16} aria-hidden="true" /> Следят за запросом: {(item.participantIds ?? [item.authorId]).length}</span>
        {user.id !== item.authorId && <Button size="sm" variant="outline" disabled={busy || !available || draft !== null} onClick={() => void mutate(joined ? "leave" : "join")}>{joined ? "Не следить" : "Мне тоже нужен ответ"}</Button>}
      </div>
      {participants.length > 0 && <p className="text-sm text-muted-foreground">{participants.map(person => person.name).join(", ")}. Присоединение сохраняет прежние границы доступа.</p>}
      <form onSubmit={event => { event.preventDefault(); void mutate("assign"); }}>
        <FieldGroup className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`request-person-${item.id}`}>Ответственный за ответ</FieldLabel>
            <Select items={options} value={form.responsibleId || "none"} onValueChange={value => { if (typeof value === "string") change({ responsibleId: value === "none" ? "" : value }); }} disabled={busy || !available || loadError}>
              <SelectTrigger id={`request-person-${item.id}`} className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectGroup>{options.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectGroup></SelectContent>
            </Select>
            <FieldDescription>Назначается сотрудник вуза-получателя.</FieldDescription>
          </Field>
          <Field><FieldLabel htmlFor={`request-due-${item.id}`}>Срок ответа</FieldLabel><Input id={`request-due-${item.id}`} type="date" value={form.dueDate} onChange={event => change({ dueDate: event.target.value })} disabled={busy || !available} /><FieldDescription>Если срок не назначен, напоминание о просрочке не создаётся.</FieldDescription></Field>
        </FieldGroup>
        {draft && <div className="mt-4 flex flex-wrap gap-2"><Button type="submit" size="sm" disabled={busy || !available || form.revision !== item.revision}>Сохранить срок и ответственного</Button><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => { setDraft(null); setError(""); operation.current = null; }}>Отменить изменения</Button></div>}
      </form>
      {form.revision !== item.revision && <Alert><AlertDescription>Запрос изменился после открытия полей. Ввод сохранён: сравните его с текущими сведениями и отмените редактирование, чтобы открыть свежую версию.</AlertDescription></Alert>}
      {loadError && <p role="status" className="text-sm text-muted-foreground">Не удалось загрузить участников. <Button variant="link" size="sm" onClick={() => setReload(value => value + 1)}>Повторить</Button></p>}
      {error && <Alert variant="destructive"><AlertDescription>{error} Обновите список запросов при конфликте; введённые поля останутся открытыми.</AlertDescription></Alert>}
    </section>
  );
}
