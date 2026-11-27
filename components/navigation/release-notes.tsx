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
            Мягкий рельеф на фоне всей страницы: контуры медленно движутся,
            а при проверке текста и работе ИИ фон деликатно меняется.
          </li>
          <li>
            Проверка фактов сохраняет результат при переносах строк,
            изменении пробелов, списках и перестановке отдельных утверждений.
            Различия в цифрах и смысле по-прежнему учитываются.
          </li>
          <li>
            Помощник плавно открывается и закрывается. Вопросы и ответы
            появляются мягко, а запросы отправляются сразу.
          </li>
          <li>
            Значки категорий в дереве и карточках приведены к единой системе.
            Живые рельефные линии появились в заголовках разделов.
          </li>
          <li>
            Обновлены кнопка Яндекс ID и переходы окон. Публичный демо-режим
            завершён. Все новые эффекты учитывают уменьшение движения.
          </li>
        </ul>
      </DialogContent>
    </Dialog>
  );
}
