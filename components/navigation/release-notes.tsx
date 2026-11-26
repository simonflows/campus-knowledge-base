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
            Вход через Яндекс: собственные статьи и инструменты автора доступны
            после входа. Права на карточки и согласования выдаёт координатор.
          </li>
          <li>
            Фильтры остаются в выбранной папке вуза. Категории отличаются
            значками, а выбор сохраняется при возврате к списку.
          </li>
          <li>
            В помощнике появился отдельный поиск в интернете с предупреждением
            и внешними источниками. Ответы по базе ссылаются на утверждённые версии.
          </li>
          <li>
            В учебных текстах есть корректный пример из действующих карточек.
            Уточнены запросы, контуры и проверка обязательных согласований.
          </li>
          <li>
            Обновлены состояния поиска и работы ИИ, кнопки и закреплённая шапка.
            Учитывается настройка уменьшения движения.
          </li>
        </ul>
      </DialogContent>
    </Dialog>
  );
}
