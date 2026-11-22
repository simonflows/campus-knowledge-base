# «Канон» — актуальный статус

Обновлено 23 ноября 2026. Задача активна: завершить, слить и установить 0.9.6. На [сайте](https://51.250.46.79/) пока **0.9.5**, runtime `0c0d96122d8776a03de72c9f7713178025271b7b`, healthy/ready200; новые рабочие записи не вносили.

## Последние решения владельца

- Довести полезность ИИ, сохранность данных, слияние и деплой автономно. Push/release-ветка/PR разрешены; обязательный CI и независимое ревью не обходить.
- 23 ноября стресс200 отменён ради ускорения. Нужны normal smoke 7+8+8=23 и **пик50**:7preflight+одна50=57, без платного ИИ/Диска. Firewall/Nginx только проверить, не менять. Прежние отказы не объявлять успешной ёмкостью200.
- Демо `/demo` — только браузер посетителя, reload/reset, без рабочей БД/Диска/платногоAI/сессии. Alibaba/сравнение исключены. Именные сотрудники/владельцы/согласования не фабрикуются.
- [Требования](docs/release-0.9.6-requirements.md), [план](plan.md), [контракты](docs/release-0.9.6-contracts.md), [права](docs/release-0.9.6-access.md), [Диск](docs/release-0.9.6-disk.md). История10 связанных чатов прочитана; другие чаты idle/notLoaded на последней проверке.

## Код и текущий этап

- Worktree `canon-0.9.5`, ветка `release/kanon-0.9.6`, база64a1f27. Основной main89a06b6 сохранён. [PR1 draft](https://github.com/simonflows/campus-knowledge-base/pull/1). Remote head **acaa20cd21ab57d1f008ece30fb6b6825aa92592**, оба CI45057606437/45057610514 PASS; main защищён PR/Quality gate/enforce_admins.
- Локально поверх acaa есть проверенный commit **c52ce7e** (CDN Диска, ещё не push) и незакоммиченные4 файла AI context B + план/сводка. Чужих изменений не включать. VM checkout покаacaa, работающий контейнер0.9.5 — checkout не равен установленному выпуску.
- Реализованы browser demo, встроенный чат, точный KUKA/кука поиск/аналитика, полный фактчек/версии, источниковые блоки библиотеки/SEO, матрица совместных согласований, авто-повтор/подтверждения Диска, памятка, волны19s без кнопки паузы. [Отчёт проверок](docs/release-0.9.6-validation.md), [памятка](docs/Памятка%20сотруднику%20Канон.md).
- Основной snapshot9 принят R2:75 SHA/32 editor checks; фактчек отдельно16+14. Полный fixture/CI и123tests прошли до последующих правок. Новые изменения не прикрывать старым вердиктом.
- a31 исправил ID-only ссылки ИИ с серверным полным оригиналом/версией, короткое целое поле МИДиС и отрицание текущей работы. Независимые69 targeted/type/lint PASS; ложный вывод размещения по отсутствующим деталям устранён.
- acaa исправил только fanout readiness:200 запросов давали1600Get, теперь общая активная проба8таблиц/allSettled безTTL/кэша карточек. RED→GREEN, syncerror/abort/отказ/восстановление, независимое3tests/tsc PASS.
- c52 исправил подтверждённый302 Disk→HTTPS*.storage.yandex.net:download-only, максимум2 проверенных перехода, OAuth только метаданным,8МБ/SHA/abort/404 сохранены. Официальный источник в плане. R1 PASS38 targeted; весь набор162. Ignored live/poststart helpers обновлены и приняты.
- **Последние4 AI-файла B заморожены и R2 приняты:** canonicalPlan с точным ответом, только eligible sources; unknown только уточнение без цитат; неверный ответ сохраняет обычный расчёт. Точный заголовок получает лишь заголовок и не может превратиться в другое поле/абзац. Старые проверки чисел/ссылок/версий/полной опоры сохранены. R2:73 targeted + самостоятельные16-fixture сценарии; SHA в сообщении ревью.
- **Текущий host check/build/offline173 и полный production fixture PASS**, логи `.next-campus-demo/{check,build,offline,fixture}096-context-r2.log`. Далее docs/commit/push/CI и новый точный образ. Этот код ещё не проверен живой моделью и не установлен.

## Фактические облачные доказательства

- Точный acaa image `sha256:a6eaeb9cf01c9534ff77b5df1a4aa4bd0c2aea2e6745c25a0837b203bfd16ae2`:27/27 realYDB, ready503→200, вход/черновик/ревизия, exactID Compose PASS. QA `/var/lib/canon/qa096-acaa20cd`.
- Полная копия8таблиц/56записей (27cards/16versions/13workflow) восстановлена b6, a31 и acaa в отдельных префиксах с совпадением SHA. Архив `/var/lib/canon/backup096-r096b6bbdfc6a/before-096.json`, SHA39b4a09762f13b16b470977d57dc0c032853617d692db0bc6bed3697cdd462a6. Последние повторы исторические: перед cutover обязательно новое stopped-writers snapshot/restore.
- acaa copy run `r096acaa20ca`, prefix `qa095-backup096-r096acaa20ca-`, marker `qa-marker-94766476-b264-4595-9266-99f39323626d`. Собственный QA app `kanon096-copy-app-acaa20cd`,127.0.0.2:8080; fake accounts, Disk/Alibaba/recovery off. AI и безопасные metadata preloads включены только в этом QA app.
- Живой AI b6:0/5 полезных; после ID-only acaa:2/5 полезных (fact+chat),5safe. Отдельные3 диагностики всеHTTP200/валидныйJSON: расширенный KUKAquery, лишняя лаборатория в passport evidence, editor46→354+число. Поэтому B contextfix; качество пока не принято. Совокупно17 реальных вызовов (5+4диагн+5+3), без автоматических повторов. Title fixture доказывает только attribution-smoke, не свободное переписывание статьи.
- Disk `r096a31disk1/2` отказали при чтении guide/CDN; root/7вузов/35подпапок/guide реально созданы и прочитаны. Не путать это с полным export/retry/offline acceptance — его выполнить новым образом после CDNfix. Свои тестовые корни/таблицы оставлены, рабочие данные не менялись.
- Normal23 acaa PASS без ошибок. Peak57 acaa:первый9ошибок/50, второй0/50 с native trace. Старые200/190:100 и226503 сохранены,200 отложен. Причина интермиттирующих503 не доказана; финальный peak50 повторить и честно зафиксировать ограничения.
- Nginx config valid;10r/s и15r/m,bursт10/30, limit_req/conn возвращают429; UFWactive/443allow/SSHlimit, Fail2banactive. Только read-only проверка, ни одна настройка не изменена. LoopbackQA обходит внешний Nginx и не использует Диск.

## Следующие действия и границы

1. Проверить frozen diff/статус; commit толькоB+docs, push оба этапа, дождаться обоих CI. Новый bundle от VMacaa → clean finalSHA → Docker build; старые образы не считать итоговыми.
2. Точный новый образ:27realYDB + Compose imageID + историческое restore8/56 + свой relay/marker/copyapp. Затем ограниченный realAI (полезность каждого сценария, не только fallback), новый isolatedDisk root/8tables:MD/CSV/receipt, два сбоя/восстановление, чтение6файлов после остановки writer/relay с0DB. Normal23 + peak57 безAI; версия/SHA должны совпасть.
3. Только после реальных proof flags:PR ready → merge --merge --match-head-commit безadmin-bypass. Fresh writers-stopped snapshot/verify/restore → pinnedID unit cutover. После первого newstart НИКОГДА не запускать старый0.9.5 writer; только остановка нового/исправление вперёд.
4. Poststart:HTTPSready/version/inventory без потери16approved/11pending, worker/MD/CSV/receipts/guide hashes, браузер demo/chat/mobile/waves. При окончательном FAIL вызвать reviewed `remote096-stop-new.sh <SHA> <imageID> <runID>`; pending Disk2 допускается только в ограниченном ожидании повтора. Обновить отчёты/сводку, main ff только после чистого статуса.
- OPS helpers ignored `.next-campus-demo` и наVM `/root/kanon096-b6bbdfc/`. Cutover gates теперь требуют `pilotSmoke`/scope `8-concurrent-23-requests-no-ai` и `peak50`/scope `50-concurrent-57-requests-no-ai`, кроме protocol/restore/ai/disk/ci/review/imagePin. Все helperы с индексомfinalSHA/пинами обновить перед использованием.
- Localdev localhost8080 session66407 и disposableDDB8000 session79712 не останавливать. Fixture marker `qa-marker-59f3df70-69f9-41ad-a08e-745f8b65ee2c`; fake providersfalse. Не удалять `.next-campus-demo` рекурсивно:dependency junction. Секреты не читать/не печатать; runtime только opaque env-file.
- Именные сотрудники/роли, владельцы и11pending согласований остаются организационными решениями. Не выдумывать их и не объявлять весь проект100%. Домен и Alibaba не входят в выпуск.

История0.9.5: [production](docs/release-0.9.5-production.md), [контекст/решения](docs/release-0.9.5-context.md), [проверки](docs/release-0.9.5-validation.md), [данные](docs/release-0.9.5-data-review.md), [Диск](docs/release-0.9.5-disk.md). Старый0.9.5 image `sha256:7cab6353798ad2dd13b5ba048caf9063e408e0b7cc8b087dc56faabe51aaba13` и полные root-only архивы сохранены.
