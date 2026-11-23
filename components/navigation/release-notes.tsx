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
        render={<Button variant="link" className="min-h-11 px-0" />}
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
            Проверка длинных текстов по частям с указанием охвата, замечаниями и
            ссылками на утверждённые источники.
          </li>
          <li>
            Понятнее шаги редактора и «Моей работы». Подробные настройки и
            прежние функции сохранены.
          </li>
          <li>
            Удобнее помощник: примеры вопросов и обновлённое окно разговора.
          </li>
          <li>
            Аккуратнее показатели кампуса, мобильная вёрстка и движение
            контуров.
          </li>
        </ul>
      </DialogContent>
    </Dialog>
  );
}
