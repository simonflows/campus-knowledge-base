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
            Исправлена сверка вместимости гостиниц и отдельных утверждённых
            фактов. Подтверждения видны рядом с замечаниями.
          </li>
          <li>
            После правки показана отдельная проверка нового текста с красными,
            жёлтыми и зелёными результатами.
          </li>
          <li>
            Помощник кратко отвечает по утверждённым данным. Полные цитаты и
            ссылки на версии доступны в ответе.
          </li>
          <li>
            Версия читается на тёмном фоне и не перекрывается помощником. Значки
            двух очередей гостиниц различаются.
          </li>
        </ul>
      </DialogContent>
    </Dialog>
  );
}
