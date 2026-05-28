/**
 * Собирает папку deploy-site/ — ТОЛЬКО её загружайте на Netlify (не всю «дипломм»).
 * BACKEND_URL = URL API на Render (в Netlify → Environment variables).
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const srcPublic = path.join(root, 'public');
const outDirs = [
  path.join(root, 'deploy-site'),
  path.join(root, 'netlify-publish'),
];
const backendUrl = (process.env.BACKEND_URL || '').trim().replace(/\/$/, '');

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    const to = path.join(dest, name);
    if (fs.statSync(from).isDirectory()) {
      copyDir(from, to);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

function writeDeployFiles(outDir) {
  if (backendUrl) {
    const indexPath = path.join(outDir, 'index.html');
    let html = fs.readFileSync(indexPath, 'utf8');
    html = html.replace(
      /<meta\s+name="voluntis-api"\s+content="[^"]*"\s*\/?>/i,
      `<meta name="voluntis-api" content="${backendUrl}" />`
    );
    fs.writeFileSync(indexPath, html, 'utf8');
  }

  // Пустой URL = пользователь вводит свой Render URL на странице «Вход»
  const configJs = `// Сайт на Netlify
(function () {
  var host = location.hostname;
  if (/^(localhost|127\\.0\\.0\\.1)$/i.test(host)) {
    window.VOLUNTIS_API_BASE = '';
    window.VOLUNTIS_BACKEND_URL = '';
    return;
  }
  try {
    var saved = localStorage.getItem('voluntis_api_override');
    if (saved) {
      saved = String(saved).trim().replace(/\\/$/, '');
      if (saved) {
        window.VOLUNTIS_API_BASE = saved;
        window.VOLUNTIS_BACKEND_URL = saved;
        return;
      }
    }
  } catch (e) {}
  var fromBuild = ${JSON.stringify(backendUrl || '')};
  if (fromBuild) {
    window.VOLUNTIS_API_BASE = fromBuild;
    window.VOLUNTIS_BACKEND_URL = fromBuild;
    return;
  }
  var meta = document.querySelector('meta[name="voluntis-api"]');
  var url = (meta && meta.getAttribute('content')) || '';
  url = String(url).trim().replace(/\\/$/, '');
  if (url) {
    window.VOLUNTIS_API_BASE = url;
    window.VOLUNTIS_BACKEND_URL = url;
  }
})();
`;

  fs.writeFileSync(path.join(outDir, 'config.js'), configJs, 'utf8');
  fs.writeFileSync(path.join(outDir, '_redirects'), '/*    /index.html   200\n', 'utf8');

  const readme =
    'Загрузите на Netlify ТОЛЬКО содержимое этой папки (deploy-site).\r\n' +
    'Не загружайте всю папку «дипломм» и не папку backend.\r\n\r\n' +
    (backendUrl
      ? 'API: ' + backendUrl + '\r\n'
      : 'Задайте BACKEND_URL при сборке или URL на странице «Вход».\r\n');
  fs.writeFileSync(path.join(outDir, 'ПРОЧТИ-МЕНЯ.txt'), readme, 'utf8');
}

if (!fs.existsSync(srcPublic)) {
  console.error('Не найдена папка public/');
  process.exit(1);
}

for (const outDir of outDirs) {
  if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
  copyDir(srcPublic, outDir);
  writeDeployFiles(outDir);
}

if (backendUrl) {
  console.log('API (Render):', backendUrl);
} else {
  console.warn('');
  console.warn('BACKEND_URL не задан. После деплоя укажите URL Render на странице «Вход».');
  console.warn('Или: $env:BACKEND_URL="https://ваш-сервис.onrender.com"; npm run build:netlify');
  console.warn('');
}

console.log('');
console.log('Готово. Загрузите на Netlify папку:');
console.log('  ', path.join(root, 'deploy-site'));
console.log('');
