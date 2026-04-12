# Проблема: MCP серверы дублируются для каждой Claude сессии

**Дата обнаружения:** 2026-04-12  
**Статус:** Открыта  

---

## Описание проблемы

Каждая helyx-channel сессия (`claude server:helyx-channel`) при старте форкает **свои собственные subprocess-процессы** для каждого MCP сервера, прописанного в конфигурации. Это архитектурное поведение Claude Code: при stdio-транспорте — 1 сессия = N дочерних процессов.

При 8 активных сессиях это выглядит так:

```
claude (сессия 1) → playwright-mcp  (свой subprocess)
                  → context7-mcp   (свой subprocess)
                  → docker-mcp     (свой subprocess)

claude (сессия 2) → playwright-mcp  (отдельный!)
                  → context7-mcp   (отдельный!)
                  → docker-mcp     (отдельный!)
... × 8
```

### Источник конфигурации MCP

Серверы берутся из двух источников:

| Источник | Путь |
|---------|------|
| Глобальный settings | `~/.claude/settings.json` → `mcpServers` |
| External plugins | `~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/*/` |

Плагины `playwright` и `context7` добавляют `.mcp.json` с **stdio-транспортом**, что и вызывает дублирование.

---

## Текущее потребление памяти (снято 2026-04-12, 8 сессий)

### MCP subprocess-процессы

| Сервер | Кол-во процессов | Суммарно RSS |
|--------|-----------------|-------------|
| `playwright-mcp` (node) | 16 | **822 MB** |
| `context7-mcp` (node) | 24 | **1 405 MB** |
| `docker-mcp-server` (node) | 25 | **1 340 MB** |
| `npm exec` wrappers | 25 | **2 150 MB** |
| **Итого MCP overhead** | **~90 процессов** | **~5 700 MB** |

> Примечание: кол-во > 8 из-за того что некоторые сессии запускают несколько реплик и npm exec создаёт промежуточные процессы.

### Вся картина памяти сервера

| Категория | RSS |
|-----------|-----|
| Claude сессии (11 шт) | 4 405 MB |
| node/npm/npx (MCP серверы) | 4 665 MB |
| bun (боты) | 1 927 MB |
| Docker контейнеры | 1 860 MB |
| whisper-asr | 720 MB |
| ollama | 395 MB |
| dockerd + containerd | 529 MB |
| **Итого (RSS)** | **~14 500 MB** |

**RAM сервера:** 28 GB, используется ~8.7 GB (Linux отдаёт остальное под кэш).

---

## Варианты решения

### Вариант 1 — HTTP + `--isolated` для playwright (выбранный)

Запустить playwright **один раз как системный сервис** с флагом `--isolated`. Каждая сессия получает свой изолированный браузерный контекст, но в рамках одного процесса.

**Ключевые свойства:**
- `--isolated` — каждое подключение получает отдельный браузерный контекст (нет конфликтов между сессиями)
- Браузер (Chromium) запускается **лениво** — только при первом вызове `browser_navigate` или `browser_click`
- Node-процесс один — регистрирует инструменты для всех сессий сразу

```bash
npx @playwright/mcp@latest --port 3011 --isolated
```

В `~/.claude/settings.json`:
```json
"playwright": {
  "type": "http",
  "url": "http://localhost:3011/playwright"
}
```

---

### Вариант 2 — HTTP-транспорт для context7

context7 полностью stateless (только проксирует запросы к документации), шарится без каких-либо ограничений:

```bash
npx @upstash/context7-mcp --transport http --port 3010
```

В `~/.claude/settings.json`:
```json
"context7": {
  "type": "http",
  "url": "http://localhost:3010/mcp"
}
```

---

### Вариант 3 — HTTP или ограничение docker-mcp по проектам

`docker-mcp-server` — проверить поддержку HTTP. Если нет — добавить только в `.mcp.json` проектов, где реально нужен Docker (а не глобально для всех сессий).

---

## Что НЕ делаем и почему

| Идея | Почему отклонена |
|------|-----------------|
| Убрать playwright из helyx-channel | Браузер нужен — helyx-сессии используют `browser_click` для автоматизации |
| Один playwright без `--isolated` | Конкурентные запросы из разных сессий будут конфликтовать |
| Lazy-загрузка на уровне Claude Code | Не поддерживается нативно — MCP серверы стартуют всегда при открытии сессии |

---

## Ожидаемый эффект после фикса

### Playwright → HTTP + `--isolated` (Вариант 1)

| | До | После |
|--|----|----|
| playwright node-процессы | 16 × ~51 MB = 822 MB | **1 × ~51 MB = 51 MB** |
| npm exec wrappers для playwright | ~8 × ~85 MB = ~680 MB | **0 MB** |
| **Экономия** | | **~1 451 MB (~1.4 GB)** |

### context7 → HTTP (Вариант 2)

| | До | После |
|--|----|----|
| context7 node-процессы | 24 × ~59 MB = 1 405 MB | **1 × ~59 MB = 59 MB** |
| npm exec wrappers для context7 | ~8 × ~85 MB = ~680 MB | **0 MB** |
| **Экономия** | | **~2 026 MB (~2.0 GB)** |

### docker-mcp → HTTP или по проектам (Вариант 3)

| | До | После |
|--|----|----|
| docker-mcp node-процессы | 25 × ~54 MB = 1 340 MB | **1–3 × ~54 MB ≈ 160 MB** |
| npm exec wrappers | ~8 × ~98 MB = ~790 MB | **0 MB** |
| **Экономия** | | **~1 970 MB (~2.0 GB)** |

### Итоговый расчёт

| Сценарий | Экономия RAM | MCP процессов |
|---------|-------------|---------------|
| Вариант 1 (playwright) | ~1.4 GB | 90 → ~74 |
| Варианты 1 + 2 (+ context7) | ~3.4 GB | 90 → ~50 |
| Варианты 1 + 2 + 3 (все) | **~5.4 GB** | 90 → **~10** |

**До фикса:** ~14.5 GB RSS  
**После всех вариантов:** ~9 GB RSS  
**Headroom для новых сессий:** +5–6 GB

---

## Связанные файлы

- `~/bots/helyx/scripts/run-cli.sh` — скрипт запуска сессий
- `~/.claude/settings.json` — глобальный конфиг Claude (MCP серверы)
- `~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/` — плагины с `.mcp.json`
- `~/bots/helyx/.claude/settings.local.json` — локальный конфиг проекта helyx
