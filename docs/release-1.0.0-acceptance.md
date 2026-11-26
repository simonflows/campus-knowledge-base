# Канон 1.0.0 — доказательства выпуска

26 ноября 2026. Пользователь разрешил реализацию, коммиты, публикацию и настройку облака; после полного успешного завершения — выключение ПК.

## Первый принятый выпуск

- PR#12: https://github.com/simonflows/campus-knowledge-base/pull/12 — слит после двух зелёных обязательных Quality gate без отключения защиты ветки.
- Main/revision: `25fa0098882be831847fdb42361952832f44fd67`.
- Main push CI: https://github.com/simonflows/campus-knowledge-base/actions/runs/45743522501 — success.
- Artifact ID15082118739, ZIP319746765bytes, SHA256 `ccb1551eb011bdc558ec4f729c760b4f7cc4221f86ed9e07769fe6101028cc8e`.
- Exact image `sha256:23f9446ccc91462aa186d802a916c596e00f334c937c2dc281e4b35dad1feb10`.
- Gzip317939530bytes, SHA256 `7e45dddaad447ae7114fa961f538b5994cf4f9ae726937fcfbec2e4fefe5b8c1`; source archive SHA256 `33ae9daebfe56f067f0f2b1afeec9b33ae00e413d0a6da04df701da77afe94d3`.
- Полный source manifest проверен до загрузки и повторно перед переключением. Образ не пересобирался на VM; передан binary stream без сохранения image archive на сервер.
- Дополнительный native containerd snapshot: `sha256:d13a0ba3115ffcb8148304487b26c3d71e25b8d18d845d8d8cd1e7d4940af31f`, Kind=Committed.
- Место: до загрузки10.49GB/3.94Mfreeinodes; оценка всех слоёв без dedup с запасами2.512GB; после9.384GB/3.898Mfreeinodes.
- One-shot `f100n26a`: `/var/lib/canon/release100-f100n26a/accepted.json`, statusaccepted, migrated/restored/inventoryUnchanged/accountTablesEmpty/yandexOAuthStartVerified=true.
- До миграции: свежий snapshot8, verify и реальный isolatedrestore; SHA256 `312ca77638933b82d141c76242f41b5ac7cb5b04c5868e684f565be7812cb060`, restoreprefix `qa095-100-f100n26a-old-`.
- Миграция Dockerexec добавила3accountтаблицы и2TTL. Старые8таблиц не преобразовывались.
- В frozen100: snapshot11/verify/realrestore, SHA256 `7fc7a6b7129c95e2473087d8bafcc1825c38268ebb71793514b4f57f465e0243`, restoreprefix `qa095-100-f100n26a-new-`.
- Прежние8inventory полностью совпали:5documents/25revisions/0requests/0articles/0customtypes/16cardversions/27cards/13workflowrecords. Все3новыеaccountтаблицы на момент перехода пусты.
- GET/HEAD OAuthcallback frozen503 безcookie; послеоткрытия HTTPSOAuthstart303/no-referrer, ready200/version1.0.0/newrevision, restartunless-stopped. Старые099образы/receipt сохранены, автоматический rollback не потребовался.

## Реальные сценарии после публикации

- Chrome: обычный вход через Яндекс → callback → account с ролью автора. Согласования/запросы сотрудника не появились, автоматического связывания по email или повышения роли нет.
- Личный черновик создан и сохранён, после reload прочитан с сервера с теми же заголовком/лидом и revision1. Созданный агентом контрольный черновик удалён штатной мягкой операцией, история/tombstone сохранены. Затем logout; reload/editor закрыл личный доступ и показал вход через Яндекс.
- МИДиС → Лаборатории → Утверждена: осталась та же папка и одна из двух карточек; глобальный поиск выключен.
- Обычный factchecker: правильный учебный пример237символов, четыре факта из текущего утверждённого паспорта — G4/R0/Y0. Переписывание по официальным данным и повторная проверка — G4/R0/Y0.
- Websearch: первое включение показывает предупреждение, затем реальный ответ с4внешними ссылками и явной маркировкой интернета. Запрос не содержит закрытого черновика.
- Дополнительно настоящий смысловой разбор237символов с включённым ИИ: обе стадии выполнены, все4утверждения разобраны и подтверждены, G4/R0/Y0, доступны4цитаты/версии.
- Прямой ограниченный providerprobe Yandex AI Studio: ready, корректный JSON,32input/14outputtokens. Значения ключей не выводились.
- Окно версии показывает1.0.0 и5актуальныхпунктов, хорошо читается. Header при прокрутке округлён.
- Один переход знания→проверка выглядел медленным, затем завершился. NginxRSC200, public/internalFlightответы совпали, consoleerrors0; отдельный локальный regression filters→header/check PASS. Подтверждённая причина дефекта не установлена, специальная правка не вводится.

## Исправления после контрольного входа

- Составной вопрос о площади с хвостом «и из каких источников это известно» блокировался строгим подбором доказательств. Снимается только точный заключительный запрос источников; дата, отрицание, УНК, план и другойкампус сохраняются. Подсказка доступа заменена с emailрегистрации на Яндекс/author/coordinator.
- Два исходных RED; executor51targeted/check/test:10094pass4expectedskip; независимое review81targeted+10routechecks PASS. Production build после исправлений PASS.
- Для установки нужен новый успешный exactmainCIimage и отдельный updatef100n26b без DDL, с новыми proof/pin и свежим backup/restore11. Старый принятый helperf100n26a повторно не запускается. Этот этап пока не принят.

## Область доказательств

Full hostcheck/offline/build, свежий Dynamo fixture, HTTPS image fixture и реальный изолированный YDB учтены в progress.md и [отчёте YDB](release-100-ydb-validation.md). AUTH/OPS/assistant independent reviews закрыли блокирующие замечания. Strix engine недоступен; не заявляется полноценный pentest или отсутствие любых возможных ошибок. Owner verification в ЯндексID не выполнялась; Яндекс показывает предупреждение о неверифицированном сервисе перед стандартным входом. Базовый вход фактически работает.

Финальный updatehelper прошёл независимое ревью:40целевых/116releaseтестов и7отдельныхfaultprobes. Рабочие SHA256: helper `c2b6cbb76ac2c4e5f9310a92e0337218031fcd6ce707f1281d3eb915d2acb51d`, tests `385fbf359db2c5a105adeb52bf362abc14c66ee4d9cd0cd14f9015546f0be819`. Подтверждённые замечания отката и статуса после commit исправлены. Приёмка настоящего update по-прежнему впереди.
