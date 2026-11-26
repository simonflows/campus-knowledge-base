# DNS для служебной почты Канона

Администратору DNS домена `midis.ru`: для подтверждения отправителя `noreply@canon.midis.ru` в Yandex Cloud Postbox добавьте две записи. TTL: 600 секунд (либо штатное значение провайдера).

| Тип | Полное имя | Значение |
| --- | --- | --- |
| CNAME | `egtppb46jklhns53tsfl-1._domainkey.canon.midis.ru.` | `egtppb46jklhns53tsfl-1.dkim.pstbx.ru.` |
| CNAME | `egtppb46jklhns53tsfl-2._domainkey.canon.midis.ru.` | `egtppb46jklhns53tsfl-2.dkim.pstbx.ru.` |

Если панель автоматически дописывает зону `midis.ru`, в поле имени укажите соответственно `egtppb46jklhns53tsfl-1._domainkey.canon` и `egtppb46jklhns53tsfl-2._domainkey.canon`. Значения — полные доменные имена из таблицы; конечная точка предотвращает дописывание зоны, если панель её поддерживает.

Это публичные DNS-записи DKIM, не приватные ключи. Существующие A/MX/TXT записи университета менять не требуется. После распространения записей Postbox автоматически перепроверяет владение; при необходимости проверка запускается в карточке адреса. Повторный выпуск приложения для подтверждения DNS не нужен.

Отправитель создан 26 ноября 2026 в каталоге проекта, ID `egtppb46jklhns53tsfl`, разрешён только `noreply@canon.midis.ru`. На момент подготовки записи ещё не подтверждены. До подтверждения рабочую доставку и регистрацию через email нельзя считать принятыми.

[Адрес в Postbox](https://console.yandex.cloud/folders/b1g82qrlkg0lk5umk9h4/postbox/identity/egtppb46jklhns53tsfl/overview) · [Официальная проверка владения](https://yandex.cloud/ru/docs/postbox/operations/check-domain).
