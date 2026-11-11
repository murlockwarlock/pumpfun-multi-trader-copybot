# Диагностика доступа к серверу copybot

Из локального окружения, где запускается PowerShell, TCP-подключение к настроенному DEPLOY_HOST не установилось за 5 секунд. OpenSSH также сообщил timeout на этапе подключения. Установка SSH-сессии не началась. Какая часть маршрута не ответила, пока неизвестно. Адрес, ключ и файл с параметрами остаются локальными.

`deploy/status.ps1`, `deploy/deploy.ps1` и вспомогательные скрипты используют общий набор параметров OpenSSH. SCP использует тот же набор с флагом `-P`. `ConnectTimeout=12` и `ConnectionAttempts=3` ограничивают подключение. `ServerAliveInterval=20` и `ServerAliveCountMax=3` обнаруживают потерю уже установленной сессии. Для status есть максимум два вызова OpenSSH с паузой 2 секунды при транспортном сбое. Скрипты с изменениями на сервере не используют этот повтор команды. [OpenSSH ssh_config](https://man.openbsd.org/ssh_config)

| Результат | Что установлено |
|---|---|
| `TCP_TIMEOUT` | TCP-подключение не завершилось в отведённое время |
| `CONNECTION_REFUSED` | Клиент получил явный отказ TCP |
| `AUTHENTICATION_FAILURE` | OpenSSH дошёл до аутентификации, вход отклонён |
| `HOST_KEY_FAILURE` | Ключ сервера не прошёл проверку |
| `SSH_TRANSPORT_FAILURE` | Сбой транспорта, например сброс или обрыв сессии |
| `REMOTE_COMMAND_FAILURE` | Команда или её удалённая обёртка завершилась с ошибкой |

## Что проверить в консоли хостинга

1. Открой out-of-band консоль VPS. В панели проверь, что экземпляр запущен, настроенный endpoint по-прежнему принадлежит этому экземпляру и выбран правильный порт.
2. Проверь unit `ssh.service` или `sshd.service`, а при socket activation также `ssh.socket`. Сверь фактический listener и эффективные параметры sshd.

   ```sh
   sudo systemctl status ssh.service sshd.service ssh.socket --no-pager
   sudo sshd -t
   sudo sshd -T | grep -E '^(port|listenaddress) '
   sudo ss -lntp
   sudo journalctl -u ssh.service -u sshd.service -u ssh.socket --since '1 hour ago' --no-pager
   ```

3. В панели хостинга проверь inbound security group, сетевой ACL, публичный маршрут и адрес исходящего подключения агента. На VPS посмотри активный firewall и правила именно для фактического порта. При включённом Fail2ban проверь список jail и статус SSH jail.

   ```sh
   sudo nft list ruleset
   sudo ufw status verbose
   sudo fail2ban-client status
   sudo fail2ban-client status sshd
   ```

4. Сверь время следующей попытки агента с коротким захватом на VPS. Подставь порт из локальной конфигурации. Отсутствие SYN указывает на участок до сетевого интерфейса VPS. Входящий SYN без ответа требует проверки listener и firewall на VPS. Исходящий SYN-ACK без ACK клиента требует проверки обратного маршрута. Вывод захвата содержит адреса, поэтому сохраняй его в приватной консоли.

   ```sh
   sudo timeout 20s tcpdump -ni any 'tcp port <SSH_PORT>'
   uptime
   free -h
   df -h
   df -i
   sudo journalctl -k --since '1 hour ago' --no-pager | grep -Ei 'oom|out of memory'
   ```

5. После восстановления запусти `deploy/status.ps1 -Since <ISO-8601>` с началом проверяемого периода. Сверь `systemd`, `STOP_LIVE`, allowlist в файле и окружении процесса, журнал отправок и неоднозначных результатов. Нули относятся к доступным журналам бота за этот период. Для вывода за весь период проверь также сохранность истории при ротации.

## Резервный OpenSSH через Tailscale

Сохрани действующий публичный доступ и проверь вход через out-of-band консоль. Когда альтернативный доступ подтверждён, подключи клиент и VPS к одному tailnet по официальной инструкции. Используй обычный OpenSSH с существующим ключом. Порт SSH остаётся портом действующего sshd. Ограничь tailnet grant до нужной машины агента, VPS и TCP-порта sshd. [Установка Tailscale](https://tailscale.com/kb/1017/install) · [Политика доступа Tailscale](https://tailscale.com/kb/1337/acl-syntax)

На агенте проверь `tailscale ping <private-host>`. Сверь fingerprint SSH host key с доверенной консолью VPS. Создай отдельный приватный файл конфигурации с тем же пользователем, портом и ключом и укажи tailnet-адрес или MagicDNS в `DEPLOY_HOST`. Проверь чтение через `deploy/status.ps1 -ServerConfigPath <private-config-path>`. Оставь основной файл подключения активным, пока резервный канал не пройдёт проверку. [Tailscale SSH и управление ключами](https://tailscale.com/docs/features/tailscale-ssh)
