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
- Для установки нужен новый успешный exactmainCIimage и отдельный updatef100n26b без DDL, с новыми proof/pin и свежим backup/restore11. Старый принятый helperf100n26a повторно не запускается. Обновление позднее принято как f100n26b, доказательства ниже.

## Область доказательств

Full hostcheck/offline/build, свежий Dynamo fixture, HTTPS image fixture и реальный изолированный YDB учтены в progress.md и [отчёте YDB](release-100-ydb-validation.md). AUTH/OPS/assistant independent reviews закрыли блокирующие замечания. Strix engine недоступен; не заявляется полноценный pentest или отсутствие любых возможных ошибок. Owner verification в ЯндексID не выполнялась; Яндекс показывает предупреждение о неверифицированном сервисе перед стандартным входом. Базовый вход фактически работает.

Финальный updatehelper прошёл независимое ревью:40целевых/116releaseтестов и7отдельныхfaultprobes. Рабочие SHA256: helper `c2b6cbb76ac2c4e5f9310a92e0337218031fcd6ce707f1281d3eb915d2acb51d`, tests `385fbf359db2c5a105adeb52bf362abc14c66ee4d9cd0cd14f9015546f0be819`. Подтверждённые замечания отката и статуса после commit исправлены. Приёмка настоящего update выполнена, доказательства ниже.

## Итоговая приёмка f100n26b

- Финальный код: `c1405c6987bd22b0c740c935c0af28625dc79fa7`, PR#13 https://github.com/simonflows/campus-knowledge-base/pull/13. Обязательные PR/push CI прошли перед merge; отдельный mainCI45748848661 success.
- Exact image `sha256:7e8eecacabbbfeaf56ab5bf8737a73757487ef9bdff1e6fc7d3f3cbc5419543b`; артефакт15084817585, ZIP SHA256 `ab5a49d715920693b45307e02bcbf3c2dd31563650e1a673331e4e4a74599a95`.
- Образ/архив исходников/полный manifest проверены, binary stream без image archive на VM. Native snapshot `sha256:14cc64b8c5390335deb8ca00d8fb3f6a533d7e989ac37c89efcd8f663fd4bf50`, KindCommitted. Перед переключением оставалось8.27GB и3.85M свободных inodes.
- Source и helper совпали с независимо проверенным SHA256 c2b6cbb7…; preflight подтвердил старый принятый образ, все старые pin/gate, точные systemd-команды, runtime, TTL и OAuthstart.
- Native Linux:40offlineupdateтестов и4настоящих SIGTERM-пробы на синтетических файлах с подменой Docker/systemd PASS: до публикации, успешный fsync, неуспешный fsync и после commit. Рабочая БД этими пробами не использовалась.
- `/var/lib/canon/release100-f100n26b/accepted.json`: accepted, restored/inventoryUnchanged/yandexOAuthStartVerified=true. Принят контейнер `52c3841ea60df43b58251728e1434f7689b97c6a5787bd9eaa721b585770b6e4`; rollback/incomplete не возникли.
- Свежий snapshot всех11таблиц проверен и реально восстановлен в `qa095-100-f100n26b-old-`. SHA256 `051f31dbc1db1db4d3d076e6abb9e90f0ca20c2292a0f2c11d99289f04fb0fd1`.
- Frozen snapshot11 проверен; SHA256 `dffca741d546bcc14986e32216d1edfa89b94d41d8bb657f1b689f1d8621bf26`. Все9обычных таблиц и живые/постоянные строки двух TTL-таблиц совпали.
- Оба inventory: identities1/rates7/sessions1/documents6/revisions28/requests0/articles0/customtypes0/cardversions16/cards27/workflow13. Рост документов/ревизий относительно первого выпуска — штатный собственный контрольный черновик и его tombstone. Официальные карточки не изменялись.
- Схема рабочих таблиц не менялась; изолированный restore создавал только QA-таблицы. Старые28pin/accepted1.0.0/0.9.9/0.9.8 доказательства и образы сохранены. Pin29 и durableactivation приняты; реальный CLI bootgate с другим expectedboot также вернул0.
- Внешние HTTPS `/api/version`200:1.0.0/c1405c6, `/api/ready`200ready. Уже открытая OAuth-сессия после обновления осталась авторской. На новой странице один помощник и версия1.0.0, consoleerrors0.
- Исправленный составной вопрос в production теперь сообщает, что площадь отсутствует в текущем утверждённом паспорте, и даёт точную ссылку на `cv-87f29653e796c27a16ad066cf2ff2de2d248e1cc99976816f4ec82b8acaf21f3`. Значение121,8–123тыс.м² подтверждено только в локальном наборе; рабочие утверждённые данные не дополнялись догадкой.
- Подсказка доступа вернула правильные Яндекс/author/coordinator инструкции из резервного слоя; провайдерный подбор этого ответа перешёл в явно показанный fallback. Реальная смысловая проверка и websearch ранее прошли успешно. Сервис не обещает безошибочную или постоянную доступность ИИ.

Обязательные проверки и независимые ревью завершены; релиз готов. Официальная верификация владельца сервиса в ЯндексID остаётся отдельной необязательной процедурой для снятия предупреждения. Полный pentest Strix не выполнялся. Отчёт не обещает абсолютной защищённости или атомарности Docker/FS при внезапной потере питания.
