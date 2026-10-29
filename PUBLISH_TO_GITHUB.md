# Публикация NOVA Island

Публичный репозиторий уже создан: [smells1k/nova-island](https://github.com/smells1k/nova-island), основная ветка — `main`. Не создавай репозиторий заново.

Исходники хранятся в Git; установщик `.exe` (около 116 МБ) нужно прикладывать к GitHub Release, а не добавлять в обычную историю Git. Для новой версии:

1. Обнови версию в `package.json` и `package-lock.json`, проверь README и собери установщик `npm run dist:win`.
2. Создай commit и отправь `main` в существующий репозиторий.
3. Создай релиз с соответствующим тегом `vX.Y.Z` и приложи `release/NOVA-Island-Setup-X.Y.Z-x64.exe`.

Аутентифицируйся через браузерный вход GitHub или Git Credential Manager. Не вставляй PAT в чат, исходники или URL; отзывай скомпрометированные токены.
