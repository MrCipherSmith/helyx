# PRD: Перевод MCP серверов на общий HTTP-транспорт

## 1. Обзор

Перевести MCP серверы `playwright`, `context7` и `docker-mcp` с индивидуального stdio-транспорта (отдельный процесс на каждую сессию) на общий HTTP-транспорт (один процесс на всех). Ожидаемая экономия — до **5.4 GB RAM** и сокращение числа MCP-процессов с ~90 до ~10.

---

## 2. Контекст

- **Продукт:** helyx — мультисессионный Telegram-бот на базе Claude Code
- **Модуль:** инфраструктура Claude-сессий, конфигурация MCP
- **Роль пользователя:** администратор сервера / разработчик
- **Стек:** Ubuntu 24.04, Claude Code CLI, bun, systemd, Docker Compose
- **Сервер:** geekom, 28 GB RAM, 8 активных helyx-channel сессий

---

## 3. Описание проблемы

Claude Code при stdio-транспорте форкает отдельные subprocess-процессы MCP-сервера для каждой открытой сессии. При 8 активных helyx-channel сессиях это приводит к запуску ~90 дублирующих node-процессов:

- 16 процессов `playwright-mcp` (822 MB)
- 24 процесса `context7-mcp` (1 405 MB)
- 25 процессов `docker-mcp-server` (1 340 MB)
- 25 процессов `npm exec` wrappers (2 150 MB)

Итого: **~5.7 GB** расходуется на идентичные копии stateless-сервисов.

---

## 4. Цели

- Сократить число MCP-процессов с ~90 до ~10
- Снизить потребление RAM на ~5.4 GB
- Сохранить полную изоляцию браузерных контекстов между сессиями
- Добавить мониторинг потребления памяти MCP-процессами

---

## 5. Не входит в scope

- Оптимизация самих Claude-процессов (4.4 GB) — отдельная задача
- Перевод helyx MCP (`http://localhost:3847/mcp`) — уже работает на HTTP
- Оптимизация bun-процессов и Docker-контейнеров
- Изменение логики helyx-channel сессий или `run-cli.sh`

---

## 6. Функциональные требования

**FR-1:** Запустить `playwright-mcp` как HTTP-сервис на порту 3011 с флагом `--isolated` (изолированные браузерные контексты).

**FR-2:** Запустить `context7-mcp` как HTTP-сервис на порту 3010 (`--transport http`).

**FR-3:** Исследовать и запустить `docker-mcp-server` как HTTP-сервис на порту 3012 (если поддерживается).

**FR-4:** Создать systemd unit-файлы для каждого MCP HTTP-сервиса с автозапуском от пользователя `altsay`.

**FR-5:** Обновить `~/.claude/settings.json` — заменить stdio-конфиги на HTTP URL для всех трёх серверов.

**FR-6:** Исследовать и устранить дублирование: отключить `external_plugins` для playwright и context7, если они конфликтуют с записями в `settings.json`.

**FR-7:** Перезапустить все 8 helyx-channel сессий после применения конфига.

**FR-8:** Замерить потребление RAM и количество процессов до и после.

---

## 7. Нефункциональные требования

**NFR-1:** Время старта HTTP-сервисов после перезагрузки системы — не более 30 секунд.

**NFR-2:** Браузерные контексты разных сессий не должны видеть состояние друг друга (`--isolated`).

**NFR-3:** Сервисы должны автоматически перезапускаться при сбое (`Restart=on-failure` в systemd).

**NFR-4:** Логи MCP-сервисов должны писаться в journald и быть доступны через `journalctl`.

**NFR-5:** Полное время деплоя (включая перезапуск сессий) — не более 10 минут.

---

## 8. Ограничения

- Claude Code не поддерживает lazy-загрузку MCP — HTTP-сервисы должны быть запущены **до** старта сессий
- Приоритет конфигов MCP в Claude Code требует исследования (external_plugins vs settings.json)
- Downtime: все 8 сессий перезапускаются одновременно (rolling restart не требуется)
- Порты 3010, 3011, 3012 должны быть свободны и не использоваться другими сервисами

---

## 9. Граничные случаи

- `docker-mcp-server` не поддерживает HTTP → оставить на stdio, задокументировать отдельно
- external_plugins имеют приоритет над settings.json → нужно явно удалить или переопределить
- После перезапуска сессий старые MCP stdio-процессы могут оставаться как зомби → требуется явный `pkill`
- HTTP-сервис упал до старта сессии → Claude Code не найдёт инструменты, сессия деградирует без браузера

---

## 10. Критерии приёмки (Gherkin)

```gherkin
Feature: MCP серверы на общем HTTP-транспорте

  Scenario: playwright запущен как общий HTTP-сервис
    Given systemd сервис mcp-playwright запущен на порту 3011
    When открываются 8 helyx-channel сессий
    Then существует ровно 1 процесс playwright-mcp
    And каждая сессия может использовать browser_navigate независимо
    And браузерный контекст сессии 1 не виден сессии 2

  Scenario: context7 запущен как общий HTTP-сервис
    Given systemd сервис mcp-context7 запущен на порту 3010
    When открываются 8 helyx-channel сессий
    Then существует ровно 1 процесс context7-mcp
    And все сессии успешно получают документацию через context7

  Scenario: память после фикса
    Given все MCP HTTP-сервисы запущены
    And 8 helyx-channel сессий активны
    When выполняется замер RSS
    Then суммарный RSS MCP-процессов менее 500 MB
    And общее потребление RAM сервером менее 10 GB

  Scenario: отказоустойчивость
    Given mcp-playwright сервис запущен
    When процесс playwright-mcp завершается аварийно
    Then systemd перезапускает его в течение 5 секунд
    And новые сессии снова получают доступ к браузеру

  Scenario: изоляция браузерных контекстов
    Given playwright запущен с флагом --isolated
    And сессия A открыла страницу example.com
    When сессия B вызывает browser_snapshot
    Then сессия B видит пустой браузер, не страницу сессии A
```

---

## 11. Верификация

### Как проверять

```bash
# Количество MCP-процессов (должно быть ~3-5, не ~90)
ps aux | grep -E "playwright-mcp|context7-mcp|docker-mcp" | grep -v grep | wc -l

# RSS памяти до и после
ps aux | grep -E "playwright-mcp|context7-mcp|docker-mcp|npm exec" | grep -v grep \
  | awk '{sum+=$6} END {printf "MCP RSS: %.0f MB\n", sum/1024}'

# Статус systemd сервисов
systemctl --user status mcp-playwright mcp-context7 mcp-docker

# Доступность HTTP эндпоинтов
curl -s http://localhost:3010/mcp | head -5
curl -s http://localhost:3011/playwright | head -5

# Проверка изоляции — через два разных Claude сессии
# Сессия 1: browser_navigate("https://example.com")
# Сессия 2: browser_snapshot() — должна быть пустой страницей
```

### Метрики успеха

| Метрика | До | После |
|--------|-----|-------|
| MCP процессов | ~90 | ~10 |
| MCP RSS | ~5.7 GB | < 500 MB |
| Общий RSS сервера | ~14.5 GB | < 10 GB |

### Observability

- `journalctl --user -u mcp-playwright -f` — логи playwright
- `journalctl --user -u mcp-context7 -f` — логи context7
- `systemctl --user status mcp-*` — здоровье сервисов
