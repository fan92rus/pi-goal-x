# Upstream sync: форк fan92rus/pi-goal-x ← tmonk/pi-goal-x

Форк поддерживает фичи поверх апстрима и автоматически подтягивает его релизы,
не теряя их.

## Архитектура (с 2026-10-13): GitHub — основной, локальная задача — резерв

**`.github/workflows/upstream-sync.yml`** — основной пайплайн:
- cron ежечасно + workflow_dispatch + push в main;
- job `sync`: merge новейшего невлитого релизного тега upstream в main;
  гейт = `npm run check` + `npm run test:all` (ubuntu: штатный раннер работает,
  windows-базлайн не нужен); push main;
- конфликт → merge abort, красный ран, авто-issue `upstream conflict: vX.Y.Z`;
- job `publish`: `@fan92rus/pi-goal-x <вер>-fan.<N>` под dist-tag `fan`
  (секрет `NPM_TOKEN`, Automation-токен — обходит 2FA-OTP);
  дедуп: HEAD уже опубликован (gitHead-совпадение) → skip.

**Локальная задача `pi-goal-x Upstream Sync`** (`scripts/upstream-sync.mjs`):
- резервный синкер и РАЗРЕШИТЕЛЬ КОНФЛИКТОВ ( enqueue в SelfHeal, см. ниже);
- гвард от гонок: если upstream-sync-ран в GitHub ещё идёт — локальный запуск
  выходит (fail-open при недоступном gh);
- npm зовётся через `node npm-cli.js` (spawnSync не исполняет .cmd-шиммы,
  CVE-2024-27980; локальная публикация требует Automation-токен в ~/.npmrc).

Готово к расхождениям: GitHub авто-отключает cron-workflow на форках после
60 дней неактивности репо — тогда локальная задача остаётся единственным
синкером (перевключить в Actions-табе).

## Ремоуты и ветки

| Remote | URL | Роль |
|---|---|---|
| `upstream` | https://github.com/tmonk/pi-goal-x | оригинал; только fetch |
| `origin` | https://github.com/fan92rus/pi-goal-x | наш форк; сюда пишем |

- **`main` = форк-слой**: коммиты апстрима + наши фичи (например,
  `autonomousTasks`, спеки в `specs/`). Тегируем апстрим-релизы merge'ами.
- Синк трекает **релизные теги** upstream (`v*`), не main.

## Автосинк (задача `pi-goal-x Upstream Sync`)

- Запуск: ежечасно + `StartWhenAvailable` (догоняет после простоя машины).
  Действие: `node scripts/upstream-sync.mjs --publish` (cwd не важен).
- Ручной запуск: `node scripts/upstream-sync.mjs [--publish]`.
- Шаги: fetch тегов upstream → merge последнего релизного тега в `main`
  (`--no-commit`) → гейты → commit → push в `origin`.
- **Гейты**: `npm run check`; юнит + интеграция через
  `node --experimental-strip-types --import ./scripts/test-adapter-hooks.mjs
  --test …` (штатный `npm test` на этой машине сломан — раннер передаёт
  `D:\`-пути в `--test`).
  Множество упавших **имён** тестов должно быть подмножеством baseline
  `scripts/upstream-sync-test-baseline.json` (предсуществующие env-фейлы этой
  машины). Новый упавший тест обязан воспроизводиться на pre-merge HEAD —
  тогда это env-drift, он добавляется в baseline отдельным коммитом; иначе это
  регрессия merge → `git merge --abort`, exit 4.
- **Конфликт merge** → `POST {SELFHEAL_URL}/env`-независимый
  `/enqueue-conflict` (`http://localhost:5080`, см. `SELFHEAL_URL`) →
  SelfHeal-оркестратор запускает агента-резолвера → exit 3.
- **Состояние**: `.git/upstream-sync-state.json` (локально, не коммитится).
- **Логи**: `D:/tmp/pi-goalx-sync-YYYYMMDD.log` (хранятся 14).

## Конфликт-пайплайн (SelfHeal)

Оркестратор (репо `D:\Documents\Repositories\selfheal`, задача
`SelfHeal Orchestrator` + hourly автодеплой) по `repoTag
fan92rus/pi-goal-x` запускает `pi -p "<контракт>"` в агентском checkout
`D:\Documents\Repositories\goal-x\pi-goal-x-agent` (ветка `main`).

- **Гейт неактуальности (в оркестраторе, до запуска агента)**: тег уже
  содержится в ветке → задача мгновенно `Skipped: stale` — (1) предок
  (`merge-base --is-ancestor`); (2) если нет (апстрим переписывал историю) —
  новейший влитый релизный тег ветки semver-не-ниже запрошенного. Сбой
  проверки → задача идёт агенту (fail-open).

- **Контракт агента**:
  `selfheal/prompts/resolve-conflict-pi-goal-x.md` — правила слияния:
  * сохранять форк-фичи: `extensions/goal-*`, наши тесты, `specs/`;
  * брать upstream: `package-lock.json` (+ `npm install` после), всё, чего мы
    не касались; `README`/`CHANGELOG` — объединение;
  * в `package.json` имя остаётся апстримовским (переименование — только на
    публикации, см. ниже);
  * гейт агента: fail-множество тестов после merge ⊆ множеству до merge
    (замер базлайна самим агентом до merge).
- **Модель резолвера**: `orchestrator/config.yaml` → проект `pi-goal-x` →
  `model:` (сейчас `zai-coding-cn/glm-5.3-flash`). Меняется в одном месте;
  контракт от модели не зависит. Конфиг перечитывается при рестарте
  оркестратора.
- Диагностика: `GET http://localhost:5080/issues`, `/queue`, `/locks`,
  `/health`; ручной requeue — `POST /requeue/<issue>`; enqueue вручную —
  `POST /enqueue-conflict {"repoTag":"fan92rus/pi-goal-x","tag":"vX.Y.Z"}`.

## npm-публикация (`--publish`)

- Форк публикуется как **`@fan92rus/pi-goal-x`**, версия
  `<апстрим-версия>-fan.<N>` (N подбирается перебором до свободной), dist-tag
  **`fan`**: `npm i @fan92rus/pi-goal-x@fan`.
- Репозиторный `package.json` **остаётся апстримовским** (`pi-goal-x`):
  переименование/бамп делаются в рабочем дереве только на время публикации и
  откатываются — merge'ы апстрима по package.json остаются чистыми.
- Требуется авторизация npm: `npm login` (или токен в `~/.npmrc`). Без неё
  шаг публикции пропускается с записью в лог, синк не считается ошибкой.
- Повторная публикация того же HEAD пропускается (состояние в
  `.git/upstream-sync-state.json`).

## Exit-коды `upstream-sync.mjs`

| Код | Значение |
|-----|----------|
| 0 | ок (в т.ч. «уже актуален», публикация пропущена) |
| 2 | среда/использование (не та ветка, грязное дерево, нет тегов, enqueue не дошёл) |
| 3 | конфликт merge — задача передана в SelfHeal |
| 4 | регрессия на гейте тестов — merge отменён |
| 5 | `npm publish` упал (репо не тронуто) |

## Инфраструктурные заметки

- Оркестратор читает `config.yaml` при старте; правки конфига требуют
  рестарта (graceful stop → задача `SelfHeal Orchestrator Deploy`/ручной
  старт поднимает ≤1 мин, если нет активных агентов).
- В YAML-строках в двойных кавычках нельзя писать `\` (обратный слеш) —
  YAML считает его escape-началом и парсер падает при старте (грабли
  2026-10-13, см. `selfheal/docs/KNOWLEDGE.md`).
- Если оркестратор был остановлен на время правки — поднимать так же, как
  поднимает deploy-задача: `Start-Process` exe из
  `orchestrator/src/SelfHeal.Orchestrator/bin/Release/net10.0-windows/` с
  WorkingDirectory `orchestrator/`.
