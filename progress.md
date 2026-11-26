# Канон — актуальный статус

## Выпуск 1.0.0, 26 ноября 2026
- Пользователь поручил завершить функции, облако, проверки, коммиты и публикацию автономно; затем выключить ПК. До полного успешного завершения не выключать и сохранять локальный сервер.
- Production https://canon.midis.ru уже работает на1.0.0: revision `25fa0098882be831847fdb42361952832f44fd67`, image `sha256:23f9446ccc91462aa186d802a916c596e00f334c937c2dc281e4b35dad1feb10`.
- Первый выпуск принят как `f100n26a`. PR#12 слит после двух зелёных обязательных Quality gate; отдельный main CI45743522501 прошёл. Защита main строгая, действует и для администраторов.
- Сейчас ветка `release/kanon-1.0.0-final`, база main25fa009; коммит исправлений помощника `1bd92b0`. Готовится отдельное обновление1.0.0 без изменения схемы рабочих таблиц.
- [План](docs/release-1.0.0-plan.md), [доказательства выпуска](docs/release-1.0.0-acceptance.md), [операции и откат](docs/release-100-operations.md), [реальный YDB](docs/release-100-ydb-validation.md), [подробный журнал](docs/release-1.0.0-work-log.md).

## Что сделано
- Фильтры сохраняют папку вуза и возврат к списку; глобальный поиск включается явно. Значки категорий отличаются. Шапка округляется при прокрутке, добавлены состояния ИИ и микровзаимодействия с reduced motion и клавиатурой.
- Правильный учебный пример строится из текущих утверждённых версий и проверяется обычным движком; реальный пример и переписывание дают4зелёных/0жёлтых/0красных. Настоящий смысловой разбор ИИ также подтвердил все4факта.
- Запросы/контуры/владение/решения исправлены; обязательные реальные согласования РИОН/ЧКК сохраняются. Сотрудники не выдумываются.
- Основной вход через Яндекс, без писем Канона. Новый пользователь — автор своих личных статей; права сотрудника и вузы назначает координатор по точному ID/revision. Старый pilot-вход сохранён, связывания по email нет.
- OAuth state+PKCE/browser binding/одноразовый nonce/audience; отзываемые opaque v3 сессии. Добавлены3таблицы аккаунтов, TTL на sessions/rates, атомарные квоты и ограничения хранения.
- Ассистент даёт краткие сведения с версиями; web включается отдельно после предупреждения, отправляет только вопрос, помечает внешние источники. Квоты: canon50/user/day и1000/site/day; web5/user/day,50/site/day,200/site/month.
- Backup11 исключает только действительно истёкшие строки двух TTL-таблиц, сохраняет постоянные счётчики и все архивные строки при restore. Рабочая БД автоматически не восстанавливается.

## Облако и реальные проверки
- OAuth-приложение «Канон — вход» создано с разрешения владельца в основном mlnkws, callback `https://canon.midis.ru/api/auth/yandex/callback`, только login:info/login:email. Disk-only приложение не менялось.
- OAuth pair в Lockbox kanon-runtime; currentversion `e6qegncjr4cd2vrdc22j`, previous `e6q9fdst7bl7br5pmipl`. Старые5значений программно совпали. Секреты в отчёты/код/логи не выводить.
- Runtime loader SHA256 `2f25aff199f224aa12f7514a89b097d48e83bf8cd0f64e8d7639b61d9c8bf05b`; OAuth/web true, email false, trusted proxy true. Nginx SHA256 `27ff5d8a2d69b808adb430e4476edb8c2d4e507717150cee9ebbe1064f0ad491`: строгий X-Forwarded-For, callback без querylogs, start/callback ровно1no-referrer. Реальные probes PASS.
- Metadata Search200, реальный UI web-ответ с4источниками. VM-SA search-api.webSearch.user сохранена, неиспользуемая postbox.sender удалена. SMTP/Postbox выключены.
- Первый cutover: fresh8 snapshot/verify/изолированный restore → Dockerexec ADD3+2TTL → frozen11 snapshot/verify/restore → полное совпадение старых8inventory → открытие. Exact image/source/CI и native containerd Committed подтверждены. Подробные хеши в отчёте.
- Реальный OAuth login→author→private draft save→reload/readback→softdelete собственного теста→logout/закрытие редактора PASS. Повторный вход и настоящая семантическая проверка PASS; сессия оставлена активной для проверки сохранности после update.
- UI320/390/768/1440 и5исходных UI-regressions PASS. Папочный фильтр МИДиС проверен на production. Один медленный переход позже завершился, consoleerrors0; отдельная локальная проверка filteredfolder→header/check PASS, специальная правка не вводилась.
- Яндекс показывает предупреждение о неверифицированном сервисе; базовый вход фактически работает. Официальная верификация владельца не выполнялась.

## Проверки и ревью финального обновления
- Host check/test:offline/build ранее PASS, production npm audit0. Полный свежий Dynamo fixture и реальный изолированный YDB с11таблицами/2TTL/квотами/CAS/backup+restore PASS; QA-данные сохранены, отдельные контейнеры и туннель закрыты.
- AUTH/OPS/assistant исходного выпуска независимо приняты. YDB reasonless TransactionCanceledException и TTL metadata, Dynamo single-provider filter исправлены и проверены.
- Два финальных дефекта помощника воспроизведены RED→GREEN: точный хвост просьбы об источниках в вопросе площади; старая подсказка email. 81целевой+10routechecks независимого ревью PASS, host check/test10094pass4защищённыхskip/build PASS. Реальный localhost API вернул площадь121,8–123тыс.м² и1versioncite.
- Updatehelper `deploy/release-100-update.py` и40faulttests независимо приняты; полный release-набор116PASS и7дополнительных сбоев PASS. Исправлены таймауты systemd/Docker, гонка старта старого writer и статус после durablecommit.
- Helper SHA256 `c2b6cbb76ac2c4e5f9310a92e0337218031fcd6ce707f1281d3eb915d2acb51d`; tests `385fbf359db2c5a105adeb52bf362abc14c66ee4d9cd0cd14f9015546f0be819`. Рабочая VM новым helper ещё не затрагивалась.
- Strix engine недоступен; проверки не называем полноценным pentest. Атомарность Docker/FS при SIGKILL/потере питания не обещается, операционная граница описана в runbook.

## Осталось до завершения
1. Коммит ops/docs, PR и строгий CI; после merge — отдельный успешный main push CI с точным image/source/provenance.
2. Проверить и загрузить артефакт, native Committed/место/inodes; отдельный native Linux offline/signal probe без рабочей БД.
3. Принять one-shot `f100n26b`: fresh11 snapshot/verify/изолированный restore, frozen snapshot/verify и сравнение с учётом истёкших TTL; новый pin29/bootgate, без DDL рабочих таблиц. APP-only rollback на принятый1.0.0, текущие аккаунты сохраняются.
4. Проверить исправленные публичные ответы/версию/ready и сохранение открытой сессии, зафиксировать итоговые доказательства/коммиты, завершить goal и штатно выключить ПК.
- Не повторять принятые f100n26a/f099n24a и не удалять каталоги попыток ради обхода guard. Старые0.9.5/48ce writers запрещены из-за tombstones. При rollback БД не откатывать.
- Полный disasterrestore требует смены SESSION_SECRET до traffic и повторной TTL-миграции. Обычный откат образа этого не требует.
- Локальный dev127.0.0.1:8080, PID29760/session40535 (проверять). Не удалять .next-campus-demo рекурсивно: внутри node_modules junction.
