# Приёмка Канона 1.0.0 из CI

Выпуск принимает только образ после успешного запуска `CI` для нужного коммита `main` в `simonflows/campus-knowledge-base`. В одном артефакте `canon-release-image` находятся образ, его ID и SHA-256 и `git archive` того же коммита. Для проверки используются ответы GitHub API о запуске, обязательной задаче `Quality gate` и артефакте. [Артефакты GitHub Actions](https://docs.github.com/en/rest/actions/artifacts), [задачи GitHub Actions](https://docs.github.com/en/rest/actions/workflow-jobs).

## Проверка и передача артефакта

1. На доверенной машине оператора с настроенным `gh` возьмите ID запуска `CI` для события `push` в `main` и ID его артефакта `canon-release-image`. Сохраните ZIP через GitHub API без преобразования байтов. В PowerShell можно направить вывод `gh` в бинарный файл через Python.

   ```powershell
   python -c "import subprocess, sys; f = open(sys.argv[2], 'xb'); subprocess.run(['gh', 'api', '--hostname', 'github.com', 'repos/simonflows/campus-knowledge-base/actions/artifacts/' + sys.argv[1] + '/zip'], stdout=f, check=True)" $artifactId candidate.zip
   python -B deploy/ci_image_load_100.py verify $revision $githubRunId candidate.zip candidate-verified
   ```

2. Перенесите `ci-provenance.json` и `canon-release-source.tar.gz` из `candidate-verified` в новый каталог `/var/lib/canon/build100-<revision>` с владельцем `root:root` и режимом `0700`. Установите оба файла с владельцем `root:root` и режимом `0600`. Квитанция фиксирует проверенные на машине оператора сведения. На ВМ передаются квитанция и артефакты с указанными в ней контрольными суммами. Учётные данные `gh` остаются на машине оператора.
3. Скопируйте проверенный `deploy/ci_image_load_100.py` из того же коммита в каталог инструментов на ВМ, доступный на запись только root. Передайте `canon-release-image.tar.gz` через стандартный ввод по уже настроенному SSH или другому доверенному каналу, работающему с двоичными данными. На ВМ команда запускается от root.

   ```sh
   /usr/bin/python3 -B /path/to/ci_image_load_100.py load "$revision"
   ```

4. Загрузчик сверяет размер и SHA-256 потока, ID и метки образа, создаёт и удаляет остановленный контейнер для проверки доступности слоёв. Каталог `source` строится из проверенного архива. До запуска переключения `ci-image-receipt.json` и полный список файлов, типов, признаков исполняемости и хешей дерева будут проверены повторно. Точная контрольная сумма ZIP остаётся в квитанции. Исходный ZIP хранится у оператора для повторной проверки. Образ и ZIP на диск ВМ не выгружаются.

## Запуск и результат

Подготовьте штатный runtime 1.0.0. Проверка требует рабочую пару Яндекс OAuth, `CAMPUS_YANDEX_OAUTH_ENABLED=true`, `CAMPUS_EMAIL_ACCOUNTS_ENABLED=false`, `CAMPUS_PUBLIC_ORIGIN=https://canon.midis.ru` и действующий ключ сессии. Приёмку запускайте из полного проверенного дерева без записи Python bytecode.

```sh
/usr/bin/python3 -B "/var/lib/canon/build100-$revision/source/deploy/release-100.py" "$revision" "$image" f100n26a
```

До открытия записей скрипт проверяет обе резервные копии с восстановлением в отдельные таблицы и подтверждает неизменность исходных записей. В замороженном режиме он проверяет `GET` и `HEAD` callback на `503` без `Set-Cookie`. После открытия проверяет HTTPS POST начала входа через Яндекс, не переходит по редиректу и не отправляет код callback. Полный OAuth-вход проверяется отдельно после приёмки.

Результат хранится в `/var/lib/canon/release100-f100n26a/accepted.json` или, при завершившемся откате, в `rollback.json`. Автоматический откат возвращает приложение 0.9.9 и оставляет новые пустые или уже использованные таблицы на месте. При сбое до публикации квитанции сверяйте активную версию, состояние systemd, наличие `28-release-100.conf` и проверенные файлы выпуска. Сохраняйте каталог попытки для разбора.
