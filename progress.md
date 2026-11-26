# Канон — актуальный статус

## Выпуск 1.0.0, 26 ноября 2026
- Цель: завершить функции, настройки облака, проверки, независимое ревью, коммит и публикацию. Пользователь разрешил действовать автономно и после полного успешного завершения выключить ПК (последнее сообщение отменяет прежний запрет). До этого локальный сервер сохранять.
- Ветка `release/kanon-1.0.0`, исходный main `21885be6c4577ecb0406a852daf12533c00d6123`. Phase1commit `acaea06f0ec495e3942c3532f5a8b3017eb59082` запушен, PR#12 draft. Публикации1.0.0 ещё нет. Рабочие изменения относятся к этому этапу.
- Production https://canon.midis.ru пока 0.9.9, revision `b94208f506b887685fee839d6347594739d20199`, image `sha256:c24de3d9b32751e20b93487ee29922e269fdfadf226975087a7691527453f9ac`. SSH BatchMode доступен. VM40GiB, ~10GiB свободно; данные/rollback-образы сохранены.
- [План и приёмка](docs/release-1.0.0-plan.md), [предыдущие промежуточные записи](docs/release-1.0.0-work-log.md), [предыдущий выпуск](docs/release-0.9.9.md).

## Вход и облако
- Основной вход — кнопка «Войти через Яндекс», без регистрационных писем Канона. Email/password реализован как отключённый запасной вариант. Новый пользователь — только автор; доверенные права и вузы назначает координатор. Прежний pilot-доступ сохранён.
- По явному согласию владельца создано отдельное приложение «Канон — вход» в основном `mlnkws`, callback `https://canon.midis.ru/api/auth/yandex/callback`, только login:info/login:email. Приложение резервных копий Disk-only не менялось. Иконка в Downloads/canon-icon.png.
- Клиент/секрет сохранены непрозрачно в Lockbox `kanon-runtime` (`e6q2s7nbc77ci3f3b1e8`), currentversion `e6qegncjr4cd2vrdc22j`; прежняя версия `e6q9fdst7bl7br5pmipl`. Новый payload: прежние5 entries + OAuthpair. Значения в отчёты/исходники/логи не выводить. Требуется сравнить старые5 программно и активировать проверенный materializer.
- Новый runtime: OAuthtrue, emailfalse, webSearchtrue/metadata/folder, trustedproxytrue только при строгом ingress X-Forwarded-For=$remote_addr (проверено в текущем Nginx). Callback query исключить из access/error logs перед включением OAuth.
- Postbox/DNS/SMTP не используются для этого сценария. Обычный ящик canon-noreply@yandex.ru создан владельцем, но не настроен для шаблонных рассылок; прежняя рекомендация отозвана.

## Реализация
- Фильтры сохраняют папку и browser history, явный глобальный поиск; категории имеют разные значки; шапка округляется при прокрутке; AiActivity/microinteraction с reduced motion и клавиатурой.
- Правильный учебный пример собирается из текущих утверждённых версий и проверяется обычным factchecker; тест смены3400→4200 и намеренного9999 проходит.
- Проверены/исправлены info-request owner/лимиты/контуры/решения; реальные обязательные RIO/CHKK согласования сохранены, сотрудники не выдумываются.
- OAuth: state+PKCE, браузерная привязка, одноразовый nonce, namespaceUID, audience client_id; контактная почта не связывает аккаунты. Отзываемые v3 сессии, безопасные cookie, rolegrant по точному ID/revision.
- 3 добавочные DynamoDB таблицы identities/sessions/rates, TTL expiresAt на последних2. Авторский атомарный лимит истории4MiB/user,24MiB/site,16 созданий; постоянные счётчики без TTL.
- ИИ: canon50/user/day,1000/site/day, web5/user/day,50/site/day,200/month; квота до paidattempt. Root закрыл OAuth-only обход canonquota (RED→GREEN).
- Web: отдельный opt-in/warningonce, только вопрос без закрытой истории; bounded response/time, external citations, metadata IAM. Живой Search пока не проверен.
- Backup11 исключает только истёкшие к cutoff записи двух TTL-таблиц; сохраняет активные/постоянные счётчики, восстанавливает/сверяет все архивные строки. Рабочие данные автоматически не восстанавливать.

## Проверки / открытые пункты
- UI320/390/768/1440, folder/history/reset, header, activitynormal/reduced ранее PASS, demo0API/0pageerrors. Root должен финально проверить помощник/login и просмотреть screenshots.
- Auth independentreview закрыл прежние P1; final42testsPASS. Последний P2 OAuthGET/HEAD обход freeze исправлен root вместе с прямыми routeguards, старыеfreeze+newfreeze+quota9testsPASS.
- Runtime validation3Python PASS; metadata/Lockbox realcompare/логирование/активация впереди. Root materializer `deploy/lockbox-runtime.py`.
- OPS independentreview нашёл label099, CIpatternбез100, SIGTERMreceipt, fsyncdirs, source/imageprovenance. Root label/CI исправил; агент OPS-F100 исправляет helpers/loader/tests. Обязательное повторное OPSreview после исправлений.
- WF BACKUP-FIXTURE100 готовит `scripts/test-account-integration-100.ts` для уже помеченной одноразовой БД, без рабочих данных. Нужен реальный Dynamo/YDB проход, миграция ТОЛЬКО Dockerexec.
- AUTH-R100 повторно проверяет freeze/quota/runtime/backup (read-only).
- В package1.0.0, test:100 в offline, authfixture в fixture; полный итоговый hostcheck/offline/build и обязательный CI ещё нужны. Недоступный Strix не выдаём за pentest.

## Следующий шаг
- Активировать проверенные runtime/ingress, подтвердить ограниченный live Search; закончить fixture/UI и reviews.
- Коммит/PR/строгий CI, затем exactmainpushartifact + sourcearchive/provenance, защищённый streamingload; свежий099backup/verify/изолированныйrestore доADD3, Dockerexecmigration, frozen100backup11/restore/shared8сравнение; открыть запись и проверить публичный вход/основные сценарии.
- `release099-f099n24a` уже принят: НЕ запускать повторно. Старые0.9.5/48ce writers запрещены из-за tombstones. При откате100→099 только приложение, аккаунтные таблицы сохранять.
- При полном disasterrestore отдельно сменить SESSION_SECRET до открытия traffic и повторить TTLmigration; обычный image rollback БД не откатывает.
- Локальный Next127.0.0.1:8080, session40535/PID29760 (проверять перед действием). Не удалять `.next-campus-demo` рекурсивно: там node_modules junction.
- Этап проверки: host check/offline/build PASS, npm audit production0. Root браузер проверил assistant opt-inonce/keyboard/isolatedhistory/pending/reducedmotion/mobile, прямой areaAPI200+source. Impeccable detector:4legacy accentwarnings исправлены fullborder,1advisory unusedpattern-grid utility сохранён; repeatedpublic320/390/768/1440PASS. AUTH/OPS independentreview без блокирующих замечаний (runtimeP3 закрыты). Lockboxold5compare и metadataSearch200/2sources PASS. NginxsiteSHA748fa6aa7d902226e51606b974937950f1088a0977a9d2d34719ce84a6afc5c0, runtime loaderSHA2f25aff199f224aa12f7514a89b097d48e83bf8cd0f64e8d7639b61d9c8bf05b. Runtime готов; restart kanon-runtime.service в01:33 штатно пересоздал зависимый099контейнер, версия/ready/image подтверждены, данные не мигрировались.
- SSH восстановился. Изолированные11таблиц QA и2TTL реально созданы Dockerexec; рабочие таблицы не менялись. Fixturepath /tmp/canon-account100-278beddd632845f0, prefixqa095-account100-278beddd632845f0-, networkhost+bind127.0.0.2:8080, tunnel127.0.0.1:8000, marker хранитWF. HelperOPSreviewPASS толькодлячастногоодноразовоготуннеля; оставлятьпублично запрещено.

- ActualYDB: TransactionCanceledException без CancellationReasons — AUTH-YDB100 исправляет boundedstrongreread/CAS/quota без grant на ошибке. TTLдобавляетexpiresAt:NвAttributeDefinitions — WF исправляетbackupmetadata normalization только2knownTTLтаблиц; прямойScanfilter actualPASS. Полный повторactualfixture+независимыйreviewобязателен.
- CIbranch acaеa06 failed на старомreleaseNotesUIexpect4items vsnew5; rootобновилтест до5+проверки5конкретныхфункций, realmobilekeyboardUI PASS. ДообновлённогоCI/mainартефактавыпускаНЕбыло. Ассистент7новыхпримеровпустыенаlegacyapprovedданных: ASSISTANT-F100 исправляетstructuredguides/старыйформатбезвыдумыванияисточников.

- ActualYDB итог: все4сценария поотдельности PASS: TTL+повторнаяидемпотентнаяDockerexecмиграция, realrate/reasonless atomicfailedcondition, OAuth+authorCAS/квоты, snapshot11/restore11/hash. Полныйauthfixture plainповторPASS5.6сек. 2промежуточных503Get/Putнеповторилисьприограниченномповторе; невыдаватьзаотсутствиеошибокпровайдера. WF сохраняет22одноразовыеYDBтаблицы/доказательства, останавливаетТОЛЬКОQA2контейнера/свойSSHтуннель.
- AUTH-YDB100 кодfrozen: lib/account-transaction.ts/account-storage.ts/author-storage-budget.ts/editorial-models.ts;33targetedPASS, test10080PASS4skip. WFbackup normalization+16testsPASS. AUTH-R100 независимо проверяет обеdelta. ASSISTANT-F100 завершает legacylabel/structuredguide исправления,67targetedPASS, финальныйtypecheckожидается. Далее отдельныйreviewassistant, полныйhostcheck/offline/build, phase2commit/pushиCI.

- Phase2commit 4c92362 локальнофиксируетпровереннуюYDBсовместимость/TTLbackup/realfixtureиreleaseNotesUI. Он ещёНЕзапушен. Hostcheck/offline/build послеYDBdeltaPASS;76release+3runtimePythonPASS. AUTH-YDB independentreviewPASS(16+30tests), реальныйYDBreportdocsготов.
- ASSISTANT-R100 HOLD: первичнаяdeltaдавалаошибкисвязываниявместимости/объекта/места/модальностииконфликтующихстрок. Исполнительassistant_fix_100 исправляетпоcounterexamples ops_review_100, новыетестыRED→GREEN, повторноеревьюобязательно. Не коммитить/непубликовать незавершённыеassistant5файлов. Простые8примеровбылиполезны, этоНЕзаменяетnegativechecks.
- Cloud IAM: удалёнтолькораньшедобавленный postbox.sender уVM-SAajeavmbsv49dsoo172r2, search-api.webSearch.userсохранён(провереноCloudShellJSONtrue/true). Письмавproductionвыключены. Nginxrealcallbackqueryprobe404на099,0появлениймаркеравлогах. SSHpasswordauthenticationno, pubkeyyes; /var/lib/canon700/runtimeenv600, VM10.49GB/3.94Mfreeinodes.
- Root binary streamdriverготоввignored .playwright-cli/stream-ci-image-100.mjs, Node--checkPASS; proof+gziphashпроверяютсядоSSH, deadline15min. ДоmainCIgreen/actualartifact/VMsourcefresh/private700 ничего не загружать. Loaderтолькоизпроверенногоартефакта. ПослеloadотдельноnativecontainerdCommittedиuniquelayerdiskbudget, затемone-shotrelease100helper.

- ASSISTANT-R100 finalPASS:117focused+15дополнительныхсценариев,замечаниязакрыты. ReviewedSHA256assistant-querya66daceb139aa548fc0bf0e5907eb45662e86912c5fcf2bc8c82ba46c9e9626b/canon-ai0399854195ca2a991f90c9a7048efa628bd093956d87fcb5f82be9d472f2c262. Rootпроверил9живыхUIподсказокна390px:8ответовсверсиямии1маршрут/check,0pageerrors. СтарыйwebmockпередactualUIпрогономудалён.
- Финальныйhostcheck/offlinePASS(test10091pass4skip;защищённыереальныесценарииотдельнопройденынаYDB),финальнаяproductionbuildPASS. ВсеAUTH/OPS/assistantreviewsбезблокирующихзамечаний. Следующийшагphase3commit/push→обязательныеCIнаPR→mergeстрогоgreen→mainpushCIartifact+verifiedsource→guardedrelease.

- НовыйCIfail6ed3687вstreamUI:ожидалсястарыйтекстЭтап1/2вместообновлённогоЭтап1из2. Исправлентолькоlocatorожидания. Rootзапустилоригинальные5UI-regressionexportsлокально(фактрезультат/отчёт/помощник/заметки/stream) — всеPASS, включая409/truncated/invalid/missing/abortиdraftretention. Кодпродуктанеизменён.
