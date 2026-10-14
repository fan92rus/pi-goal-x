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
- job `publish`: `@fan92rus/pi-goal-x <вер>-fan.<N>` под dist-tag `latest` (ставится просто `npm i -g @fan92rus/pi-goal-x`)
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
  Действие задачи: `wscript.exe //B //Nologo scripts\upstream-sync-hidden.vbs`
  (cwd не важен) — скрытый лаунчер: VBS держит интерактивную сессию (нужны
  git-креды/gh), а запускает `upstream-sync-hidden.cmd` с window style 0,
  чтобы node.exe не всплывал консольным окном каждый час. Шим сохраняет
  вывод последнего запуска в `%TEMP%\pi-goalx-sync-console.log` и
  прокидывает exit-код синка в Last Task Result. Публикация (--publish)
  удалена из задачи: npm trusted publishing работает только из GitHub
  Actions; локальный флаг остался в скрипте для ручного запуска.
- Ручной запуск: `node scripts/upstream-sync.mjs [--publish]` или
  `cscript //nologo scripts/upstream-sync-hidden.vbs`.
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

## npm-публикация

- Форк публикуется как **`@fan92rus/pi-goal-x`**, версия
  `<апстрим-версия>-fan.<N>` (N подбирается перебором до свободной), dist-tag
  **`latest`**: `npm i -g @fan92rus/pi-goal-x`.
- **Механизм — npm trusted publishing (OIDC)**, токены не используются:
  publish-джоба имеет `id-token: write`, Trusted Publisher на пакете
  (fan92rus / pi-goal-x / `upstream-sync.yml`, разрешён `npm publish`);
  provenance-аттестация генерируется автоматически.
- На время публикации в package.json переписываются `name`, `version` и
  `repository.url` (npm валидирует repository.url против публикующего
  GitHub-репо — должен быть форк); сам репо остаётся апстримовским —
  merge'ы по package.json чистые.
- Дедуп: HEAD уже опубликован (npm `gitHead` совпадает) → skip — поэтому
  push-триггер и sync-триггер не задваивают публикацию.
- Bootstrap 0.32.3-fan.0 сделан локально с 2FA-OTP (2026-10-13): пакет должен
  существовать до настройки Trusted Publisher.
- Секрет `NPM_TOKEN` больше не используется (гранулярные токены не публикуют
  — EOTP; с янв 2027 2FA-bypass токены теряют publish вовсе).

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
