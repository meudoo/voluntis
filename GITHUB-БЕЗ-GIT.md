# Как залить проект на GitHub без команд git

Если в PowerShell пишет «git не распознано» — Git не установлен.

---

## Способ 1. Установить Git (рекомендуется)

### Вариант А — через winget (PowerShell от администратора)

```powershell
winget install Git.Git
```

Закройте PowerShell, откройте **новое** окно и проверьте:

```powershell
git --version
```

### Вариант Б — установщик с сайта

1. [https://git-scm.com/download/win](https://git-scm.com/download/win)
2. Скачайте **64-bit Git for Windows Setup**
3. Установите: везде **Next**, в конце **Finish**
4. **Закройте и снова откройте** PowerShell
5. `git --version` — должна появиться версия

### После установки — загрузка на GitHub

```powershell
cd C:\Users\user\Desktop\дипломм
git init
git add .
git commit -m "VOLUNTIS"
git branch -M main
git remote add origin https://github.com/ВАШ_ЛОГИН/voluntis.git
git push -u origin main
```

---

## Способ 2. GitHub Desktop (без команд в PowerShell)

1. Скачайте: [https://desktop.github.com](https://desktop.github.com)
2. Установите, войдите в аккаунт GitHub
3. **File** → **Add local repository** → папка `C:\Users\user\Desktop\дипломм`
   - Если пишет «не репозиторий» → **create a repository** здесь же
4. Слева галочки у файлов → внизу **Summary** → `VOLUNTIS` → **Commit to main**
5. **Publish repository** → имя `voluntis` → **Public** → **Publish**

Готово — код на GitHub, дальше Render → Connect репозиторий.

---

## Способ 3. Через сайт GitHub (без Git, для небольшого проекта)

**Не загружайте папку `backend\node_modules`** — она огромная.

1. GitHub → **+** → **New repository** → `voluntis` → **Create**
2. **uploading an existing file** (или **Add file** → **Upload files**)
3. Перетащите из `дипломм`:
   - папки `backend` (без `node_modules`!), `public`, `scripts`
   - файлы `render.yaml`, `package.json`, `netlify.toml` и т.д.
4. **Commit changes**

На Render укажите Build: `npm install` — зависимости установятся на сервере.

---

## Что дальше

Инструкция Render: **RENDER-ПОШАГОВО.md**
