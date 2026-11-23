<p align="center">
  <img src="assets/banner.svg?v=6" alt="gemini→dsh — Gemini и Google Search в DeepSeek Harness" width="100%">
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/LICENSE-MIT-31d0aa?style=for-the-badge&labelColor=0b0f17" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/NODE-%E2%89%A520-7c6cff?style=for-the-badge&labelColor=0b0f17&logo=nodedotjs&logoColor=white" alt="Node 20+">
  <img src="https://img.shields.io/badge/DEPENDENCIES-NONE-31d0aa?style=for-the-badge&labelColor=0b0f17" alt="No dependencies">
</p>

<p align="center"><b>Русский</b> · <a href="README.en.md">English</a></p>

**gemini-to-dsh** подключает модели Gemini (3.x / 4) и живой поиск Google к [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) и любому OpenAI-совместимому клиенту. Это лёгкий локальный мост на чистом Node.js (без сторонних пакетов) и компактная панель прямо в интерфейсе DSH.

## Что умеет

- **Полноценный Gemini в DSH** — плавный стриминг, вызов инструментов, генерация картинок, размышления (`reasoning_effort`), авто-докачка оборванных ответов и KV-cache keep-alive для длинных сессий.
- **Умная ротация аккаунтов** — мост следит за пятичасовым и недельным лимитами каждого аккаунта и заранее переводит запросы туда, где больше запаса, не дожидаясь ошибки `429`.
- **Живой веб-поиск (Google Search grounding)** — отдельный эндпоинт `/v1/search` и плагин `web-search` отдают готовую сводку и реальные ссылки; модель для поиска можно переключать прямо в панели.
- **Точечный выход в сеть** — режимы `DNS`, `Proxy`, `VPN` и `Direct`. Через выбранный канал идут только запросы к `*.googleapis.com`, весь остальной трафик на компьютере остаётся как есть.
- **Панель в углу экрана** — показывает остаток квоты по окнам и моделям, задержку ответа, активный маршрут и выбор модели для `web-search`.

<p align="center">
  <img src="assets/panel-dns.png?v=6" alt="Панель квот и маршрута: режим DNS" width="360">
  &nbsp;&nbsp;
  <img src="assets/panel-proxy.png?v=6" alt="Панель квот и маршрута: режим Proxy" width="360">
</p>

## Быстрая установка

Понадобится **Node.js 20+** и хотя бы один раз запущенный DSH (чтобы создалась папка профиля).

```bash
git clone https://github.com/ext3ndedsoft/gemini-to-dsh.git
cd gemini-to-dsh
node install.mjs
```

Или одной командой без ручного клонирования:

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/ext3ndedsoft/gemini-to-dsh/main/install.mjs -OutFile install.mjs; node install.mjs
```

```bash
# macOS / Linux
curl -fsSLO https://raw.githubusercontent.com/ext3ndedsoft/gemini-to-dsh/main/install.mjs && node install.mjs
```

Установщик сам найдёт профиль DSH, скопирует мост в `~/.dsh/bridge`, поставит панель в профиль и аккуратно добавит её в `cordis.patch.yml` (сохранив резервную копию `.bak`). Повторный запуск обновляет код, не трогая ваши `.env` и `ag-egress.json`.

```bash
node install.mjs --with web-search,lean-context   # поставить вместе с поиском и сжатием контекста (или --all)
node install.mjs --dry-run                        # посмотреть, что изменится, ничего не записывая
node install.mjs --uninstall                      # удалить плагины и записи из профиля
```

После установки перезапустите DSH — в правом нижнем углу появится пилюля с квотой и маршрутом.

## Аккаунты и OAuth

Мост работает через OAuth-сессию вашей подписки Google AI Pro (доступ Cloud Code, а не бесплатный API-ключ):

- `~/.gemini/oauth_creds.json` — основной аккаунт (подхватывается автоматически, если вы уже входили в Antigravity или Gemini CLI);
- `~/.gemini/dsh-bridge/accounts.json` — пул дополнительных аккаунтов для ротации (можно добавлять прямо кнопкой `+ аккаунт` в панели).

Пути можно переопределить через `AG_CREDS_FILE` и `AG_ACCOUNTS_FILE`. Данные OAuth-клиента для обновления токенов **в репозиторий не включены** — задайте `AG_CLIENT_ID` и `AG_CLIENT_SECRET` в окружении или положите их в `~/.dsh/ag-oauth.json`.

## Подключение в DSH

Добавьте провайдера в `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: agent-default-model
  config:
    provider: antigravity
    model: gemini-3.8-flash
    reasoningEffort: medium
```

Чтобы встроенный инструмент `web_search` в DSH ходил через Google Search grounding моста, добавьте в `~/.dsh/search.json`:

```json
{
  "order": ["antigravity"],
  "providers": {
    "antigravity": { "baseUrl": "http://127.0.0.1:8787", "key": "local-bridge" }
  }
}
```

Мост слушает только локальный адрес `127.0.0.1:8787` и проверяет bearer-токен из `AG_BRIDGE_SECRET` (по умолчанию `local-bridge`).

## Если Google не открывается напрямую

Ничего настраивать вручную не нужно: по умолчанию включена цепочка `DNS`-релеев, а встроенный сторож каждые две минуты проверяет канал реальным запросом и при сбое сам переключается на рабочий. Переключить режим или указать свой прокси можно в один клик в панели.

Если Google доступен напрямую, локальный шим можно отключить переменной `AG_EGRESS=0` (Windows: `set "AG_EGRESS=0" && bridge\start.cmd`, macOS/Linux: `AG_EGRESS=0 ./start.sh`).

| Режим | Как работает |
| --- | --- |
| `DNS` | Направляет только `*.googleapis.com` через smart-DNS релей; TLS-сертификат проверяется напрямую с Google |
| `Proxy` | Подключается через ваш `http://`, `socks5://` или `socks5h://` прокси |
| `VPN` | Не вмешивается в маршрут, только отслеживает, поднят ли системный VPN-туннель |
| `Direct` | Прямое подключение без релеев и прокси |

## Документация

- [Как всё устроено](docs/how-it-works.md) — стриминг, ротация аккаунтов, сторож каналов, режимы выхода, картинки и ограничения
- [Переменные окружения и тесты](docs/configuration.md) — полный список настроек и запуск тестов
- [Ручная установка](docs/plugin-install.md) · [Транспорты](docs/transports.md) · [Квоты](docs/quotas.md) · [Картинки](docs/images.md) · [Безопасность](docs/security.md)
- Плагины: [quota-overlay](plugins/quota-overlay/README.md) · [web-search](plugins/web-search/README.md) · [lean-context](plugins/lean-context/README.md)

## Важно знать

Cloud Code — неофициальный транспорт, и Google может изменить его в любой момент. Публичные smart-DNS релеи видят только домен (SNI) и объём трафика, но не содержимое TLS-соединения. Скорость генерации зависит от самой модели, а не от маршрута. Вы используете мост на свой страх и риск со своей подпиской — подробнее в [ограничениях](docs/how-it-works.md#honest-limitations).

## Лицензия

MIT — см. [LICENSE](LICENSE). Проект не аффилирован с Google; Gemini и Antigravity являются товарными знаками Google, их код здесь не распространяется.
