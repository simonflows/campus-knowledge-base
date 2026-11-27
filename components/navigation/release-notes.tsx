"use client";

import { version } from "@/package.json";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export function ReleaseNotes() {
  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button
            variant="link"
            className="atlas-release-notes min-h-11 px-0"
          />
        }
      >
        Версия {version}
        <span className="sr-only"> — что нового</span>
      </DialogTrigger>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader className="pr-8">
          <DialogTitle>Канон {version}</DialogTitle>
          <DialogDescription>Что изменилось в этом выпуске</DialogDescription>
        </DialogHeader>
        <ul className="flex list-disc flex-col gap-3 pl-5 leading-relaxed">
          <li>
            Официальные документы: редакции, организация-источник, проверенные
            выдержки и направления в привычных карточках.
          </li>
          <li>
            Связь проектов и лабораторий со стратегией и дорожной картой: точные
            пункты, объяснение и подтверждение.
          </li>
          <li>
            Показатели с независимым подтверждением плана и факта. Значения
            сохраняют единицу, контур, дату и источник; неизвестное отличается
            от нуля.
          </li>
          <li>
            Аналитика по документу, пункту или направлению и безопасные
            источники редактора. При обновлении основания устаревшие значения
            требуют сверки.
          </li>
          <li>
            Живые полосы в заголовках и спокойный общий фон без узора. Только
            мягкий цвет при обработке, с учётом уменьшения движения.
          </li>
        </ul>
      </DialogContent>
    </Dialog>
  );
}
