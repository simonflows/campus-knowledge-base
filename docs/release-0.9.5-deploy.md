# Обновление действующего пилота 0.9.0 → 0.9.5

Порядок для существующей ВМ `/opt/campus-knowledge-base/app`. Выпуск разрешён поручением владельца. Применять после локальных обязательных проверок и независимого ревью. Новых облачных ресурсов, аккаунтов, домена, расходов или публичного registry не требуется. Все команды Docker на этой ВМ выполняются через `sudo -n`. Секреты передаются штатным `/run/campus/runtime.env`; не выводить файл, окружение контейнера или каталог аккаунтов.

## Подготовка без остановки пилота

1. Проверить чистоту локального release worktree и серверного checkout, отсутствие чужой работы. Сохранить точный действующий SHA, image ID, image tag, пути Compose/systemd и эффективный `CAMPUS_RELEASE_TAG`, не читая другие значения. Предыдущий проверенный выпуск: `8aa0b2dda6d418cbbbccb14aaaf6a1e565c0c5ea`; фактические значения повторно сверяются перед переключением.
2. После проверок и ревью создать локальный commit и доставить на ВМ Git bundle только согласованной ветки относительно общего предка. Это не `git push`. Проверить bundle и итоговый SHA, сохранить прежнюю ветку. Не заменять незакоммиченные серверные файлы. Переключить чистый checkout на выбранный release SHA.
3. Собрать из `git archive` точного SHA, без файлов окружения/локальных данных. Семантический тег и SHA должны обозначать один image ID:

```sh
set -eu
cd /opt/campus-knowledge-base/app
CAMPUS_RELEASE_TAG=$(git rev-parse HEAD)
export CAMPUS_RELEASE_TAG
git archive "$CAMPUS_RELEASE_TAG" -- . \
  ':(exclude,glob)**/.env*' ':(exclude,glob)**/.data/**' ':(exclude,glob)**/*.pem' |
  sudo -n docker build --build-arg "VCS_REF=$CAMPUS_RELEASE_TAG" \
    -t "campus-kb:$CAMPUS_RELEASE_TAG" -t campus-kb:0.9.5 -
sudo -n docker image inspect --format '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}} {{index .Config.Labels "org.opencontainers.image.version"}}' "campus-kb:$CAMPUS_RELEASE_TAG"
```

4. Проверить именно этот образ в отдельной Docker QA-сети, с новым выделенным префиксом YDB, синтетическими логинами, отдельным runtime-файлом и loopback `127.0.0.2:8080`. Рабочие таблицы и AI/Диск приложению недоступны. Внутренний HTTPS relay из исходников монтируется отдельно: runtime-образ не содержит его в `/app/deploy`. Relay запрещает CreateTable, поэтому схему создаёт только прямой guarded-тест следующего шага. У основного контейнера остаётся `127.0.0.1:8080`.

Подготовка выполняется root-оператором после присвоения `CAMPUS_RELEASE_TAG` точному SHA. Каталог и имена должны быть новыми; при существующем контейнере/артефакте не заменять его автоматически. Команды ниже выполняются в одной root-shell (`sudo -n bash`), без `set -x`:

```sh
set -eu
umask 077
cd /opt/campus-knowledge-base/app
QA_DIR=/var/lib/canon/qa095-image-20261122-a1
QA_PREFIX=qa095-image-20261122-a1-
IMAGE="campus-kb:$CAMPUS_RELEASE_TAG"
test ! -e "$QA_DIR"
install -d -m 0700 "$QA_DIR"
docker network create kanon095-qa
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -sha256 \
  -subj '/CN=Disposable Canon QA root' -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign' -keyout "$QA_DIR/ca.key" -out "$QA_DIR/ca.crt"
openssl req -new -newkey rsa:2048 -nodes -sha256 -subj '/CN=qa-document-api' \
  -addext 'subjectAltName=DNS:qa-document-api' -addext 'basicConstraints=critical,CA:FALSE' \
  -addext 'extendedKeyUsage=serverAuth' -addext 'keyUsage=critical,digitalSignature,keyEncipherment' \
  -keyout "$QA_DIR/tls.key" -out "$QA_DIR/tls.csr"
openssl x509 -req -in "$QA_DIR/tls.csr" -days 1 -sha256 -set_serial 1 \
  -CA "$QA_DIR/ca.crt" -CAkey "$QA_DIR/ca.key" -copy_extensions copy -out "$QA_DIR/tls.crt"
chmod 0444 "$QA_DIR/ca.crt"
openssl verify -CAfile "$QA_DIR/ca.crt" -purpose sslserver -verify_hostname qa-document-api "$QA_DIR/tls.crt"
docker run --rm --user 0:0 --read-only --tmpfs /tmp \
  -v "$QA_DIR:/qa" -e CAMPUS_QA_IMAGE_DIR=/qa "$IMAGE" node scripts/qa-image-smoke.mjs prepare
docker run -d --name kanon095-qa-relay --network kanon095-qa --network-alias qa-document-api \
  --user 0:0 --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  --env-file /run/campus/runtime.env -e CAMPUS_RELEASE_STORAGE_TEST=yes -e CAMPUS_RELEASE_QA_PREFIX="$QA_PREFIX" \
  -v "$PWD/deploy/qa-ydb-relay.mjs:/app/deploy/qa-ydb-relay.mjs:ro" \
  -v "$QA_DIR/tls.key:/run/qa-tls.key:ro" -v "$QA_DIR/tls.crt:/run/qa-tls.crt:ro" \
  "$IMAGE" node deploy/qa-ydb-relay.mjs
docker run -d --name kanon095-qa-app --network kanon095-qa \
  --read-only --tmpfs /tmp:mode=1777 --tmpfs /app/.next/cache:uid=1001,gid=1001,mode=0700 \
  --cap-drop ALL --security-opt no-new-privileges --memory 768m --cpus 1 \
  --env-file "$QA_DIR/runtime.env" -e NODE_ENV=production -e USE_DATABASE=true \
  -e NODE_EXTRA_CA_CERTS=/run/qa-ca.crt -v "$QA_DIR/ca.crt:/run/qa-ca.crt:ro" \
  -p 127.0.0.2:8080:8080 "$IMAGE"
docker run --rm --network host --user 0:0 --read-only --tmpfs /tmp \
  -v "$QA_DIR:/qa:ro" -e CAMPUS_QA_IMAGE_DIR=/qa \
  -e CAMPUS_QA_IMAGE_ORIGIN=http://127.0.0.2:8080 "$IMAGE" node scripts/qa-image-smoke.mjs empty
```

`runtime.env` и `client.key` здесь содержат только новые синтетические учётные данные. Ключи рабочей YDB передаются лишь relay через штатный root-only runtime-файл; 8443 не публикуется на хост. Приложение не получает их. Права ключа TLS и синтетического runtime остаются `0600`.

5. После подтверждённых health200/ready503 на **том же** `$QA_PREFIX` выполнить протокольный тест напрямую через существующую YDB:

```sh
sudo -n docker run --rm --env-file /run/campus/runtime.env \
  -e USE_DATABASE=true -e CAMPUS_RELEASE_STORAGE_TEST=yes \
  -e CAMPUS_RELEASE_QA_PREFIX="$QA_PREFIX" \
  --read-only --tmpfs /tmp:mode=1777 \
  "campus-kb:$CAMPUS_RELEASE_TAG" node --import tsx scripts/test-release-storage.ts
```

Префикс должен быть новым для независимого прогона. Тест проверяет точный allowlist восьми имён, отказывается от операций с рабочими таблицами, не перечисляет их и не вызывает AI/Диск. Он создаёт только свои таблицы и синтетические записи, включая условно записанный и прочитанный marker. Из его JSON-вывода передать `marker` как `CAMPUS_QA_MARKER`, не выводя никакие значения runtime. Затем выполнить (в той же root-shell):

```sh
docker run --rm --network host --user 0:0 --read-only --tmpfs /tmp \
  -v "$QA_DIR:/qa:ro" -e CAMPUS_QA_IMAGE_DIR=/qa \
  -e CAMPUS_QA_IMAGE_ORIGIN=http://127.0.0.2:8080 \
  -e CAMPUS_QA_MARKER="$CAMPUS_QA_MARKER" -e CAMPUS_QA_EXPECT_REVISION="$CAMPUS_RELEASE_TAG" \
  "$IMAGE" node scripts/qa-image-smoke.mjs verify
```

Фиксируются ready200, версия0.9.5 и точный SHA, marker, вход, новый черновик и ревизия. Прогон через DynamoDB Local и unit-тесты relay этих проверок не заменяют.

## Согласованная копия и проверка восстановления

6. Подготовить отдельный root-only каталог резервирования вне репозитория (`0700`). Сохранить прежние systemd unit/drop-ins и несекретную конфигурацию Compose. Старый Docker-образ оставить. Не перезаписывать существующие backup-файлы.
7. Остановить `kanon.service` и проверить отсутствие рабочего web-контейнера/писателей. На время копирования HTTPS может отвечать ошибкой upstream. Создать отдельный maintenance-контейнер нового образа. Пользователь `0:0` нужен только этой операции для доступа к каталогу `0700` и архиву `0600`; штатный web-контейнер сохраняет UID1001. Пакет смонтировать при создании, позднее добавить mount существующему контейнеру нельзя:

```sh
BACKUP_DIR=/var/lib/canon/backup095-20261122-a1
test ! -e "$BACKUP_DIR"
install -d -m 0700 "$BACKUP_DIR"
systemctl stop kanon.service
test -z "$(docker ps --filter name=campus-kb-prod-app-1 --format '{{.ID}}')"
docker run -d --name kanon095-maintenance --user 0:0 --read-only --no-healthcheck --tmpfs /tmp:mode=1777 \
  --cap-drop ALL --security-opt no-new-privileges --env-file /run/campus/runtime.env \
  -e USE_DATABASE=true -e CAMPUS_DEMO_LOGIN=false -e CAMPUS_LOCAL_DEMO=false \
  -e CAMPUS_FULL_LOCAL_DEMO=false -e SEED_DEMO_ARTICLES=false \
  -v "$BACKUP_DIR:/backup" -v "$PWD/data:/package:ro" \
  --entrypoint tail "$IMAGE" -f /dev/null
```
8. Выполнить через maintenance-контейнер:

```sh
sudo -n docker exec kanon095-maintenance node --import tsx scripts/database-backup.ts \
  snapshot /backup/before-095.json --writers-stopped --pre-0.9.5
sudo -n docker exec kanon095-maintenance node --import tsx scripts/database-backup.ts verify /backup/before-095.json
sudo -n docker exec kanon095-maintenance node --import tsx scripts/database-backup.ts \
  restore /backup/before-095.json --prefix qa095-backup-20261122-a1-
```

Первые две новые таблицы должны отсутствовать до миграции. Снимок содержит шесть существующих таблиц целиком, количества, схемы и SHA. Восстановление проверяет все строки и хеши, отказывается от занятых целей. После восстановления допроверить миграцию и транзакции на том же изолированном префиксе. Если копия/восстановление не прошли, рабочую схему не менять и вернуть прежний сервис.

9. Проверить запуск предыдущего образа с мигрированной копией. После restore выполнить прямой guarded-тест с `CAMPUS_RELEASE_QA_PREFIX=qa095-backup-20261122-a1-`, сохранить выданный marker. Остановить и удалить только собственные `kanon095-qa-app` и `kanon095-qa-relay`, заново создать relay по команде выше с префиксом копии. Приложение QA создать из `campus-kb:8aa0b2dda6d418cbbbccb14aaaf6a1e565c0c5ea` с теми же синтетическими env/CA/портом. Выполнить `qa-image-smoke.mjs verify` из нового образа, передав marker копии и **не задавая** `CAMPUS_QA_EXPECT_REVISION` (у старого образа нет этого контракта). Это проверяет старый запуск, ready, вход и запись/чтение синтетического черновика исключительно в копии. Ни relay, ни старый QA-образ не обращаются к рабочим таблицам. Этот тест не разрешает старому приложению продолжать рабочую запись после отката.

## Миграция, импорт и переключение

10. При остановленных рабочих писателях запустить **через Docker exec** `npm run db:migrate` в maintenance-контейнере, затем повторить миграцию и `npm run check:deploy-storage`. Существующие шесть таблиц/записи сохраняются; добавляются `knowledge-card-versions` и `workflow-records`. Новый web-контейнер до этого не запускать.
11. В maintenance-контейнере пакет уже смонтирован read-only. Сначала `node --import tsx scripts/import-reviewed-package.ts /package/pilot-0.9.5-candidates.json /package/pilot-0.9.5-verification.json` через `docker exec` без флагов. Сверить SHA `e3008af41c1050cdd3ace235357dcf693f02cdd588b38eda7e7f8e4ad9a4cc42`, покрытие 27 ID, 16 разрешённых к утверждению и 11 pending. Различающиеся существующие ID сохраняются и требуют отдельного разбора; число реальных новых записей определяется dry-run.
12. Применить тот же пакет с `--apply --sync`. Повторить для проверки отсутствия дублей и безопасного повтора частичного сбоя. Нельзя выдумывать именных владельцев/подтверждения участников. Проверить реальное содержимое Markdown и CSV на Диске с помощью существующего подключения, состав папки и соответствие текущей версии. Сохранить последнюю полную выгрузку при частичной ошибке.
13. Добавить отдельный systemd drop-in для `kanon.service` с `Environment=CAMPUS_RELEASE_TAG=<полный новый SHA>`, сохранив старый drop-in. Выполнить `systemctl daemon-reload`; проверить только эффективный release tag. Запустить `kanon.service`. Он использует тот же Compose и runtime-loader. Не менять SSH, Nginx, домен, Lockbox или реестр аккаунтов.
14. Проверить контейнер healthy и image ID, `/api/health`, `/api/ready` и `/api/version` по loopback и публичному HTTPS. Версия должна быть `0.9.5`, revision — точный SHA, а не `local`. Пройти доступные роли, карточки/историю, поиск, аналитику, проверку текста, редактор/DOCX, очередь и выгрузку. Малый живой прогон Flash выполняется отдельно от автотестов, только с разрешёнными публичными материалами и действующими лимитами.
15. Записать фактические SHA/image ID/теги, архив SHA и путь без данных, результаты восстановления/YDB/образа, количества импорта, MD/CSV и ограничения. Только после этого отмечать выпуск завершённым. Удалять разрешено лишь собственные временные контейнеры/сеть/TLS/тестовые артефакты; архив и предыдущий образ сохраняются.

## Откат

При неуспехе до миграции вернуть прежний systemd release tag и сервис. После добавочной миграции новые таблицы и необязательные поля можно оставить, но **обычный старый рабочий сервис не запускать**: у него нет технического режима блокировки записей новых протоколов. Оставить `kanon.service` остановленным (maintenance), сохранить отдельный полный архив восьми таблиц и выпускать исправленный проверенный 0.9.5. Сохранённый старый образ пригоден для изолированной проверки на копии и анализа; его наличие не означает безопасный возврат старого писателя. Публичный read-only откат возможен лишь после отдельной реализации и проверки технического запрета всех записей.

Полное восстановление выполняется из проверенного архива в отдельную пустую БД с повторной проверкой и отдельным управляемым переключением. Существующие рабочие таблицы не очищать. Если фактическая ошибка требует изменения адреса базы или прав вне поручения, это отдельный блокер, а не разрешение на переписывание данных.
