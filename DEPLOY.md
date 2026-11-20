# Технологическая инструкция по развёртыванию и защите сервера

Инструкция описывает развёртывание боевого контура системы «Канон кампуса „Южный Урал“» на выделенном Linux-сервере (ВМ в Yandex Cloud или сервер вузовского ЦОД) с настройкой межсетевого экрана, обратного прокси Nginx, базовых механизмов защиты ОС и TLS-сертификатов.

---

## Содержание

1. [Архитектура развёртывания и требования к серверу](#1-архитектура-развёртывания-и-требования-к-серверу)
2. [Что уже реализовано в приложении, а что настраивается на сервере](#2-что-уже-реализовано-в-приложении-а-что-настраивается-на-сервере)
3. [Базовая защита операционной системы и SSH](#3-базовая-защита-операционной-системы-и-ssh)
4. [Настройка межсетевого экрана (UFW) и Fail2ban](#4-настройка-межсетевого-экрана-ufw-и-fail2ban)
5. [Установка проекта и настройка боевого окружения](#5-установка-проекта-и-настройка-боевого-окружения)
6. [Запуск приложения через Docker Compose](#6-запуск-приложения-через-docker-compose)
7. [Настройка веб-сервера Nginx и базовых защит](#7-настройка-веб-сервера-nginx-и-базовых-защит)
8. [Выпуск и установка SSL/TLS сертификата](#8-выпуск-и-установка-ssltls-сертификата)
9. [Регламент проверки после запуска и резервное копирование](#9-регламент-проверки-после-запуска-и-резервное-копирование)

---

## 1. Архитектура развёртывания и требования к серверу

### Схема прохождения трафика

```text
Интернет / Сеть кампуса (HTTPS, порт 443)
        │
        ▼
[ Межсетевой экран UFW ]  (открыты только 22/tcp, 80/tcp, 443/tcp)
        │
        ▼
[ Веб-сервер Nginx ]      (TLS 1.2/1.3, HSTS, Rate Limit, лимит тела 2 МБ)
        │
        ▼  проксирование только внутри хоста (127.0.0.1:8080)
[ Приложение Next.js 16 ] (непривилегированный пользователь, проверка Origin и HMAC-кук)
        │
        ├──► Yandex Database (YDB), Document API
        ├──► Yandex AI Studio API (исходящий HTTPS 443, контур РФ)
        └──► Яндекс Диск REST API (исходящий HTTPS 443, авторезервирование .md и .csv)
```

### Минимальные системные требования
- **ОС**: Ubuntu 22.04 LTS / 24.04 LTS, Debian 12 или отечественные дистрибутивы (РЕД ОС, Astra Linux).
- **Ресурсы**: 2 vCPU, 4 ГБ ОЗУ, 25 ГБ SSD.
- **Среда выполнения**: Docker Engine 28.0+ с Docker Compose 2.30+. Node.js 24 входит в образ.
- **Доменное имя**: A-запись домена (например, `canon.campus74.ru`), направленная на публичный IP-адрес сервера.

---

## 2. Что уже реализовано в приложении, а что настраивается на сервере

Базовая прикладная безопасность и контейнеризация **уже встроены в код проекта**:
- Защита сессионных кук криптоподписью `HMAC-SHA256` с флагами `HttpOnly` / `SameSite=Lax` / `Secure` ([lib/auth-server.ts](lib/auth-server.ts)).
- Проверка заголовков `Origin` / `Host` на всех изменяющих запросах (CSRF-защита), индивидуальные ключи сотрудников, матрица ролей и прав 7 вузов.
- Серверное ограничение частоты запросов (`rate-limit`) на чувствительных эндпоинтах.
- Санитайзер персональных данных (152-ФЗ) и SSRF-фильтр внешних URL ([lib/alibaba-ai.ts](lib/alibaba-ai.ts)).
- Эндпоинт диагностики состояния ([app/api/health/route.ts](app/api/health/route.ts)), шаблон окружения ([.env.example](.env.example)), производственные [Dockerfile](Dockerfile) и [Compose](deploy/compose.prod.yml). Контейнер запускает процесс с `UID 1001` и проверяет HTTP-ответ через `HEALTHCHECK`.

Ниже описаны именно **внешние серверные шаги**, которые выполняются один раз на самой виртуальной машине при выводе сервиса в интернет по HTTPS (UFW, Fail2ban, SSH, Nginx, сертификат Let's Encrypt или УЦ РФ).

---

## 3. Базовая защита операционной системы и SSH

### 3.1. Обновление системы и учётная запись администратора

Войдите по SSH под существующим администратором ВМ. Это пользователь, которого облако создало при передаче публичного ключа. В отдельном сеансе убедитесь, что `sudo id -u` выводит `0`. Команды настройки ниже выполняются через `sudo` или в полученной через него оболочке администратора. Процесс приложения запускается отдельным непривилегированным пользователем внутри контейнера.

```bash
apt update && apt full-upgrade -y
apt install -y curl git ufw fail2ban nginx certbot unattended-upgrades
```

### 3.2. Защита SSH (`/etc/ssh/sshd_config`)
До изменения SSH откройте второй сеанс под тем же облачным администратором и проверьте доступ по ключу и через `sudo`. Первый сеанс держите открытым до повторной проверки после перезагрузки конфигурации.

В файле `/etc/ssh/sshd_config` установите параметры:

```text
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
MaxAuthTries 3
ClientAliveInterval 300
ClientAliveCountMax 2
X11Forwarding no
```

Примените конфигурацию:

```bash
sshd -t && systemctl reload ssh
```

Из нового окна снова проверьте вход по ключу и `sudo id -u`. При ограничении списка пользователей указывайте только проверенные административные логины. Если новый вход не работает, верните прежнюю настройку в оставленном открытым сеансе.

### 3.3. Автоматические обновления безопасности

```bash
dpkg-reconfigure -plow unattended-upgrades
```

---

## 4. Настройка межсетевого экрана (UFW) и Fail2ban

### 4.1. Правила фаервола UFW
Наружу открываются только порты `80`, `443` и `22`. Порты приложения (`8080`) и локальной базы (`8000`) наружу **не открываются**.

```bash
# Политика по умолчанию: запретить все входящие, разрешить исходящие
ufw default deny incoming
ufw default allow outgoing

# Разрешение SSH с защитой от перебора (не более 6 попыток за 30 секунд с одного IP)
ufw limit 22/tcp comment 'SSH rate limited'

# Разрешение HTTP и HTTPS для Nginx
ufw allow 80/tcp comment 'HTTP ACME and redirect'
ufw allow 443/tcp comment 'HTTPS production traffic'

# Включение фаервола
ufw enable
ufw status verbose
```

### 4.2. Настройка Fail2ban (`/etc/fail2ban/jail.local`)
Создайте файл `/etc/fail2ban/jail.local` для блокировки IP-адресов при атаках на SSH и Nginx:

```ini
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5
backend  = systemd

[sshd]
enabled = true

[nginx-http-auth]
enabled = true

[nginx-botsearch]
enabled = true

[nginx-limit-req]
enabled = true
filter  = nginx-limit-req
logpath = /var/log/nginx/*error.log
```

Перезапустите службу:

```bash
systemctl enable --now fail2ban
fail2ban-client status
```

---

## 5. Установка проекта и настройка боевого окружения

### 5.1. Проверка Docker Engine и Docker Compose

Установите Docker Engine 28.0 или новее с плагином Compose 2.30 или новее. В Docker Engine до 28.0 соседние серверы в том же сегменте сети могли обращаться к портам, опубликованным на localhost. [Установка Docker](https://docs.docker.com/engine/install/), [публикация портов](https://docs.docker.com/engine/network/port-publishing/).

```bash
docker version --format '{{.Server.Version}}'
docker compose version
```

### 5.2. Развёртывание кода проекта

```bash
git clone https://github.com/simonflows/campus-knowledge-base.git /opt/campus-knowledge-base/app
cd /opt/campus-knowledge-base/app
# Замените ПРОВЕРЕННЫЙ_SHA на идентификатор версии, прошедшей CI.
git switch --detach ПРОВЕРЕННЫЙ_SHA
```

<a id="pilot-access"></a>

### 5.3. Персональный доступ для сотрудников

1. Оператор проверяет личность сотрудника и полномочия по реестру участников пилота. Назначьте ему постоянный индивидуальный логин из строчных латинских букв, цифр, дефисов и подчёркиваний. Завершившие работу логины не передают другому человеку.
2. Выберите профиль из `demo-admin`, `demo-ministry`, `demo-rio`, `demo-chkk`, `demo-guest`, `demo-owner-<вуз>`, `demo-pr-<вуз>`. Идентификаторы вузов — `susu`, `csu`, `midis`, `susmu`, `sursau`, `mgtu`, `suspgu`. Профиль задаёт роль и зону ответственности существующих карточек. Закрепите как минимум одного координатора и руководителя каждого участвующего вуза.
3. На доверенном рабочем месте с Node.js оператор создаёт отдельный ключ для каждого человека. Команда выводит персональный ключ и его отпечаток. Передайте ключ один раз через корпоративный менеджер паролей, а отпечаток перенесите в серверный справочник.

```bash
node -e "const c=require('node:crypto'), k=c.randomBytes(32).toString('base64url'); console.log('accessKey',k); console.log('keyHash',c.createHash('sha256').update(k).digest('hex'))"
```

4. В защищённой форме VibeCraft или хранилище секретов инфраструктуры задайте `CAMPUS_PILOT_ACCOUNTS` как JSON-массив. Пример структуры одной строки ниже. Поле `keyHash` принимает 64 шестнадцатеричных символа из шага 3. У каждого человека свой логин и отпечаток.

```json
[{"login":"editor-midis-01","name":"Имя Фамилия","profile":"demo-pr-midis","keyHash":"<отпечаток>"}]
```

5. Тем же способом задайте общий для реплик `SESSION_SECRET` (оператор генерирует его командой `openssl rand -hex 32`) и внешний HTTPS-адрес `CAMPUS_PUBLIC_ORIGIN` без пути и завершающей косой черты. Для общей базы приложение использует `DOCUMENT_API_ENDPOINT`, `AWS_ACCESS_KEY_ID` и `AWS_SECRET_ACCESS_KEY`. Если `DOCUMENT_API_REGION` не задан, используется `ru-central1`. Для подключённых интеграций добавьте их серверные переменные. Команда `npm run setup` показывает имена переменных для каждой интеграции. Режим production и отключение демо задаёт конфигурация из [раздела 6](#6-запуск-приложения-через-docker-compose).
6. Примените конфигурацию ко всем экземплярам. Дождитесь обновления среды, откройте `/login` по публичному HTTPS и проверьте вход двух разных сотрудников. У автора появляется свой черновик, у руководителя своего вуза — только отправленная ему редакция. Межвузовский материал получает назначенный координатор. Посетителям доступны согласованные публикации. Старые статьи без отметки согласования доступны координатору и сотрудникам исходного вуза с прежним ID. Личные демонстрационные черновики автоматически сотрудникам не передаются.

**Отзыв и ротация.** Удалите строку сотрудника или замените отпечаток новым и обновите среду всех реплик. При следующем запросе сервер заново проверит запись и подпись. Смена `SESSION_SECRET` завершает все сессии. Каждая сессия истекает через восемь часов. Для публичного показа с выбором роли потребуется явный `CAMPUS_DEMO_LOGIN=true` на отдельном демонстрационном экземпляре с тестовыми данными. После переключения между режимами пользователи входят заново.

Перед запуском менеджер секретов на сервере предоставляет `/run/campus/runtime.env`, доступный только доверенному оператору Docker. Используйте одну строку `ИМЯ=значение` на переменную. Compose читает значения буквально, поэтому справочник JSON должен занимать одну строку без дополнительных кавычек вокруг массива. После перезагрузки хоста менеджер секретов должен снова предоставить файл перед следующим обновлением конфигурации. Доступ к Docker позволяет читать окружение запущенных контейнеров. Храните сборочный каталог и образ отдельно от рабочих значений.

---

## 6. Запуск приложения через Docker Compose

[Производственный Compose](deploy/compose.prod.yml) запускает один контейнер приложения. Порт на хосте привязан к `127.0.0.1:8080`. Контейнер работает без root, с файловой системой только для чтения и временными каталогами для кэша. Во время сборки [Dockerfile](Dockerfile) подставляет `NEXT_PUBLIC_DEMO_MODE=false` в клиентский код. Серверные значения поступают из файла окружения при создании контейнера.

**1. Соберите проверенную версию и проверьте настройки.** Сборка получает файлы выбранного коммита из Git. Выполняйте команды по порядку. При ошибке сначала устраняйте её.

```bash
cd /opt/campus-knowledge-base/app
export CAMPUS_RELEASE_TAG="$(git rev-parse HEAD)"
CAMPUS_RUNTIME_ENV_FILE=/dev/null docker compose --env-file /dev/null -f deploy/compose.prod.yml config --quiet
git archive "$CAMPUS_RELEASE_TAG" -- . \
  ':(exclude,glob)**/.env*' ':(exclude,glob)**/.data/**' ':(exclude,glob)**/*.pem' |
  docker build -f Dockerfile -t "campus-kb:$CAMPUS_RELEASE_TAG" -
docker compose --env-file /dev/null -f deploy/compose.prod.yml run --rm --no-deps app node --import tsx deploy/preflight.ts
```

Если Compose сообщает, что отсутствует `/run/campus/runtime.env`, проверьте его доставку менеджером секретов. [Проверка настроек](deploy/preflight.ts) выводит имена отсутствующих или неверно заданных переменных без их значений. Проверка выполняется и при каждом старте приложения.

**2. Запустите контейнер и подготовьте базу до подключения Nginx.** Миграцию запускайте одним оператором при первом развёртывании и при выпуске с изменениями схемы. Она создаёт недостающие таблицы. Проверку хранилища выполняйте при каждом выпуске.

```bash
docker compose --env-file /dev/null -f deploy/compose.prod.yml up --detach
docker compose --env-file /dev/null -f deploy/compose.prod.yml exec -T app npm run db:migrate
docker compose --env-file /dev/null -f deploy/compose.prod.yml run --rm --no-deps app npm run check:deploy-storage
docker compose --env-file /dev/null -f deploy/compose.prod.yml up --wait --wait-timeout 90
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8080/api/ready
```

Переходите к Nginx после успешных проверок. При ошибке старта посмотрите состояние контейнера командой `docker compose --env-file /dev/null -f deploy/compose.prod.yml ps`. Ошибки проверки настроек видны в выводе команды из первого шага.

`/api/health` проверяет процесс, а `/api/ready` проверяет доступность всех шести таблиц. Сбой готовности даёт `503`. Сначала создайте таблицы, затем дождитесь готовности. Подключите алерт по `/api/ready` и проверьте рабочую запись с правами приложения на тестовой YDB.

**3. Загрузите утверждённые записи и сверьте владельцев.** Обращение к сайту не наполняет базу. Координатор готовит JSON с полями `approvedBy`, `approvedAt` в ISO UTC и `cards`. Каждая запись содержит `id`, `status: "approved"` и поля своего типа карточки. Для совместного проекта включите `participantApprovals` всех участвующих вузов. Для персонального назначения добавьте `ownerIds` из реестра. Пользовательские типы должны существовать в выбранной БД. Сверьте даты, источники и содержание вне приложения до загрузки.

Сначала примените тот же порядок на тестовой YDB. Рабочий импорт запускает оператор после проверки конфигурации, снимка базы и dry-run. Файл хранится вне репозитория и монтируется только для чтения. Дайте UID 1001 право чтения файла через владельца или файловый ACL без разрешения для остальных пользователей.

```bash
docker compose --env-file /dev/null -f deploy/compose.prod.yml run --rm --no-deps \
  -v /secure/approved-knowledge.json:/tmp/approved-knowledge.json:ro \
  app npm run db:import-approved-knowledge -- /tmp/approved-knowledge.json
# После сверки добавьте --apply после пути к файлу.
```

Команда проверяет весь входной файл до записи. С `--apply` она добавляет отсутствующие ID условной записью и оставляет существующие карточки. Если запись прервалась, повторите тот же проверенный файл и сверьте число добавленных и сохранённых. Проверьте публичный вид карточек до открытия прокси. Персональный ID пилота имеет вид `pilot-<login>`. Закрепите неоднозначные старые карточки за конкретными аккаунтами в форме координатора перед изменением реестра. Уже выданный логин принадлежит одному человеку.

Команда `npm run check:disk-sync` читает метаданные утверждённых записей. Она возвращает агрегаты очереди, дату последней полной выгрузки и код `0` при пустой очереди и выгрузке за последние сутки. Код `1` требует проверить отставание, ошибки или отсутствие недавних изменений. Код `2` означает, что метаданные прочитать не удалось. Перед открытием доступа проверьте реальную запись на Диск и ручной повтор после частичного отказа. Подключите периодическое оповещение на стороне своего мониторинга.

---

## 7. Настройка веб-сервера Nginx и базовых защит

### 7.1. Глобальные параметры безопасности (`/etc/nginx/nginx.conf`)
Внутри блока `http { ... }` в `/etc/nginx/nginx.conf` скройте версию Nginx и добавьте зоны ограничения частоты запросов (защита от DDoS и перебора):

```nginx
server_tokens off;

# Общий лимит для API: 10 запросов в секунду с одного IP
limit_req_zone $binary_remote_addr zone=api_general:10m rate=10r/s;

# Жёсткий лимит для авторизации и тяжёлых вызовов ИИ: 15 запросов в минуту
limit_req_zone $binary_remote_addr zone=api_strict:10m rate=15r/m;
```

### 7.2. Виртуальный хост сайта (`/etc/nginx/sites-available/campus-kb.conf`)
Замените `canon.campus74.ru` на ваш реальный домен.

```nginx
upstream campus_nextjs {
    server 127.0.0.1:8080;
    keepalive 32;
}

server {
    listen 80;
    listen [::]:80;
    server_name canon.campus74.ru;

    # Директория для проверки домена Let's Encrypt (ACME Challenge)
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name canon.campus74.ru;

    # Пути к сертификату, выданному в разделе 8
    ssl_certificate     /etc/letsencrypt/live/canon.campus74.ru/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/canon.campus74.ru/privkey.pem;

    # Современные параметры TLS
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;

    # Ограничение размера запросов и таймаутов (защита от Slowloris и переполнения памяти)
    client_max_body_size 2m;
    client_body_timeout 10s;
    client_header_timeout 10s;

    # Заголовки безопасности браузера
    add_header Strict-Transport-Security "max-age=86400" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;

    # Блокировка попыток обращения к скрытым файлам (.env, .git, .data)
    location ~ /\.(?!well-known) {
        deny all;
        access_log off;
        log_not_found off;
    }

    # Долгосрочное кэширование неизменяемой статики Next.js
    location /_next/static/ {
        proxy_pass http://campus_nextjs;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        expires 365d;
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    # Жёсткое ограничение частоты на вход и ИИ-генерацию
    location ~ ^/api/(auth/session|editor/generate|benchmark|system/status) {
        limit_req zone=api_strict burst=5 nodelay;
        limit_req_status 429;

        proxy_pass http://campus_nextjs;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }

    # Остальные API-маршруты
    location /api/ {
        limit_req zone=api_general burst=20 nodelay;
        limit_req_status 429;

        proxy_pass http://campus_nextjs;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Основные страницы приложения
    location / {
        proxy_pass http://campus_nextjs;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Для проверки источника браузерных запросов задайте в `CAMPUS_PUBLIC_ORIGIN` внешний адрес приложения с протоколом, например `https://canon.campus74.ru`. Приложение сверяет с ним заголовок `Origin`.

`CAMPUS_TRUST_PROXY=true` разрешает учитывать IP клиента из `X-Forwarded-For` при ограничении попыток входа. Включайте его, когда к порту приложения обращается только доверенный прокси, который перезаписывает этот заголовок проверенным IP. В конфигурации Nginx выше используется адрес непосредственного клиента `$remote_addr`. По умолчанию ограничение попыток входа действует по учётной записи.

На пилоте используйте один Nginx для общего лимита всех экземпляров приложения. При нескольких входных прокси настройте общий внешний лимит до расширения. Проверьте перезапись заголовка с адресом клиента и срабатывание `429` на тестовых аккаунтах.

---

## 8. Выпуск и установка SSL/TLS сертификата

### Вариант 1. Автоматический бесплатный сертификат Let's Encrypt (Certbot)

1. После привязки DNS и открытия порта 80 сохраните временный HTTP-блок в `/etc/nginx/sites-available/campus-kb.conf`. Подставьте согласованный домен. Этот блок нужен, пока файлов сертификата ещё нет.

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name canon.campus74.ru;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 404;
    }
}
```

2. Включите временный сайт, проверьте конфигурацию и выпустите сертификат. В команде подставьте тот же домен и действующий почтовый адрес.

```bash
ln -s /etc/nginx/sites-available/campus-kb.conf /etc/nginx/sites-enabled/campus-kb.conf
nginx -t && systemctl reload nginx
certbot certonly --webroot -w /var/www/html -d canon.campus74.ru \
  --cert-name canon.campus74.ru --non-interactive --agree-tos -m admin@campus74.ru
```

3. После успешной выдачи сертификата замените временный файл полным конфигом из раздела 7.2. Сохраните тот же домен и пути к выданному сертификату. Проверьте конфигурацию, перезагрузите Nginx и проверьте HTTPS.

```bash
nginx -t && systemctl reload nginx
curl -fsS https://canon.campus74.ru/api/health
```

4. Для обновления сертификата в работающем Nginx сохраните скрипт в `/etc/letsencrypt/renewal-hooks/deploy/reload-campus-nginx` с правом выполнения.

```sh
#!/bin/sh
exec systemctl reload nginx
```

Проверьте таймер и пробное продление.

```bash
systemctl status certbot.timer
certbot renew --dry-run
```

### Вариант 2. Корпоративный сертификат вуза или сертификат НУЦ Минцифры РФ

Если используется сертификат, выданный удостоверяющим центром Минцифры России (Госуслуги) или коммерческим УЦ:

1. Объедините сертификат домена и промежуточные сертификаты УЦ в один файл цепочки и разместите ключи в защищённой директории:

```bash
mkdir -p /etc/ssl/campus-kb
cat canon_campus74_ru.crt intermediate_ca.crt > /etc/ssl/campus-kb/fullchain.pem
cp canon_campus74_ru.key /etc/ssl/campus-kb/privkey.pem

chown -R root:root /etc/ssl/campus-kb
chmod 644 /etc/ssl/campus-kb/fullchain.pem
chmod 600 /etc/ssl/campus-kb/privkey.pem
```

2. В файле `/etc/nginx/sites-available/campus-kb.conf` укажите пути:

```nginx
ssl_certificate     /etc/ssl/campus-kb/fullchain.pem;
ssl_certificate_key /etc/ssl/campus-kb/privkey.pem;
```

3. Включите сайт, если ссылка ещё не создана, примените настройки и проверьте внешний HTTPS.

```bash
if [ ! -e /etc/nginx/sites-enabled/campus-kb.conf ] && [ ! -L /etc/nginx/sites-enabled/campus-kb.conf ]; then
  ln -s /etc/nginx/sites-available/campus-kb.conf /etc/nginx/sites-enabled/campus-kb.conf
fi
nginx -t && systemctl reload nginx
curl -fsS https://canon.campus74.ru/api/health
```

---

## 9. Регламент проверки после запуска и резервное копирование

### 9.1. Контрольный чек-лист после деплоя

```bash
# 1. Проверка статуса HTTPS и заголовков безопасности
curl -I https://canon.campus74.ru

# 2. Проверка эндпоинта состояния сервиса
curl -s https://canon.campus74.ru/api/health
curl --fail --silent --show-error https://canon.campus74.ru/api/ready

# 3. Проверка того, что порт 8080 закрыт извне (выполняется с другой машины)
nc -zv canon.campus74.ru 8080
# Должно вернуть: Connection timed out / Connection refused
```

### 9.2. Обновление версии и откат

[CI](.github/workflows/ci.yml) проверяет каждый push и pull request. Оператор GitHub назначает `Quality gate` обязательной проверкой защищённой ветки `main`.

1. Запишите текущую метку образа и сохраните этот образ. Выполните `git fetch origin` и `git switch --detach ПРОВЕРЕННЫЙ_SHA` для версии, прошедшей CI.
2. Повторите сборку и проверку настроек из [раздела 6](#6-запуск-приложения-через-docker-compose), пока работает текущая версия. Заменяйте контейнер в согласованное окно обслуживания. Если выпуск меняет схему, ограничьте доступ через прокси до завершения миграции и проверки хранилища.
3. При проблеме вернитесь к прежней версии репозитория командой `git switch --detach ПРЕЖНИЙ_SHA`, установите `export CAMPUS_RELEASE_TAG=ПРЕЖНИЙ_SHA` и запустите `docker compose --env-file /dev/null -f deploy/compose.prod.yml up --wait --wait-timeout 90`. Затем повторите контрольные проверки. Откат образа допускается, пока изменения схемы совместимы с прежней версией. Созданные таблицы остаются в общей базе.

### 9.3. Резервные версии и локальное демо
Production использует Document API; при его недоступности локальная запись не включается автоматически. `CAMPUS_LOCAL_DEMO=true` действует только вне production и сохраняет прежние `.data`-данные. Повреждённый файл или неизвестная версия не заменяются примерами; предыдущий корректный файл находится в `.data/local-store.json.bak`.

Для общего хранилища пройдите [проверку управляемой копии и восстановления в отдельную базу](deploy/backup/README.md) до подключения сотрудников.

На Яндекс Диск выгружаются утверждённые MD и снимки CSV. Имена начинаются с ISO UTC версии данных, а CSV содержит путь к неизменяемому файлу и метку согласованного снимка. Сортировать нужно по имени версии, не по времени загрузки. В корне выгружается `_КАК_ЧИТАТЬ_РЕЗЕРВ.md`. Совместная карточка физически хранится в `02_Совместные_проекты`; папки вузов содержат только `.link.md` указатели. Незавершённая выгрузка сохраняет статус и повторяется без перезаписи другой версии. Реальная облачная запись не проверялась в регрессионных тестах: транспорт заменён локальным fake.

Следующая команда применима только к отдельно включённому локальному демо, а не к production Document API. Для локального файла можно настроить `/etc/cron.daily/campus-kb-backup`:

```bash
#!/bin/sh
mkdir -p /var/backups/campus-kb
cp /opt/campus-knowledge-base/app/.data/local-store.json \
   "/var/backups/campus-kb/local-store-$(date +%F).json" 2>/dev/null || true
find /var/backups/campus-kb -type f -mtime +30 -delete
```

```bash
chmod +x /etc/cron.daily/campus-kb-backup
```

### 9.4. Долговечный Docker-том и прежние контейнеры

Новый Compose хранит SQLite-файлы DynamoDB Local в именованном томе `campus-knowledge-dynamodb-data`, подключённом к `/home/dynamodblocal/data`; `-dbPath ./data` задан явно. Порт БД доступен только на `127.0.0.1:8000`; приложение внутри Compose обращается к сервису по внутренней сети. Это соответствует [рекомендации AWS по постоянному каталогу DynamoDB Local](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.DownloadingAndRunning.html).

Если прежний контейнер запускался без тома, его база находится внутри файловой системы контейнера. **Не пересоздавайте его до переноса.** Пункт `[5]` лаунчера проверяет mounts и отказывается менять такой контейнер. Простое добавление нового пустого тома не переносит существующие данные.

1. Проверьте только mounts, не выгружая переменные окружения: `docker inspect --format '{{json .Mounts}}' dynamodb-local`. Сохраните имена прежних томов и сам прежний контейнер.
2. В согласованное окно обслуживания приостановите записи и получите согласованный снимок всей базы: все файлы SQLite и журналы, либо полный экспорт всех таблиц. Копия одного активно изменяемого `.db` не является согласованным снимком. Не удаляйте старый контейнер или прежние тома. Снимок существующего тома/контейнера и экспорт держите отдельно от нового тома.
3. На отдельном тестовом экземпляре восстановите снимок/экспорт в новый том. Проверьте ID и количества карточек, статей, редакционных документов/ревизий и межвузовских запросов, а также связи и последние утверждённые версии. Миграция схемы добавляет таблицы и не заменяет записи.
4. Только после сверки и согласованного переключения используйте новый Compose. Старый контейнер, прежний том и проверенный снимок сохраняйте до завершения приёмки; удаление томов не входит в процедуру запуска. При ошибке вернитесь к сохранённому экземпляру.

Этот перенос реальных данных автоматически не выполняется. В текущей среде Docker отсутствует, поэтому долговечность проверена конфигурацией и локальными тестами, без пересоздания контейнеров пользователя. На Windows без Docker укажите внешний `DOCUMENT_API_ENDPOINT` через штатную безопасную настройку окружения и выберите `[1]`; отдельная установка сервиса на компьютер не нужна.
