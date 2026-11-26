# Канон — актуальный статус

## 0.9.9 опубликована 24 ноября 2026
- На https://canon.midis.ru принят runtime `b94208f506b887685fee839d6347594739d20199`, image `sha256:c24de3d9b32751e20b93487ee29922e269fdfadf226975087a7691527453f9ac`, runf099n24a/pin27. Healthy/unless-stopped, запись открыта. [Отчёт, доказательства и ограничения](docs/release-0.9.9.md).
- PR10 слит main7776858c; дерево равно runtimeb94208f. CI push45318928048, PR45318935374 и main45319648761 SUCCESS. Strict Quality gate/app15368/enforce-admins сохранены. Текущая ветка документов docs/kanon-099-acceptance.
- Исправлены: контраст версии/перекрытие помощником/значки очередей, подтверждение336/3064/3400по разным полям, точечный9999→3400и отдельный отчёт нового текста, краткие ответы помощника с версиями/полной цитатой. Аналитика не менялась. Площади в актуальном паспорте нет:114/123тыс.м²unknown.
- Source/assistant/UI независимое ревью и повтор замечаний PASS; host check/offline/build,09933/33, Python33/33, полный browser098+099 PASS. CI подтвердил freshDynamoDB/HTTPSimage/28storagechecks. В CI исправлены ES2017 capture и старый heading-selector без ослабления проверок.
- PublicHTTP: version/ready/cards/facts/assistant200; invalid400/crossorigin403/anonymousdraft401. Browser390/1440px: версия видна,1launcher/разныеglyphs, keyboard, assistantcapacity, rewriteR1Y1G1→R0Y1G2, pageerror0. Снимки просмотрены; demo0рабочихAPI.
- Exact-image realFlash/current16approved: semantic3/3,2supported+1unknown, exactfields. Assistant ready/summary с версиями. Источники неизменны, записей0. Один дополнительный строгий CLI-прогон до диагностического повторения был неуспешен без установленного этапа; не заявляем100%стабильность ИИ. Подробности и остальные границы — в отчёте.
- Freshbackup SHA2446d7ba…:8таблиц/86записей, verify и actualisolatedrestore qa095-099-f099n24a- PASS. Frozen source/tablehashes/counts совпали; разные archiveSHA не путаются с содержимым. Рабочие карточки/роли/DDL/согласования не менялись.
- Helper b26896c2, источник GitLF Composeb41a16d5. НИКОГДА не повторять принятыйone-shot f099n24a. Root-only proof /var/lib/canon/release099-f099n24a; acceptedcontainer3872084b, frozen d9520777. Совместимый rollback image42f29efe сохранён; старые0.9.5/48ce запрещены.
- GzipCI SHA0b2d8cdf…,311600838B; загрузкаbinarySSHstdin безархива/ошибокunpack. Финальныйsnapshot a1a75b5b Committed. Диск после:412807168B (~394MiB,99%).192MiBрезерв соблюдён; следующий крупный выпуск требует плана места, без broadprune/userdatadelete.
- TrustedTLS/Nginx SHA189dc600 и domainruntime3ebd001a прежние; renewtimeractive. SSH восстановлен запуском сохранённого ssh-agent, секреты не читались/не печатались.
- Независимое сопоставление итогового отчёта/proof/текущейВМ/GitHub/снимков пройдено, блокирующих расхождений нет. Осталось: commit/PR/обязательныйCI документов, затем порученное обычное выключение локального ПК. Финальное выключение ещё НЕ отправлено.

## Границы и навигация
- Секреты не читать/не печатать; рабочие данные не менять для тестов. Optional API-поля совместимы, fullsourceCAS сохранён. Demoизолирован от paidAI/рабочихзаписей.
- После SIGKILL проверять actualcontainer/restart/freeze/gates, не полагаться на отсутствие accepted.json. Восстановление рабочего приложения только с совместимым writer; данные произвольно не откатывать.
- Localdev127.0.0.1:8080 отдельно не останавливать. `.next-campus-demo` содержитjunction: не удалять рекурсивно. Поручено `shutdown.exe /s /t 0` без /f только после полной приёмки; ВМ остаётся работать.
- [План](plan.md) · [Прежний0.9.8](docs/release-0.9.8.md) · [Историядо099](docs/progress-history-before-099.md) · [Домен/TLS](docs/domain-canon-midis-ru.md).
