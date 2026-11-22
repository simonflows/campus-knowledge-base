# Контекст выпуска 0.9.7

Обновлено 23 ноября 2026, Asia/Yekaterinburg. Это краткая рабочая сводка вместо перечитывания чатов.

## Что уже закончено
- Рабочий сайт https://51.250.46.79/ проверен: 0.9.6, revision `061e6383d525c00ae02060eb49692a2ef0537cbb`, healthy/ready200.
- Image `sha256:cd08f3654bea0d43e455cf9b92eca62c8cd5051c0cd060807da822d2f2db0a3b`; systemd pin `23-workflows-096.conf`, override `/var/lib/canon/precutover096-f096n23b/image.override.yml`.
- PR3/PR4 merged; текущий main `a16b442efac981f2329d9773762f399928a31eac`. Рабочая ветка `fix/kanon-096-demo-controls` от этого main.
- Исправлены KUKA rewrite/chat, нейтральные связки, удаление своих черновиков, демо на обычных компонентах сайта, ограниченный повтор временных Scan-чтений.
- 244 теста, check/build, свежие CI45079643901/45079608586 и полный browser fixture PASS; independent review GREEN.
- Реальная YDB28/28, backup/restore8таблиц/81запись, AI6запросов/7вызовов (5полезных; отдельный editor title smoke unchanged), Disk fault/retry/offline6файлов/0DBопераций PASS.
- Normal23/peak57 (однаволна50),0ошибок; p95макс1.414s. Первый ad3 peak с2analytics503 сохранён, первопричина не доказана. 200 отложен, Nginx/firewall не менять.
- Fresh cutover archive `/var/lib/canon/precutover096-f096n23b/before-cutover-096.json`, SHA `bb2b89f174ebab10e14aacf8855a0f856e40daf1894b672c8475815e57829942`; inventory совпал.
- Production Disk postcheck:16MD/13CSV/13receipts/47folders/exact bytes PASS. Публичный браузер: guest KUKA2цитаты, demo save/reload/0fetch/cookies/390px/exit PASS, но найден низкий контраст кнопки выхода.

## Новое поручение — 0.9.7
1. Удалить вход в демо из шапки; оставить единственную аккуратную кнопку «Попробовать в демо-режиме» на странице входа. Индикатор активного демо и читаемый выход сохранить.
2. Исправить белые надписи на белых кнопках в шапке (DemoEntry удаляется, ExitDemo получает существующий стиль atlas-account/atlas-login).
3. «Запросы на подтверждение» — закрыты по умолчанию, заголовок/счётчик видимы, мышь и клавиатура раскрывают/сворачивают. Изменение уже есть только в knowledge-moderation-panel.tsx; RED→GREEN/Chrome390/9UIтестов у прежнего исполнителя, интеграция ещё не проверена.
4. Переписанный текст поставить до длинного разбора; после явного rewrite прокрутить к результату. Не скрывать краткие предупреждения/источники, не менять запросы/фактлогику.
5. Версия package/lock/активные QA checks —0.9.7. Проверить UI, check/build/CI, независимое ревью, merge/deploy; не повторять платный AI только из-за косметики. Backend-поддеревья должны остаться теми же, доказательства061 наследуются явно.
6. После ВСЕХ правок/проверок/деплоя/сохранения отчётов пользователь прямо просит выключить ПК. Обычное выключение, без /f; до готовности не запускать.

## Границы
- Секреты/runtime.env/Config.Env не читать и не печатать; только opaque env-file. Рабочие данные не менять тестами.
- 48ce208 и0.9.5 writer запрещены: нет фильтра tombstone. Совместимый откат UI допустим только к061 при доказанно одинаковых backend/API/schema; без отката данных.
- Localdev8080 и disposableDDB8000 не останавливать; `.next-campus-demo` содержит node_modules junction, не удалять рекурсивно.
- Детали: docs/followup-0.9.6-workflows.md; `.next-campus-demo/*followup-read.log`; предыдущие серверные helpers в `.next-campus-demo/followup096-ops` закреплены на48ce→061, повторно для0.9.7 не запускать.
- 11pending требуют людей; не утверждать и не удалять автоматически. Alibaba/домен/200 исключены.
