# Канон — актуальный статус

## В работе: 1.2.0, 27 ноября 2026

- Ветка `release/kanon-1.2.0`, исходная точка4ea0b6e (принятая1.1 + metadata). [План](docs/release-1.2.0-plan.md), [операции](docs/release-120-operations.md).
- Реализованы встроенные неизменяемые типы «Официальный документ» и «Показатель» без новых таблиц/начальных рабочих данных. Проекты/лаборатории имеют необязательные структурированные связи с документами.
- План/факт подтверждаются независимо. Серверные приватные квитанции, строгая схема, If-Match и CAS зависимостей;0 отдельно от неизвестного, будущий факт отклоняется, будущий план разрешён. Оба direct-import обхода закрыты.
- История хранит private receipts отдельно от public snapshot; прежний hash зафиксированной карточки сохранился. Новые поля не попадают в generic factual evidence.
- Аналитика выбирает по документу/пункту/направлению и показывает подтверждённые план/факт с единицами/контурами/датами/версиями. Нет вывода реального количества объектов из количества карточек/процентов.
- Редактор/помощник/фактчекинг/Диск используют отдельную безопасную проекцию: план не достижение, stale основание убирает числа. Transitive source guards добавлены к согласованию/проверке редакций. Проверяется сквозная пригодность сгенерированного текста.
- Дизайн по последнему уточнению: общий светлый фон без узора, только тихий цвет при aria-busy. В заголовках прежние дугообразные полосы с движением геометрии, reduced/hidden/manual stop.

## Проверки и ревью

- Host check/offline/build/backlog PASS, UI098/099/110/120 PASS.4прежних warnings только в ignored scratch,0errors. Полный свежий DB fixture PASS: старыеHTTP/DB/UI/ACL/версии/TTL и новый путь1.2.
- Новый полный путь через UI и настоящие HTTP: документ→approve→связанный проект→approve→plan/fact0→независимые confirm→approve→analytics→editor generate/save/submit/approve/check. Новыйdraftисточника сохраняетстаруюопору; newapprovalснимаетактуальностьчисел и блокирует stale generation конкретным409.
- Дополнительный реальный snapshot/verify/restore11таблиц после новыхданных PASS: private confirmations текущего и historicalindicatorrows сохранены полностью.
- Независимые domain/UI/OPS review пройдены, найденные blockers исправлены.74целевые domain +15повторных (пересекаются),16UI и реальные motion/guest checks,141Python+6независимых operationalfault сценариев. Финальный small refresh on create/delete внесён по ревью.
- [QA и ограничения](docs/release-1.2.0-qa.md), [как пользоваться и какие данные нужны](docs/release-1.2.0-guide.md).Новые regression fallbackAPI tests добавлены к test:120 (29тестов).
- Следующее: финальное форматирование/check,commit/PR,обязательные CI, точный main artifact, f120n27a и production приёмка. 1.2 пока не опубликована.

## Production остаётся на принятой1.1.0

- https://canon.midis.ru/, revision2ab9a3f0c70311cd7c4773b3f85e4e5c6fbc189f, image sha256:98a4b4b0a7144c0a465d89da078ff542e7d57cde5054be622060e624801b88f3. SSHreadback подтверждён, сервис active, свободно7403671552bytes.
- f110n27a/pin30-release-110.conf; PR14, mainCI45943480267/artifact15173687335; accepted snapshot11/verify/actualisolatedrestore/frozencomparison PASS. [Приёмка](docs/release-1.1.0-acceptance.md), [v1.1.0](https://github.com/simonflows/campus-knowledge-base/releases/tag/v1.1.0).
- Подготовка120: одноразовый f120n27a, pin31; пока не запускался. База11таблиц, новые реальные документы/показатели не выдумывать. Будущий rollback после открытия записи только совместимый120+ или обслуживание.
- Не повторять принятые f110n27a/f100n26a/f100n26b/f099n24a, не удалять их квитанции/образы. Не gitpull старый /opt checkout; immutableCIimage+attestedsource.
- OAuth profile/email, email flow disabled, unverifiedservicewarning Яндекса остаётся. Секреты не менять/не читать. Авторизованный Chrome пользователя — CUA, не Playwright. Старый author session был принят110,1.2 browserlogin проверить после выпуска.
- Не выключать ПК. Dev localhost:8080 сохранён (IPv4, execsession28810). Isolated prod fixture127.0.0.2:8080. .next-campus-demo не удалять рекурсивно (node_modules junction).
