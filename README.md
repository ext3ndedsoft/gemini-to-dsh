<p align="center">
  <img src="assets/banner.svg?v=4" alt="gemini→dsh — Gemini в DeepSeek Harness" width="100%">
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/LICENSE-MIT-31d0aa?style=for-the-badge&labelColor=0b0f17" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/NODE-%E2%89%A520-7c6cff?style=for-the-badge&labelColor=0b0f17&logo=nodedotjs&logoColor=white" alt="Node 20+">
  <img src="https://img.shields.io/badge/DEPENDENCIES-NONE-31d0aa?style=for-the-badge&labelColor=0b0f17" alt="No dependencies">
</p>

<p align="center"><b>Русский</b> · <a href="README.en.md">English</a></p>

**gemini-to-dsh** подключает Gemini к [DSH](https://github.com/deepseek-ai/deepseek-harness) и к любому клиенту, который говорит на OpenAI. Это небольшой локальный мост плюс панель в DSH: она показывает квоту по аккаунтам и переключает, как трафик выходит в сеть, если Гугл напрямую недоступен.

Без зависимостей, Node 20+.

## Что получаешь

- **Gemini в DSH** — стриминг, инструменты, изображения, размышления.
- **Несколько аккаунтов** — запрос уходит туда, где больше остатка, ещё до `429`.
- **Выход в сеть** — `DNS`, `Proxy`, `VPN` или `Direct`; битый канал сторож обходит сам.
- **Панель квоты** — пятичасовое и недельное окно каждого аккаунта и переключатель выхода.
- **Веб-поиск** и **lean-context** — по желанию, отдельными плагинами.

<p align="center">
  <img src="assets/panel-dns.png?v=4" alt="Панель: режим DNS" width="384">
  &nbsp;
  <img src="assets/panel-proxy.png?v=4" alt="Панель: режим Proxy" width="384">
</p>

## Установка

Нужен Node 20+ и DSH, запущенный хотя бы раз (чтобы появился профиль).

```bash
git clone https://github.com/ext3ndedsoft/gemini-to-dsh.git
cd gemini-to-dsh
node install.mjs
```

Без клона — скачать один файл, остальное он подтянет сам:

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/ext3ndedsoft/gemini-to-dsh/main/install.mjs -OutFile install.mjs; node install.mjs
```

```bash
# macOS / Linux
curl -fsSLO https://raw.githubusercontent.com/ext3ndedsoft/gemini-to-dsh/main/install.mjs && node install.mjs
```

Установщик сам находит профиль DSH, ставит мост в `~/.dsh/bridge` и панель в профиль, дописывает её в `cordis.patch.yml` (копия сохраняется как `.bak`), проверяет синтаксис и показывает, каких кредов не хватает. Обновление — тот же запуск ещё раз; свои `.env` и `ag-egress.json` он не трогает.

```bash
node install.mjs --with web-search,lean-context   # плюс остальные плагины (или --all)
node install.mjs --dry-run                        # только показать, что будет
node install.mjs --uninstall                      # убрать плагины и записи профиля
```

Потом перезапусти DSH: панель появится в правом нижнем углу.

## Аккаунты

Мост использует OAuth-токены, которые подписка Google AI Pro уже создала на машине (доступ Cloud Code, а не ключ бесплатного тарифа). Положи их туда, где мост их ждёт:

- `~/.gemini/oauth_creds.json` — первый аккаунт;
- `~/.gemini/dsh-bridge/accounts.json` — набор для ротации (по желанию).

Другие пути задаются через `AG_CREDS_FILE` и `AG_ACCOUNTS_FILE`. OAuth-клиент, которым токены обновляются, **в репозиторий не входит**: задай `AG_CLIENT_ID` и `AG_CLIENT_SECRET` или положи их в `~/.dsh/ag-oauth.json`.

## Подключение к DSH

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: agent-default-model
  config:
    provider: antigravity
    model: gemini-3.8-flash
    reasoningEffort: medium
```

Мост слушает `127.0.0.1:8787` и принимает bearer, совпадающий с `AG_BRIDGE_SECRET` (по умолчанию `local-bridge`).

## Если Гугл не открывается напрямую

Ничего делать не нужно: цепочка каналов `DNS` зашита в дефолты, а сторож раз в две минуты проверяет живой канал настоящим ответом и при двух провалах переключает на следующий. Свой канал, прокси или VPN выбираются в панели.

Если Гугл доступен напрямую, шим можно выключить: `AG_EGRESS=0` (на Windows `set "AG_EGRESS=0" && bridge\start.cmd`, иначе `AG_EGRESS=0 ./start.sh`).

| Режим | Что делает |
| --- | --- |
| `DNS` | идёт через smart-DNS релей, SNI и сертификат остаются гугловыми |
| `Proxy` | CONNECT через `host:port`, `http://`, `socks5://` или `socks5h://` |
| `VPN` | ничего не меняет, только проверяет, что туннель поднят |
| `Direct` | без релеев |

## Подробнее

- [Как это работает](docs/how-it-works.md) — стриминг, ротация аккаунтов, сторож, режимы выхода, картинки, ограничения
- [Настройка и тесты](docs/configuration.md) — все переменные окружения
- [Установка по шагам](docs/plugin-install.md), [транспорты](docs/transports.md), [квоты](docs/quotas.md), [картинки](docs/images.md), [безопасность](docs/security.md)
- Плагины: [quota-overlay](plugins/quota-overlay/README.md) · [web-search](plugins/web-search/README.md) · [lean-context](plugins/lean-context/README.md)

## Честно о главном

Cloud Code — неофициальный транспорт, Гугл может изменить его без предупреждения. Релеи — чужая инфраструктура: они видят SNI и объём, но не содержимое TLS. Скорость определяет модель, а не маршрут. Твой аккаунт, твой риск, твоя подписка. Остальное — в [ограничениях](docs/how-it-works.md#honest-limitations).

## Лицензия

MIT — см. [LICENSE](LICENSE). Проект не связан с Google; Gemini и Antigravity принадлежат Google, их код здесь не распространяется.