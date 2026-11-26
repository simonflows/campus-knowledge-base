# Канон — актуальный статус

## Выпуск 1.0.0, 26 ноября 2026
- Цель и согласование: завершить функции, облако, проверки, независимое ревью, коммит и публикацию; затем выключить ПК по последнему сообщению пользователя. До успешного завершения не выключать и сохранять локальный сервер.
- Ветка `release/kanon-1.0.0`; исходный main `21885be6c4577ecb0406a852daf12533c00d6123`. Код до `ff9f46a2b110cba679a2387585bb9b51ab78046c` отправлен в [PR#12](https://github.com/simonflows/campus-knowledge-base/pull/12), PR готов к ревью, ещё НЕ слит. Main защищён обязательным строгим Quality gate, включая администраторов.
- Production https://canon.midis.ru пока 0.9.9, revision `b94208f506b887685fee839d6347594739d20199`, image `sha256:c24de3d9b32751e20b93487ee29922e269fdfadf226975087a7691527453f9ac`. Публикации 1.0.0 и изменений рабочих таблиц ещё нет.
- [План](docs/release-1.0.0-plan.md), [операции выпуска](docs/release-100-operations.md), [реальная проверка YDB](docs/release-100-ydb-validation.md), [подробный рабочий журнал](docs/release-1.0.0-work-log.md), [предыдущий выпуск](docs/release-0.9.9.md).

## Реализовано
- Папочные фильтры/history/reset, явный глобальный поиск, значки категорий; округление шапки; AiActivity и микровзаимодействия с reduced motion и клавиатурой.
- Правильный учебный пример строится из текущих утверждённых версий; обычный factchecker и повторная проверка переписанного текста дают зелёный результат.
- Info-request owner/лимиты/контуры/решения, сохранение обязательных реальных RIO/CHKK согласований.
- Вход через Яндекс: state+PKCE, browser binding, одноразовый nonce, client_id audience, namespace UID без связывания по email; отзываемые opaque v3 сессии. Старый pilot-вход сохранён.
- Новая регистрация даёт только роль автора. Доверенные роли и вузы назначает координатор по точному ID/revision. Email/password остаётся выключенным.
- 3 добавочные таблицы identities/sessions/rates, TTL expiresAt на последних двух. Атомарные лимиты авторской истории и создания, постоянные счётчики без TTL.
- ИИ: canon 50/user/day, 1000/site/day; web 5/user/day, 50/site/day, 200/site/month. Квота до платной попытки. Web opt-in/warningonce, только вопрос без закрытой истории, ограниченные время/ответ, отдельные внешние источники.
- Ассистент отвечает по карточкам и версиям, legacy-форматам и структурированным разделам; неоднозначные числа не связывает с чужим объектом. Девять подсказок проверены живым UI.
- Backup 11 таблиц исключает только истёкшие к cutoff строки двух TTL-таблиц, сохраняет постоянные счётчики, проверяет все архивные строки после restore. Рабочие данные автоматически не восстанавливает.

## Облако / секреты
- Приложение «Канон — вход» создано с разрешения владельца в основном mlnkws, callback `https://canon.midis.ru/api/auth/yandex/callback`, только login:info/login:email. Disk-only приложение не менялось.
- OAuth pair в Lockbox kanon-runtime, currentversion `e6qegncjr4cd2vrdc22j`, previous `e6q9fdst7bl7br5pmipl`. Старые пять записей программно сравнены: совпали. Значения секретов не выводить.
- Runtime loader SHA256 `2f25aff199f224aa12f7514a89b097d48e83bf8cd0f64e8d7639b61d9c8bf05b` установлен; OAuth/web true, email false, trusted proxy true, канонический origin. Restart runtime в01:33 штатно пересоздал зависимый 0.9.9 контейнер; версия/образ/ready подтверждены.
- Nginx site SHA256 `27ff5d8a2d69b808adb430e4476edb8c2d4e507717150cee9ebbe1064f0ad491`: X-Forwarded-For=$remote_addr, callback без access/error query logs; start/callback ровно один Referrer-Policy:no-referrer. nginx -t/reload и реальный probe PASS, маркер callback в логах отсутствует.
- Metadata Search реальным IAM запросом: HTTP200/2 источника. Роль search-api.webSearch.user сохранена; неиспользуемая postbox.sender удалена. SMTP/Postbox не используются.
- VM40GiB, последнее свободное место10.49GB/3.94M inodes. Старые образы/данные сохранены. SSH BatchMode работает, кратковременный сетевой timeout прошёл без перезапуска VM.

## Проверки / независимое ревью
- Host `npm run check`, полный `test:offline`, финальная production build: PASS. test100:91pass/4защищённыхskip; защищённые сценарии отдельно выполнены на реальной БД. npm audit production:0.
- Все пять исходных UI-regressions (фактрезультат/отчёт/ассистент/версия/stream) PASS. UI320/390/768/1440, папка/history, opt-inonce/keyboard/pending/isolatedhistory/reducedmotion, правильный пример и rewrite G1/R0/Y0,0pageerrors: PASS.
- Полный свежий локальный Dynamo3.3.2 `test:fixture`: PASS, включая все HTTP/UI/ACL/гонки и auth+backup/restore11 без skip. Одноразовые DB и QA app остановлены, пользовательский dev8080 сохранён.
- Реальный изолированный YDB: Dockerexec migration11+2TTL и идемпотентный повтор; reasonless atomic condition, OAuth+сессии+authorCAS+квоты; snapshot11/restore11/хеши: PASS. См. отдельный отчёт. Два промежуточных503 не повторились в ограниченном повторе, причина не установлена.
- YDB TransactionCanceledException без CancellationReasons и TTL AttributeDefinitions нормализация исправлены; Dynamo single-provider staff filter без лишних скобок исправлен. AUTH независимый review: PASS, дополнительных замечаний нет.
- OPS helper/loader: независимый PASS,76 fault tests +3 runtime tests PASS. Источник/образ/CI provenance, SIGTERM receipt invalidation, fsync и rollback проверены.
- Assistant независимый PASS:117 focused+15 дополнительных сценариев. Reviewed SHA256 assistant-query `a66daceb139aa548fc0bf0e5907eb45662e86912c5fcf2bc8c82ba46c9e9626b`, canon-ai `0399854195ca2a991f90c9a7048efa628bd093956d87fcb5f82be9d472f2c262`.
- Последний CI45741532845 прошёл весь fresh fixture, сборку и image readiness/sign-in/draft, затем остановился в isolated storage scope-guard: старые asserts ожидали8 вместо11 таблиц. Воспроизведено RED; исправлены только2assert; весь original test-release-storage.ts на отдельном Dynamo3.3.2 PASS11tables/11created и все проверки. Независимый OPS review этой delta PASS:11 разрешённых префиксных операций и22 запрещённых непрефиксных/вложенных проверены.
- Strix engine недоступен; проверки не называем полноценным pentest. Полный реальный OAuth login через провайдера ещё впереди после публикации.

## Дальше / безопасный выпуск
1. Отправить проверенную delta, дождаться зелёных PR/push CI, слить точный head PR12. Дождаться нового успешного main push CI и его артефакта.
2. Проверить raw ZIP/API digest, exact source/revision/image; staged source root700/files600. Загрузить бинарным stream driver `.playwright-cli/stream-ci-image-100.mjs`, отдельно проверить native containerd snapshot Committed и место/inodes.
3. Одноразовый release helper из проверенного source: fresh099backup/verify/изолированныйrestore; Dockerexec ADD3+2TTL; frozen100backup11/restore/shared8 compare; открыть запись, HTTPS/version/OAuthstart, restart policy и accepted receipt.
4. Пройти реальные публичные сценарии и полный Yandex login, сохранить итоговый release proof и коммит; затем завершить goal и выключить ПК.
- Не повторять принятый release099-f099n24a. Не запускать старые0.9.5/48ce writers: несовместимы с tombstones. Откат100→099 только приложения, новые таблицы сохранять.
- Полный disasterrestore: до traffic сменить SESSION_SECRET и повторить TTLmigration. Это не требуется при обычном image rollback.
- Локальный dev127.0.0.1:8080, PID29760/session40535 (проверять). Не удалять .next-campus-demo рекурсивно: внутри node_modules junction.
- Изолированные YDB22таблицы и /tmp/canon-account100-278beddd632845f0 сохранены, QAконтейнеры/туннель закрыты; рабочие таблицы не менялись. Локальные canon100-fixture-* содержат только синтетику и сохранены как доказательства.
