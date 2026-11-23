# Краткий контекст Канона0.9.7

Обновлено23ноября2026, Asia/Yekaterinburg. Последние поручения владельца реализованы и установлены; это навигатор для продолжения без перечитывания чатов.

- Сайт https://51.250.46.79/ работает:0.9.7, revision `027db7bbe925d254bdd76a0ebec94aeb92beda41`, healthy/ready200.
- Image `sha256:e6b8fd15c573624a9f7750f61fe1fbcada6ca31431e56b155df969c2dc7b80e1`; pin24-ui-097.conf, override `/var/lib/canon/ui097-f097n23a/image.override.yml`.
- КодPR5 merged какba325dda2739ac8e7c9a35b392f08d2cf10f6b22; финальные отчёты сохраняются отдельно без пересборки runtime.
- Вход в демо только/login, читаемый выход, запросы подтверждения по умолчанию закрыты, rewrite выше подробностей с focus/scroll после явного успеха. Public390px/клавиатура/0demoAPI PASS.
- Check/build/offline246, CI45085566925/45085573167 и полный fixture/HTTPS image PASS; независимое code+ops review GREEN.
- Ops final SHA remote097.sh73e7bcc7efe5743d02ea1124765bcf6646ab6be56c50541941a510b59d8cda93, compat097.py`a46c61656da7eed8807b38a0ffcfab1014ee0ffa85d3590d46be9f9e257a21b2`, verifier1fef18b65c264bf555721e05a5f809e582f7f158b2430eb17787712f014ccb1f.
- Архив8таблиц/86записей: `/var/lib/canon/ui097-f097n23a/backup/before-cutover-097.json`, SHA `b2e03132d80dc53dc969e0dfb5148609a214578ec24d366f5842a2faddc5a93b`. Verify+frozen-start inventory PASS (IDs/kinds/counts), запись/recovery открыты, restart unless-stopped.
- Первый preflight остановился без изменений на LF между systemd условиями; однострочная поправка протестирована/отдельно reviewed. Failed-log сохранён. Никакого bypass.
- Backend lib/app-api/deploy/backup CLI и зависимости равны061; прежние AI/Диск/YDB/нагрузка доказательства наследуются, не переименованы в новые проверки.
- Для061 были проверены realYDB28, restore8таблиц/81запись, AI6запросов/7вызовов(5полезных), Disk exactbytes+fault/retry, peak50 без ошибок. Новый86-снимок проверен, отдельный restore86 не запускался.
- 11pending не утверждать/удалять без решений ответственных. Старые48ce/0.9.5 writers запрещены; совместимый UIrollback только к061 без восстановления старой БД.
- Секреты/env/Config.Env не читать/не печатать; реальные данные не использовать для тестовых записей. Alibaba/домен/200 вне задачи.
- Собственные QA-контейнеры остановлены, воспроизводимый buildcache очищен; данные/volumes/backup не удалены. Localdev8080 не останавливать; `.next-campus-demo` содержит node_modules junction.
- После сохранения и публикации итогов пользователь явно поручил выключить Windows обычным способом без /f. До сдачи выключение не планировать.

[Полный отчёт0.9.7](release-0.9.7.md) · [Контракты0.9.6](followup-0.9.6-workflows.md) · [История приёмки061](followup-0.9.6-production.md).
