# Канон — актуальный статус

**Работает 0.9.6/061e638**, healthy/ready200. Активная задача — UI-выпуск **0.9.7**, ветка `fix/kanon-096-demo-controls`, база main `a16b442`.

[Краткий контекст](docs/context-0.9.7.md) · [План](plan.md) · [Контракты предыдущего этапа](docs/followup-0.9.6-workflows.md).

## Подтверждено для061
- KUKA rewrite/chat, фактчекинг без замечаний к нейтральным связкам, удаление своего draft/returned, обычные страницы в локальном демо, read retry max3/8s/page.
- Host check/build,244теста, свежий полный CI/browser fixture, independent review PASS. PR3/4 merged; CI45079643901/45079608586 SUCCESS.
- Реальная YDB28/28;8таблиц/81запись восстановлены; перед cutover свежий snapshot/restore и совпадение inventory.
- AI6запросов/7вызовов:5полезных, KUKA-абзац действительно изменён/проверен. Editor title smoke unchanged; свободное переписывание любой полной статьи не доказано.
- Disk fault/retry/offline6файлов/0DBопераций; production16MD/13CSV/13receipts/47folders, exact bytes/current fingerprints PASS.
- Normal23/peak57(50одновременно),0ошибок, максимумp95=1.414s. Исторические2analytics503 сохранены, их точная причина не установлена; новый read retry отдельно доказан тестами. Это не200 и не проверка внешнего ingress.
- Runtime image cd08f365…, pin23; fresh archiveSHA bb2b89f174ebab10e14aacf8855a0f856e40daf1894b672c8475815e57829942. Полные идентификаторы/логи — в кратком контексте.

## Осталось для0.9.7
- Код UI готов: DemoEntry убран; единственная CTA на/login доступна при обоих legacy-режимах; выход читаем.
- Moderation native disclosure закрыт по умолчанию; мышь/Enter/Space/count проверены.
- Rewrite поднят перед деталями; explicit success→focus/scroll, stale/error/empty/normal check не прокручиваются; mobile390/reduced motion/source warnings проверены.
- Версия0.9.7; check/build/offline246PASS, UI reviewGREEN. Новые UI тесты подключены к CI. Остались CI, независимое ops-ревью и совместимая установка поверх061. [Отчёт0.9.7](docs/release-0.9.7.md).
- Обновить итоговые документы и основной worktree без потери чужих правок. Затем обычное выключение ПК по прямому поручению пользователя; не использовать принудительное закрытие приложений.

## Постоянные ограничения
Секреты не читать/не печатать. Тесты только QA/браузер; не менять рабочие карточки. Никаких новых владельцев/согласований11pending. Nginx/firewall/Alibaba/домен/200 вне задачи. Старые48ce/0.9.5 writers не запускать. Localdev иDDB не останавливать; `.next-campus-demo` не удалять рекурсивно.

[Первоначальный выпуск0.9.6](docs/release-0.9.6-production.md) · [История следующего выпуска](docs/followup-0.9.6-production.md) · [Памятка](docs/Памятка%20сотруднику%20Канон.md).
