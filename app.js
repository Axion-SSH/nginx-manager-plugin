/* Nginx Manager — single-file bundle.
 *
 * The iframe runs with `sandbox="allow-scripts"` (no allow-same-origin),
 * which gives us an opaque origin. fetch() and ESM module loading both
 * require CORS in that mode, and the host doesn't send CORS headers, so
 * neither works. Classic <script src=...> bypasses CORS entirely, so
 * everything lives in one file loaded that way.
 *
 * Sections, in dependency order:
 *   - State (paths, opts, pubsub)
 *   - Util  (DOM helper, shell-quote, formatters, notify)
 *   - Templates (site scaffolds)
 *   - Diff (LCS line diff)
 *   - API  (axion exec/sudo/sftp wrappers + nginx-specific commands)
 *   - Modals (confirm / message / diff / editor / history)
 *   - Daemon panel (status pill + test/reload/restart)
 *   - Sites tab
 *   - Logs tab
 *   - SSL tab
 *   - Config tab (nginx.conf + conf.d + snippets)
 *   - Status tab (stub_status, workers, version)
 *   - Main entry (tab router, boot)
 */

(function () {
  'use strict';

  /* =========================================================================
   * STATE
   * ========================================================================= */

  const paths = {
    sitesAvail:    '/etc/nginx/sites-available',
    sitesEn:       '/etc/nginx/sites-enabled',
    confDir:       '/etc/nginx/conf.d',
    snippetsDir:   '/etc/nginx/snippets',
    nginxConf:     '/etc/nginx/nginx.conf',
    logsDir:       '/var/log/nginx',
    letsencryptDir:'/etc/letsencrypt',
    service:       'nginx',
    stubStatusUrl: 'http://127.0.0.1/nginx_status',
  };

  const opts = {
    statusPollSec: 15,
    backupCount: 5,
  };

  const state = {
    pendingReload: false,
    daemonActive: 'unknown',
  };

  const subs = new Set();
  function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
  function emit() { subs.forEach(fn => { try { fn(state); } catch (_) {} }); }

  function setPending(v) {
    const b = !!v;
    if (state.pendingReload === b) return;
    state.pendingReload = b;
    emit();
  }

  function setDaemon(active) {
    if (state.daemonActive === active) return;
    state.daemonActive = active;
    emit();
  }

  function applySettings(s) {
    if (!s) return;
    if (typeof s.sitesAvailable === 'string' && s.sitesAvailable) paths.sitesAvail = s.sitesAvailable;
    if (typeof s.sitesEnabled   === 'string' && s.sitesEnabled)   paths.sitesEn   = s.sitesEnabled;
    if (typeof s.confDir        === 'string' && s.confDir)        paths.confDir   = s.confDir;
    if (typeof s.snippetsDir    === 'string' && s.snippetsDir)    paths.snippetsDir = s.snippetsDir;
    if (typeof s.nginxConf      === 'string' && s.nginxConf)      paths.nginxConf = s.nginxConf;
    if (typeof s.logsDir        === 'string' && s.logsDir)        paths.logsDir   = s.logsDir;
    if (typeof s.letsencryptDir === 'string' && s.letsencryptDir) paths.letsencryptDir = s.letsencryptDir;
    if (typeof s.service        === 'string' && s.service)        paths.service   = s.service;
    if (typeof s.stubStatusUrl  === 'string')                     paths.stubStatusUrl = s.stubStatusUrl;
    if (typeof s.statusPollSec  === 'number' && s.statusPollSec >= 0) opts.statusPollSec = s.statusPollSec;
    if (typeof s.backupCount    === 'number' && s.backupCount >= 0)   opts.backupCount   = s.backupCount;
  }

  /* =========================================================================
   * UTIL
   * ========================================================================= */

  const $ = (id) => document.getElementById(id);
  const FILENAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

  function el(tag, props, ...children) {
    props = props || {};
    const e = document.createElement(tag);
    for (const k of Object.keys(props)) {
      const v = props[k];
      if (k === 'class') e.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') e.innerHTML = v;
      else if (k in e) e[k] = v;
      else e.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      e.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return e;
  }

  function shellQuote(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
  }

  function debounce(fn, ms) {
    let t;
    return function () {
      const args = arguments;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(null, args), ms);
    };
  }

  function fmtBytes(n) {
    if (!n || isNaN(n)) return '0 B';
    const u = ['B','KB','MB','GB','TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(i ? 1 : 0) + ' ' + u[i];
  }

  function fmtDate(d) {
    if (!(d instanceof Date) || isNaN(d.getTime())) return '-';
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) +
           ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function relTime(d) {
    if (!(d instanceof Date) || isNaN(d.getTime())) return '';
    const diff = (d.getTime() - Date.now()) / 1000;
    const abs = Math.abs(diff);
    const past = diff < 0;
    let v, u;
    if (abs < 60)         { v = Math.round(abs);          u = 's'; }
    else if (abs < 3600)  { v = Math.round(abs / 60);     u = 'm'; }
    else if (abs < 86400) { v = Math.round(abs / 3600);   u = 'h'; }
    else                  { v = Math.round(abs / 86400);  u = 'd'; }
    return past ? v + u + ' ago' : 'in ' + v + u;
  }

  function notify(message, tone) {
    try { window.axion && window.axion.ui && window.axion.ui.notify(message, tone ? { tone: tone } : undefined); }
    catch (_) {}
  }

  function isSudoCancel(e) {
    return e && e.code === 'E_SUDO_CANCELLED';
  }

  function validFilename(name) {
    return typeof name === 'string' && FILENAME_RE.test(name) && !name.includes('/') && name !== '.' && name !== '..';
  }

  /* =========================================================================
   * TEMPLATES
   * ========================================================================= */

  const TEMPLATES = [
    {
      id: 'static',
      name: 'Static site',
      description: 'Serve files from a directory',
      content:
'server {\n' +
'  listen 80;\n' +
'  server_name example.com;\n' +
'\n' +
'  root /var/www/example.com;\n' +
'  index index.html index.htm;\n' +
'\n' +
'  location / {\n' +
'    try_files $uri $uri/ =404;\n' +
'  }\n' +
'}\n',
    },
    {
      id: 'proxy',
      name: 'Reverse proxy',
      description: 'Forward requests to a backend',
      content:
'server {\n' +
'  listen 80;\n' +
'  server_name app.example.com;\n' +
'\n' +
'  location / {\n' +
'    proxy_pass http://127.0.0.1:3000;\n' +
'    proxy_http_version 1.1;\n' +
'    proxy_set_header Host $host;\n' +
'    proxy_set_header X-Real-IP $remote_addr;\n' +
'    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n' +
'    proxy_set_header X-Forwarded-Proto $scheme;\n' +
'    proxy_set_header Upgrade $http_upgrade;\n' +
'    proxy_set_header Connection "upgrade";\n' +
'  }\n' +
'}\n',
    },
    {
      id: 'php',
      name: 'PHP-FPM',
      description: 'PHP application via FastCGI',
      content:
'server {\n' +
'  listen 80;\n' +
'  server_name example.com;\n' +
'\n' +
'  root  /var/www/example.com;\n' +
'  index index.php index.html;\n' +
'\n' +
'  location / {\n' +
'    try_files $uri $uri/ /index.php?$args;\n' +
'  }\n' +
'\n' +
'  location ~ \\.php$ {\n' +
'    fastcgi_pass unix:/run/php/php-fpm.sock;\n' +
'    fastcgi_index index.php;\n' +
'    include fastcgi_params;\n' +
'    fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;\n' +
'  }\n' +
'\n' +
'  location ~ /\\.ht {\n' +
'    deny all;\n' +
'  }\n' +
'}\n',
    },
    {
      id: 'redirect',
      name: 'Redirect',
      description: '301 to another domain',
      content:
'server {\n' +
'  listen 80;\n' +
'  server_name old.example.com;\n' +
'\n' +
'  return 301 https://new.example.com$request_uri;\n' +
'}\n',
    },
    {
      id: 'ssl',
      name: 'HTTPS site',
      description: 'TLS site with HTTP->HTTPS redirect',
      content:
'server {\n' +
'  listen 80;\n' +
'  server_name example.com;\n' +
'  return 301 https://$host$request_uri;\n' +
'}\n' +
'\n' +
'server {\n' +
'  listen 443 ssl;\n' +
'  http2 on;\n' +
'  server_name example.com;\n' +
'\n' +
'  ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;\n' +
'  ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;\n' +
'\n' +
'  root  /var/www/example.com;\n' +
'  index index.html;\n' +
'\n' +
'  location / {\n' +
'    try_files $uri $uri/ =404;\n' +
'  }\n' +
'}\n',
    },
  ];

  /* =========================================================================
   * DIFF
   * ========================================================================= */

  const DIFF_MAX_LINES = 5000;

  function diffLines(a, b) {
    const al = String(a == null ? '' : a).split('\n');
    const bl = String(b == null ? '' : b).split('\n');
    if (al.length > DIFF_MAX_LINES || bl.length > DIFF_MAX_LINES) {
      return [{ type: 'note', text: 'Diff skipped — file exceeds ' + DIFF_MAX_LINES + ' lines.' }];
    }
    const m = al.length, n = bl.length;
    const dp = [];
    for (let i = 0; i <= m; i++) dp.push(new Int32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        if (al[i] === bl[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
        else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const out = [];
    let i = 0, j = 0;
    while (i < m && j < n) {
      if (al[i] === bl[j])                  { out.push({ type: 'eq',  text: al[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: al[i] }); i++; }
      else                                   { out.push({ type: 'add', text: bl[j] }); j++; }
    }
    while (i < m) out.push({ type: 'del', text: al[i++] });
    while (j < n) out.push({ type: 'add', text: bl[j++] });
    return out;
  }

  function summarizeDiff(diff) {
    let add = 0, del = 0;
    for (const d of diff) {
      if (d.type === 'add') add++;
      else if (d.type === 'del') del++;
    }
    return { add: add, del: del };
  }

  /* =========================================================================
   * API — wrappers around axion.exec/sudo/sftp/storage
   * ========================================================================= */

  async function exec(cmd) {
    try {
      const r = await window.axion.exec(cmd);
      return Object.assign({}, r, { _err: r.exitCode !== 0 });
    } catch (e) {
      return { stdout: '', stderr: String(e.message || e), exitCode: -1, _err: true, _ex: e };
    }
  }

  async function sudo(cmd) {
    return await window.axion.sudo(cmd);
  }

  async function listDir(absPath) {
    const r = await exec('ls -1 ' + shellQuote(absPath));
    if (r._err) return { ok: false, items: [], error: (r.stderr || '').trim() };
    const items = (r.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
    return { ok: true, items: items };
  }

  async function readFile(absPath) {
    const r = await exec('cat ' + shellQuote(absPath));
    if (!r._err) return { ok: true, content: r.stdout || '' };
    if (/permission denied/i.test(r.stderr || '')) {
      return { ok: false, needsSudo: true, error: r.stderr.trim() };
    }
    return { ok: false, error: (r.stderr || '').trim() || ('exit ' + r.exitCode) };
  }

  async function readFileSudo(absPath) {
    try {
      const r = await sudo('cat ' + shellQuote(absPath));
      if (r.exitCode !== 0) return { ok: false, error: (r.stderr || '').trim() };
      return { ok: true, content: r.stdout || '' };
    } catch (e) {
      return { ok: false, error: e.message || String(e), _ex: e };
    }
  }

  async function stageTemp(content) {
    const tmp = '/tmp/.nmgr-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    await window.axion.sftp.write(tmp, new TextEncoder().encode(content));
    return tmp;
  }

  // Save staged tmp → target and run nginx -t in one sudo. Restore on fail.
  async function saveAndTest(stagedTmpPath, targetPath) {
    const tmp = shellQuote(stagedTmpPath);
    const tgt = shellQuote(targetPath);
    const bak = shellQuote(targetPath + '.nmgr-backup');
    const script =
      'cp -f ' + tgt + ' ' + bak + ' 2>/dev/null; ' +
      'mv ' + tmp + ' ' + tgt + ' && nginx -t 2>&1 ' +
      '&& { rm -f ' + bak + '; exit 0; } ' +
      '|| { if [ -f ' + bak + ' ]; then mv -f ' + bak + ' ' + tgt + '; else rm -f ' + tgt + '; fi; exit 1; }';
    try {
      const r = await sudo('bash -c ' + shellQuote(script));
      return {
        ok: r.exitCode === 0,
        exitCode: r.exitCode,
        stdout: r.stdout || '',
        stderr: r.stderr || '',
        restored: r.exitCode !== 0,
      };
    } catch (e) {
      await exec('rm -f ' + tmp);
      throw e;
    }
  }

  async function daemonIsActive() {
    const r = await exec('systemctl is-active ' + shellQuote(paths.service));
    return (r.stdout || '').trim();
  }

  async function daemonStatusText() {
    const r = await exec('systemctl status ' + shellQuote(paths.service) + ' --no-pager -l');
    return (r.stdout || '') + ((r.stderr || '') ? '\n' + r.stderr : '');
  }

  async function daemonReload()  { return await sudo('systemctl reload '  + shellQuote(paths.service)); }
  async function daemonRestart() { return await sudo('systemctl restart ' + shellQuote(paths.service)); }
  async function daemonTest()    { return await sudo('nginx -t 2>&1'); }

  async function enableSiteRpc(name) {
    return await sudo('ln -sf ' + shellQuote(paths.sitesAvail + '/' + name) + ' ' + shellQuote(paths.sitesEn + '/' + name));
  }

  async function disableSiteRpc(name) {
    return await sudo('rm ' + shellQuote(paths.sitesEn + '/' + name));
  }

  async function deleteSiteRpc(name, isEnabled) {
    const targets = [paths.sitesAvail + '/' + name];
    if (isEnabled) targets.push(paths.sitesEn + '/' + name);
    return await sudo('rm -f ' + targets.map(shellQuote).join(' '));
  }

  async function tailLog(absPath, lines, sudoMode) {
    const cmd = 'tail -n ' + Math.max(1, Math.floor(lines)) + ' ' + shellQuote(absPath);
    if (sudoMode) {
      try {
        const r = await sudo(cmd);
        return { ok: r.exitCode === 0, content: r.stdout || '', error: (r.stderr || '').trim() };
      } catch (e) {
        return { ok: false, content: '', error: e.message || String(e), _ex: e };
      }
    }
    const r = await exec(cmd);
    if (r._err) {
      if (/permission denied/i.test(r.stderr || '')) {
        return { ok: false, content: '', error: r.stderr.trim(), needsSudo: true };
      }
      return { ok: false, content: '', error: (r.stderr || '').trim() };
    }
    return { ok: true, content: r.stdout || '' };
  }

  async function discoverLetsEncryptCerts() {
    const root = paths.letsencryptDir.replace(/\/$/, '');
    const SEP = '<<NMGR-CERT>>';
    const script =
      'for d in ' + shellQuote(root + '/live') + '/*/; do ' +
      '  [ -d "$d" ] || continue; ' +
      '  name=$(basename "$d"); ' +
      '  case "$name" in README) continue;; esac; ' +
      '  cert="$d/fullchain.pem"; ' +
      '  [ -f "$cert" ] || cert="$d/cert.pem"; ' +
      '  [ -f "$cert" ] || continue; ' +
      '  echo "' + SEP + '|$name|$cert"; ' +
      '  openssl x509 -in "$cert" -noout -subject -issuer -startdate -enddate -ext subjectAltName 2>&1 || true; ' +
      'done';
    try {
      const r = await sudo('bash -c ' + shellQuote(script));
      return { ok: true, raw: r.stdout || '', stderr: r.stderr || '', exitCode: r.exitCode, _sep: SEP };
    } catch (e) {
      return { ok: false, error: e.message || String(e), _ex: e };
    }
  }

  async function nginxVersionText() {
    const r = await exec('nginx -v 2>&1');
    return (r.stdout || r.stderr || '').trim();
  }

  async function workerProcesses() {
    const r = await exec('ps -C nginx -o pid=,user=,rss=,etime=,cmd= 2>/dev/null');
    if (r._err) return { ok: false, items: [], error: (r.stderr || '').trim() };
    const items = (r.stdout || '').split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const m = line.match(/^(\d+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(.+)$/);
        if (!m) return null;
        return { pid: m[1], user: m[2], rssKb: Number(m[3]), etime: m[4], cmd: m[5] };
      })
      .filter(Boolean);
    return { ok: true, items: items };
  }

  async function fetchStubStatus() {
    if (!paths.stubStatusUrl) return { ok: false, disabled: true };
    const r = await exec('curl -fsS --max-time 3 ' + shellQuote(paths.stubStatusUrl));
    if (r._err) return { ok: false, error: (r.stderr || '').trim() || ('exit ' + r.exitCode) };
    return { ok: true, raw: r.stdout || '' };
  }

  // Per-extension JSON storage; backups live as { 'category:name': [ {ts, content} ] }.
  const BACKUP_KEY = 'backups';

  async function pushBackup(category, name, content) {
    if (!opts.backupCount) return;
    const all = (await window.axion.storage.get(BACKUP_KEY)) || {};
    const key = category + ':' + name;
    const list = Array.isArray(all[key]) ? all[key] : [];
    list.unshift({ ts: Date.now(), content: content });
    while (list.length > opts.backupCount) list.pop();
    all[key] = list;
    await window.axion.storage.set(BACKUP_KEY, all);
  }

  async function listBackups(category, name) {
    const all = (await window.axion.storage.get(BACKUP_KEY)) || {};
    return all[category + ':' + name] || [];
  }

  /* =========================================================================
   * MODALS — confirm, message, diff, editor, history. Stacked.
   * ========================================================================= */

  let backdrop = null;
  const stack = [];

  function ensureBackdrop() {
    if (backdrop) return backdrop;
    backdrop = el('div', { id: 'modal-backdrop', class: 'modal-backdrop', hidden: true });
    backdrop.addEventListener('click', (e) => {
      if (e.target !== backdrop) return;
      const top = stack[stack.length - 1];
      if (top && top.dismissOnBackdrop !== false) top.cancel();
    });
    document.body.appendChild(backdrop);
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const top = stack[stack.length - 1];
      if (top) top.cancel();
    });
    return backdrop;
  }

  function show(card, opts) {
    opts = opts || {};
    const bd = ensureBackdrop();
    bd.hidden = false;
    for (const child of Array.from(bd.children)) child.hidden = true;
    bd.appendChild(card);
    card.hidden = false;
    return new Promise((resolve) => {
      const entry = {
        card: card,
        dismissOnBackdrop: opts.dismissOnBackdrop !== false,
        cancel: () => settle(undefined),
        resolve: (v) => settle(v),
      };
      function settle(v) {
        const idx = stack.indexOf(entry);
        if (idx === -1) return;
        stack.splice(idx, 1);
        card.remove();
        if (stack.length === 0) bd.hidden = true;
        else stack[stack.length - 1].card.hidden = false;
        resolve(v);
      }
      stack.push(entry);
    });
  }

  function confirmDialog(o) {
    o = Object.assign({ title: 'Confirm', message: '', okText: 'Confirm', cancelText: 'Cancel', danger: true }, o || {});
    let entry;
    const okBtn = el('button', {
      class: 'ax-btn ' + (o.danger ? 'ax-btn-danger' : 'ax-btn-primary'),
      onclick: () => entry.resolve(true),
    }, o.okText);
    const cancelBtn = el('button', { class: 'ax-btn ax-btn-ghost', onclick: () => entry.resolve(false) }, o.cancelText);
    const card = el('div', { class: 'ax-glass modal-card sm' },
      el('h2', { class: 'ax-h2' }, o.title),
      el('p', { class: 'ax-text' }, o.message),
      el('div', { class: 'modal-foot' }, cancelBtn, okBtn),
    );
    const p = show(card, { dismissOnBackdrop: true });
    entry = stack[stack.length - 1];
    return p.then(v => v === true);
  }

  function messageDialog(o) {
    o = Object.assign({ title: 'Notice', message: '', okText: 'OK', tone: 'info' }, o || {});
    const okBtn = el('button', { class: 'ax-btn ax-btn-primary' }, o.okText);
    const card = el('div', { class: 'ax-glass modal-card sm' },
      el('h2', { class: 'ax-h2' }, o.title),
      el('p', { class: o.tone === 'error' ? 'ax-text ax-text-error' : 'ax-text' }, o.message),
      el('div', { class: 'modal-foot' }, okBtn),
    );
    const p = show(card);
    okBtn.addEventListener('click', () => stack[stack.length - 1].resolve(true));
    return p;
  }

  function diffDialog(o) {
    o = Object.assign({ title: 'Diff', original: '', current: '' }, o || {});
    const closeBtn = el('button', { class: 'ax-btn ax-btn-primary' }, 'Close');
    const wrap = el('div', { class: 'diff-wrap' });
    const diff = diffLines(o.original, o.current);
    const sum = summarizeDiff(diff);
    for (const d of diff) {
      if (d.type === 'note') {
        wrap.appendChild(el('div', { class: 'diff-line eq' },
          el('span', { class: 'marker' }, ''),
          el('span', {}, d.text),
        ));
        continue;
      }
      const marker = d.type === 'add' ? '+' : d.type === 'del' ? '-' : ' ';
      wrap.appendChild(el('div', { class: 'diff-line ' + d.type },
        el('span', { class: 'marker' }, marker),
        el('span', {}, d.text || ' '),
      ));
    }
    const summary = el('span', { class: 'ax-text-muted' },
      sum.add ? (sum.add + ' added') : '',
      sum.add && sum.del ? ' . ' : '',
      sum.del ? (sum.del + ' removed') : '',
      !sum.add && !sum.del ? 'No changes' : '',
    );
    const card = el('div', { class: 'ax-glass modal-card lg' },
      el('header', { class: 'ax-row', style: { justifyContent: 'space-between' } },
        el('h2', { class: 'ax-h2' }, o.title),
        summary,
      ),
      wrap,
      el('div', { class: 'modal-foot' }, closeBtn),
    );
    const p = show(card);
    closeBtn.addEventListener('click', () => stack[stack.length - 1].resolve(true));
    return p;
  }

  function editorDialog(o) {
    o = o || {};
    let originalContent = '';
    let entry;
    let nameInput, codeArea, errorBox;

    const saveBtn   = el('button', { class: 'ax-btn ax-btn-primary', onclick: handleSave }, 'Save');
    const cancelBtn = el('button', { class: 'ax-btn ax-btn-ghost',   onclick: () => entry.resolve({ saved: false }) }, 'Cancel');
    const diffBtn   = el('button', { class: 'ax-btn ax-btn-ghost',   onclick: () => diffDialog({ title: 'Pending changes', original: originalContent, current: codeArea.value }) }, 'Diff');

    errorBox = el('div', { class: 'ax-text ax-text-error', hidden: true, style: { fontSize: '12px' } });

    nameInput = el('input', {
      class: 'ax-input',
      placeholder: o.namePlaceholder || 'example.com',
      autocomplete: 'off',
      spellcheck: false,
      value: o.name || '',
      disabled: o.nameEditable === false,
    });

    codeArea = el('textarea', {
      class: 'ax-textarea editor-area',
      spellcheck: false,
      value: o.loadContent ? 'Loading...' : (o.content || ''),
    });

    const headLeft = el('h2', { class: 'ax-h2' }, o.title || 'Edit');
    const headRight = el('div', { class: 'ax-row', style: { gap: '6px' } });
    if (o.showHistory) {
      headRight.appendChild(el('button', {
        class: 'ax-btn ax-btn-ghost ax-btn-sm', onclick: o.showHistory,
      }, 'History'));
    }

    let templateBar = null;
    if (o.templates && o.templates.length) {
      const sel = el('select', { class: 'ax-select' },
        el('option', { value: '' }, 'Insert template...'),
        ...o.templates.map(t => el('option', { value: t.id }, t.name)),
      );
      sel.addEventListener('change', async (e) => {
        const id = e.target.value;
        const t = o.templates.find(x => x.id === id);
        if (!t) return;
        const cur = codeArea.value.trim();
        if (cur && cur !== originalContent.trim()) {
          const ok = await confirmDialog({
            title: 'Replace contents?',
            message: 'This will overwrite the editor with the selected template.',
            okText: 'Replace',
            danger: false,
          });
          if (!ok) { sel.value = ''; return; }
        }
        codeArea.value = t.content;
        sel.value = '';
        codeArea.focus();
      });
      templateBar = el('div', { class: 'ax-row' },
        el('span', { class: 'ax-text-muted', style: { fontSize: '11px' } }, 'Templates:'),
        sel,
      );
    }

    const card = el('div', { class: 'ax-glass modal-card lg' },
      el('header', { class: 'ax-row', style: { justifyContent: 'space-between' } }, headLeft, headRight),
      el('label', { class: 'ax-label' }, o.nameLabel || 'Name'),
      nameInput,
      templateBar,
      el('label', { class: 'ax-label' }, 'Config'),
      codeArea,
      errorBox,
      el('div', { class: 'modal-foot' }, diffBtn, cancelBtn, saveBtn),
    );

    const p = show(card, { dismissOnBackdrop: false });
    entry = stack[stack.length - 1];

    if (o.loadContent) {
      Promise.resolve().then(async () => {
        try {
          const c = await o.loadContent();
          originalContent = c;
          codeArea.value = c;
        } catch (e) {
          codeArea.value = '# Could not load: ' + (e.message || e);
        }
      });
    } else {
      originalContent = o.content || '';
    }

    setTimeout(() => (o.nameEditable === false ? codeArea : nameInput).focus(), 0);

    async function handleSave() {
      const name = (nameInput.value || '').trim();
      const content = codeArea.value;
      errorBox.hidden = true; errorBox.textContent = '';
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      try {
        const r = o.onSave ? await o.onSave({ name: name, content: content, original: originalContent }) : { ok: true };
        if (r && r.ok) {
          entry.resolve({ saved: true, name: name, content: content });
        } else {
          errorBox.textContent = (r && r.error) || 'Save failed';
          errorBox.hidden = false;
        }
      } catch (e) {
        errorBox.textContent = e.message || String(e);
        errorBox.hidden = false;
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
      }
    }

    return p;
  }

  function outputDialog(o) {
    o = Object.assign({ title: 'Result', text: '', tone: 'info' }, o || {});
    const closeBtn = el('button', { class: 'ax-btn ax-btn-primary' }, 'Close');
    const pre = el('pre', { class: 'ax-code', style: {
      minHeight: '200px', maxHeight: '420px',
      overflow: 'auto', fontSize: '11px',
      whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      color: o.tone === 'error' ? 'var(--color-error)' : '',
    } }, o.text || '(no output)');
    const card = el('div', { class: 'ax-glass modal-card lg' },
      el('h2', { class: 'ax-h2' }, o.title),
      pre,
      el('div', { class: 'modal-foot' }, closeBtn),
    );
    const p = show(card);
    closeBtn.addEventListener('click', () => stack[stack.length - 1].resolve(true));
    return p;
  }

  function historyDialog(o) {
    o = Object.assign({ title: 'History', items: [], currentContent: '', onRestore: null }, o || {});
    const list = el('div', { class: 'ax-stack', style: { gap: '6px' } });
    if (!o.items.length) {
      list.appendChild(el('div', { class: 'ax-empty' },
        el('div', { class: 'ax-empty-title' }, 'No backups yet'),
        el('div', {}, 'Saved versions will appear here on the next edit.'),
      ));
    } else {
      o.items.forEach((it, idx) => {
        const when = new Date(it.ts);
        list.appendChild(el('div', { class: 'list-row' },
          el('div', { class: 'grow' },
            el('div', { class: 'ax-text' }, 'Version ' + (o.items.length - idx)),
            el('div', { class: 'sub' }, fmtDate(when) + ' . ' + relTime(when)),
          ),
          el('div', { class: 'actions' },
            el('button', {
              class: 'ax-btn ax-btn-ghost ax-btn-sm',
              onclick: () => diffDialog({
                title: 'Diff vs current (v' + (o.items.length - idx) + ')',
                original: it.content,
                current: o.currentContent,
              }),
            }, 'Diff'),
            el('button', {
              class: 'ax-btn ax-btn-outline ax-btn-sm',
              onclick: async () => {
                const ok = await confirmDialog({
                  title: 'Restore version?',
                  message: 'Restore the version from ' + fmtDate(when) + '? This writes it back to the file.',
                  okText: 'Restore',
                  danger: false,
                });
                if (!ok) return;
                if (o.onRestore) await o.onRestore(it);
                stack[stack.length - 1].resolve({ restored: true });
              },
            }, 'Restore'),
          ),
        ));
      });
    }
    const closeBtn = el('button', {
      class: 'ax-btn ax-btn-ghost',
      onclick: () => stack[stack.length - 1].resolve({ restored: false }),
    }, 'Close');
    const card = el('div', { class: 'ax-glass modal-card md' },
      el('h2', { class: 'ax-h2' }, o.title),
      list,
      el('div', { class: 'modal-foot' }, closeBtn),
    );
    return show(card);
  }

  /* =========================================================================
   * DAEMON PANEL
   * ========================================================================= */

  let daemonRefs = {};
  let pollTimer = null;

  function mountDaemon(container) {
    container.innerHTML = '';
    daemonRefs.statusPill = el('span', { class: 'ax-pill' }, '...');
    daemonRefs.testBtn    = el('button', { class: 'ax-btn ax-btn-ghost ax-btn-sm',   onclick: testConfig }, 'Test config');
    daemonRefs.reloadBtn  = el('button', { class: 'ax-btn ax-btn-outline ax-btn-sm', onclick: reloadAction }, 'Reload');
    daemonRefs.restartBtn = el('button', { class: 'ax-btn ax-btn-outline ax-btn-sm', onclick: restartAction }, 'Restart');
    daemonRefs.output     = el('pre', { class: 'ax-code', id: 'daemon-output', hidden: true });

    const head = el('header', { class: 'ax-row', style: { justifyContent: 'space-between' } },
      el('h1', { class: 'ax-h1' }, 'Nginx'),
      daemonRefs.statusPill,
    );
    const daemonRow = el('div', { class: 'ax-row', style: { justifyContent: 'space-between' } },
      el('span', { class: 'ax-label' }, 'Daemon'),
      el('div', { class: 'ax-row daemon-row' }, daemonRefs.testBtn, daemonRefs.reloadBtn, daemonRefs.restartBtn),
    );
    const panel = el('section', { class: 'ax-surface ax-stack' }, daemonRow, daemonRefs.output);

    container.append(head, panel);
    subscribe(() => paintReload());
    paintReload();
  }

  function setOutput(text, tone) {
    if (!text) { daemonRefs.output.hidden = true; daemonRefs.output.textContent = ''; return; }
    daemonRefs.output.hidden = false;
    daemonRefs.output.textContent = text;
    daemonRefs.output.style.color =
      tone === 'error'   ? 'var(--color-error)'   :
      tone === 'success' ? 'var(--color-success)' : '';
  }

  function paintReload() {
    if (!daemonRefs.reloadBtn) return;
    if (state.pendingReload) {
      daemonRefs.reloadBtn.className = 'ax-btn ax-btn-primary ax-btn-sm';
      daemonRefs.reloadBtn.title = 'Pending changes - reload to apply';
      daemonRefs.reloadBtn.innerHTML = '';
      daemonRefs.reloadBtn.append(
        el('span', { class: 'pending-dot' }),
        document.createTextNode('Reload'),
      );
    } else {
      daemonRefs.reloadBtn.className = 'ax-btn ax-btn-outline ax-btn-sm';
      daemonRefs.reloadBtn.title = '';
      daemonRefs.reloadBtn.textContent = 'Reload';
    }
  }

  function paintStatus(value) {
    setDaemon(value);
    const p = daemonRefs.statusPill;
    if (!p) return;
    if (value === 'active') { p.className = 'ax-pill ax-pill-success'; p.textContent = 'Active'; }
    else if (value === 'inactive') { p.className = 'ax-pill'; p.textContent = 'Inactive'; }
    else if (value === 'failed') { p.className = 'ax-pill ax-pill-error'; p.textContent = 'Failed'; }
    else if (value === 'activating' || value === 'reloading' || value === 'deactivating') {
      p.className = 'ax-pill ax-pill-warn'; p.textContent = value[0].toUpperCase() + value.slice(1);
    } else {
      p.className = 'ax-pill ax-pill-warn'; p.textContent = value || 'Unknown';
    }
  }

  async function refreshStatus() {
    try { paintStatus(await daemonIsActive()); }
    catch (_) { paintStatus('unknown'); }
  }

  function startStatusPoll() {
    stopStatusPoll();
    if (!opts.statusPollSec) return;
    pollTimer = setInterval(refreshStatus, Math.max(2, opts.statusPollSec) * 1000);
  }
  function stopStatusPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  async function testConfig() {
    setOutput('Testing...');
    try {
      const r = await daemonTest();
      const text = (r.stdout || '').trim() || (r.stderr || '').trim();
      if (r.exitCode === 0) { setOutput(text || 'Config OK', 'success'); notify('Config OK', 'success'); }
      else { setOutput(text || ('Test failed (exit ' + r.exitCode + ')'), 'error'); notify('Config test failed', 'error'); }
    } catch (e) {
      if (isSudoCancel(e)) { setOutput(''); return; }
      setOutput('Error: ' + (e.message || e), 'error');
    }
  }

  async function reloadAction() {
    setOutput('Reloading...');
    try {
      const r = await daemonReload();
      if (r.exitCode === 0) {
        setOutput('Reloaded.', 'success'); notify('Reloaded nginx', 'success'); setPending(false);
      } else {
        setOutput((r.stderr || r.stdout || '').trim() || ('Reload failed (exit ' + r.exitCode + ')'), 'error');
        notify('Reload failed', 'error');
      }
    } catch (e) {
      if (isSudoCancel(e)) { setOutput(''); return; }
      setOutput('Error: ' + (e.message || e), 'error');
    }
    refreshStatus();
  }

  async function restartAction() {
    const ok = await confirmDialog({
      title: 'Restart nginx',
      message: 'Restart the nginx service? Open connections will be interrupted briefly.',
      okText: 'Restart',
    });
    if (!ok) return;
    setOutput('Restarting...');
    try {
      const r = await daemonRestart();
      if (r.exitCode === 0) {
        setOutput('Restarted.', 'success'); notify('Restarted nginx', 'success'); setPending(false);
      } else {
        setOutput((r.stderr || r.stdout || '').trim() || ('Restart failed (exit ' + r.exitCode + ')'), 'error');
        notify('Restart failed', 'error');
      }
    } catch (e) {
      if (isSudoCancel(e)) { setOutput(''); return; }
      setOutput('Error: ' + (e.message || e), 'error');
    }
    refreshStatus();
  }

  /* =========================================================================
   * SITES TAB
   * ========================================================================= */

  let sitesContainer = null;
  let sitesAllRows = [];
  let sitesConflicts = {};
  let sitesFilter = '';
  let reloadPromptOpen = false;

  function mountSites(c) { sitesContainer = c; }

  async function showSites() {
    if (!sitesContainer) return;
    sitesContainer.innerHTML = '';

    const search = el('input', {
      class: 'ax-input',
      placeholder: 'Search sites...',
      value: sitesFilter,
      style: { maxWidth: '260px', padding: '6px 10px', fontSize: '12px' },
    });
    search.addEventListener('input', debounce((e) => { sitesFilter = e.target.value || ''; renderSitesList(); }, 100));

    const refreshBtn = el('button', { class: 'ax-btn ax-btn-ghost ax-btn-sm', onclick: () => loadSites(true) }, 'Refresh');
    const addBtn     = el('button', { class: 'ax-btn ax-btn-primary ax-btn-sm', onclick: openNewSite }, 'New site');

    const head = el('div', { class: 'ax-row', style: { justifyContent: 'space-between' } },
      el('div', { class: 'ax-row' }, el('span', { class: 'ax-label' }, 'Sites'), search),
      el('div', { class: 'ax-row', style: { gap: '6px' } }, refreshBtn, addBtn),
    );

    const listEl = el('div', { class: 'ax-stack', id: 'sites-list', style: { gap: '6px' } });
    sitesContainer.append(head, listEl);
    await loadSites(false);
  }

  async function loadSites(forceRescan) {
    const listEl = $('sites-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    listEl.appendChild(emptyEl('Loading...'));
    const [a, e] = await Promise.all([listDir(paths.sitesAvail), listDir(paths.sitesEn)]);
    if (!a.ok) {
      listEl.innerHTML = '';
      listEl.appendChild(emptyEl('Could not list sites', a.error || '', true));
      return;
    }
    const enabled = new Set(e.ok ? e.items : []);
    sitesAllRows = a.items.sort().map(name => ({ name: name, isEnabled: enabled.has(name) }));
    if (forceRescan) await scanSiteConflicts();
    renderSitesList();
    if (!forceRescan && Object.keys(sitesConflicts).length === 0) {
      void scanSiteConflicts().then(renderSitesList);
    }
  }

  function renderSitesList() {
    const listEl = $('sites-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    const q = sitesFilter.trim().toLowerCase();
    const rows = q ? sitesAllRows.filter(r => r.name.toLowerCase().includes(q)) : sitesAllRows;
    if (!rows.length) {
      listEl.appendChild(emptyEl(
        sitesAllRows.length ? 'No matches' : 'No sites yet',
        sitesAllRows.length ? 'Try clearing the search.' : 'Click New site to create one.',
      ));
      return;
    }
    for (const r of rows) listEl.appendChild(renderSiteRow(r));
  }

  function renderSiteRow(r) {
    const conflictMsg = sitesConflicts[r.name];
    const row = el('div', { class: 'list-row' + (conflictMsg ? ' row-warn' : ''), title: conflictMsg || '' });
    const left = el('div', { class: 'grow' },
      el('div', { class: 'name ax-text' }, r.name),
      conflictMsg ? el('div', { class: 'sub ax-text-warn' }, conflictMsg) : null,
    );
    const pill = el('span', { class: r.isEnabled ? 'ax-pill ax-pill-success' : 'ax-pill' }, r.isEnabled ? 'enabled' : 'disabled');
    const actions = el('div', { class: 'actions' },
      mkBtn('Edit',     'ax-btn-ghost ax-btn-sm',   () => openEditSite(r.name)),
      mkBtn(r.isEnabled ? 'Disable' : 'Enable', 'ax-btn-outline ax-btn-sm', () => toggleSite(r.name, r.isEnabled)),
      mkBtn('Duplicate','ax-btn-ghost ax-btn-sm',   () => duplicateSite(r.name)),
      mkBtn('Delete',   'ax-btn-ghost ax-btn-sm',   () => deleteSiteFlow(r.name, r.isEnabled)),
    );
    row.append(left, pill, actions);
    return row;
  }

  function mkBtn(label, klass, onClick) {
    return el('button', { class: 'ax-btn ' + klass, onclick: onClick }, label);
  }

  function emptyEl(title, body, isError) {
    return el('div', { class: 'ax-empty' },
      el('div', { class: 'ax-empty-title' + (isError ? ' ax-text-error' : '') }, title),
      body ? el('div', {}, body) : null,
    );
  }

  async function openNewSite() {
    await editorDialog({
      title: 'New site',
      name: '',
      nameLabel: 'Filename',
      namePlaceholder: 'example.com',
      templates: TEMPLATES,
      onSave: handleSiteSave(null),
    });
    loadSites(true);
  }

  async function openEditSite(name) {
    await editorDialog({
      title: 'Edit ' + name,
      name: name,
      nameEditable: false,
      nameLabel: 'Filename',
      loadContent: async () => {
        const r = await readFile(paths.sitesAvail + '/' + name);
        if (r.ok) return r.content;
        throw new Error(r.error || 'Could not read');
      },
      onSave: handleSiteSave(name),
      showHistory: () => openSiteHistory(name),
    });
    loadSites(true);
  }

  function handleSiteSave(originalName) {
    return async (args) => {
      const name = args.name, content = args.content, original = args.original;
      if (!validFilename(name)) {
        return { ok: false, error: 'Invalid filename. Use letters, digits, dot, underscore, dash; cannot start with dash or dot.' };
      }
      const target = paths.sitesAvail + '/' + name;
      let tmp;
      try { tmp = await stageTemp(content); }
      catch (e) { return { ok: false, error: 'Could not stage temp file: ' + (e.message || e) }; }
      try {
        const r = await saveAndTest(tmp, target);
        if (!r.ok) {
          const out = (r.stderr || r.stdout || '').trim();
          return { ok: false, error: 'nginx -t failed.' + (r.restored ? ' Original restored.' : '') + '\n' + out };
        }
        if (originalName && original) await pushBackup('site', originalName, original);
        setPending(true);
        notify(originalName ? ('Updated ' + name) : ('Created ' + name), 'success');
        promptReload();
        return { ok: true };
      } catch (e) {
        if (isSudoCancel(e)) return { ok: false, error: 'Cancelled.' };
        return { ok: false, error: e.message || String(e) };
      }
    };
  }

  async function toggleSite(name, isEnabled) {
    try {
      if (isEnabled) { await disableSiteRpc(name); notify(name + ' disabled'); }
      else { await enableSiteRpc(name); notify(name + ' enabled', 'success'); }
      setPending(true);
      promptReload();
      loadSites(true);
    } catch (e) {
      if (!isSudoCancel(e)) notify('Action failed: ' + (e.message || e), 'error');
    }
  }

  async function duplicateSite(name) {
    const r = await readFile(paths.sitesAvail + '/' + name);
    if (!r.ok) { notify('Could not read source: ' + (r.error || ''), 'error'); return; }
    await editorDialog({
      title: 'Duplicate ' + name,
      name: name + '.copy',
      nameLabel: 'New filename',
      nameEditable: true,
      onSave: handleSiteSave(null),
      loadContent: async () => r.content,
    });
    loadSites(true);
  }

  async function deleteSiteFlow(name, isEnabled) {
    const ok = await confirmDialog({
      title: 'Delete site',
      message: 'Delete "' + name + '"?' + (isEnabled ? ' It is currently enabled - the symlink will also be removed.' : ''),
      okText: 'Delete',
    });
    if (!ok) return;
    try {
      const cur = await readFile(paths.sitesAvail + '/' + name);
      if (cur.ok) await pushBackup('site', name, cur.content);
      await deleteSiteRpc(name, isEnabled);
      notify(name + ' deleted', 'success');
      if (isEnabled) setPending(true);
      promptReload();
      loadSites(true);
    } catch (e) {
      if (!isSudoCancel(e)) notify('Delete failed: ' + (e.message || e), 'error');
    }
  }

  async function openSiteHistory(name) {
    const items = await listBackups('site', name);
    await historyDialog({
      title: 'History - ' + name,
      items: items,
      currentContent: '',
      onRestore: async (entry) => {
        const target = paths.sitesAvail + '/' + name;
        let tmp;
        try { tmp = await stageTemp(entry.content); }
        catch (e) { notify('Stage failed: ' + (e.message || e), 'error'); return; }
        try {
          const r = await saveAndTest(tmp, target);
          if (r.ok) { notify('Restored ' + name, 'success'); setPending(true); promptReload(); }
          else { notify('Restore failed nginx -t - original kept.', 'error'); }
        } catch (e) {
          if (!isSudoCancel(e)) notify('Restore failed: ' + (e.message || e), 'error');
        }
      },
    });
  }

  async function promptReload() {
    if (reloadPromptOpen) return;
    reloadPromptOpen = true;
    try {
      const ok = await confirmDialog({
        title: 'Reload nginx?',
        message: 'Apply the change now by reloading nginx? You can also click Reload in the daemon panel later.',
        okText: 'Reload now',
        cancelText: 'Later',
        danger: false,
      });
      if (!ok) return;
      setOutput('Reloading...');
      try {
        const r = await daemonReload();
        if (r.exitCode === 0) {
          setOutput('Reloaded.', 'success'); notify('Reloaded nginx', 'success'); setPending(false);
        } else {
          setOutput((r.stderr || r.stdout || '').trim() || ('Reload failed (exit ' + r.exitCode + ')'), 'error');
          notify('Reload failed', 'error');
        }
      } catch (e) {
        if (!isSudoCancel(e)) setOutput('Error: ' + (e.message || e), 'error');
      }
    } finally {
      reloadPromptOpen = false;
    }
  }

  async function scanSiteConflicts() {
    sitesConflicts = {};
    const enabled = sitesAllRows.filter(r => r.isEnabled);
    if (!enabled.length) return;
    const filesArg = enabled.map(r => shellQuote(paths.sitesAvail + '/' + r.name)).join(' ');
    const r = await exec('tail -n +1 ' + filesArg);
    if (r._err && !r.stdout) return;
    const blocks = parseTailHeaders(r.stdout || '');
    const seen = new Map();
    for (const blk of blocks) {
      const servers = parseServerBlocks(blk.content);
      for (const s of servers) {
        for (const listen of s.listens) {
          for (const sn of (s.serverNames.length ? s.serverNames : [''])) {
            const key = listen + '|' + sn;
            if (seen.has(key)) {
              const first = seen.get(key);
              if (first !== blk.name) {
                const note = 'Conflicts with ' + first + ' on listen ' + listen + (sn ? ' server_name ' + sn : '');
                sitesConflicts[blk.name] = (sitesConflicts[blk.name] ? sitesConflicts[blk.name] + '; ' : '') + note;
                sitesConflicts[first] = (sitesConflicts[first] ? sitesConflicts[first] + '; ' : '') +
                  ('Conflicts with ' + blk.name + ' on listen ' + listen + (sn ? ' server_name ' + sn : ''));
              }
            } else {
              seen.set(key, blk.name);
            }
          }
        }
      }
    }
  }

  function parseTailHeaders(text) {
    const out = [];
    const lines = text.split('\n');
    let cur = null;
    for (const line of lines) {
      const m = line.match(/^==>\s+(.+)\s+<==$/);
      if (m) {
        if (cur) out.push(cur);
        cur = { name: m[1].split('/').pop(), content: '' };
      } else if (cur) {
        cur.content += line + '\n';
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  function parseServerBlocks(text) {
    const stripped = text.replace(/#.*$/gm, '');
    const blocks = [];
    let depth = 0, inServer = false, serverStart = -1;
    for (let i = 0; i < stripped.length; i++) {
      const c = stripped[i];
      if (!inServer) {
        if (c === '{') {
          const head = stripped.slice(Math.max(0, i - 80), i);
          if (/(^|\s)server\s*$/.test(head)) {
            inServer = true; depth = 1; serverStart = i + 1;
          }
        }
      } else {
        if (c === '{') depth++;
        else if (c === '}') {
          depth--;
          if (depth === 0) { blocks.push(stripped.slice(serverStart, i)); inServer = false; }
        }
      }
    }
    return blocks.map(body => {
      const flat = stripNested(body);
      const listens = matchAllRe(flat, /\blisten\s+([^;]+);/g).map(m => normalizeListen(m[1]));
      const serverNames = [];
      for (const m of matchAllRe(flat, /\bserver_name\s+([^;]+);/g)) {
        m[1].trim().split(/\s+/).forEach(n => { if (n) serverNames.push(n); });
      }
      return { listens: listens, serverNames: serverNames };
    });
  }

  function stripNested(body) {
    let out = '', depth = 0;
    for (const c of body) {
      if (c === '{') depth++;
      else if (c === '}') { if (depth > 0) depth--; continue; }
      if (depth === 0) out += c;
    }
    return out;
  }

  function matchAllRe(str, re) { const out = []; let m; while ((m = re.exec(str)) !== null) out.push(m); return out; }

  function normalizeListen(spec) {
    const parts = spec.trim().split(/\s+/);
    const first = parts[0];
    if (first.includes(':')) return first;
    return '*:' + first;
  }

  /* =========================================================================
   * LOGS TAB
   * ========================================================================= */

  let logsContainer = null;
  let logsOutput   = null;
  let logsPicker   = null;
  let logsFilter   = null;
  let logsLines    = null;
  let logsAuto     = null;
  let logsUseSudo  = false;
  let logsPoll     = null;
  let logsKnown    = [];
  let logsLastContent = '';

  function mountLogs(c) { logsContainer = c; }

  async function showLogs() {
    if (!logsContainer) return;
    logsContainer.innerHTML = '';

    logsPicker = el('select', { class: 'ax-select' }, el('option', { value: '' }, 'Loading...'));
    logsPicker.addEventListener('change', () => { logsUseSudo = false; refreshLogs(); });

    logsLines = el('select', { class: 'ax-select' },
      ...['100','200','500','1000','5000'].map(n => el('option', { value: n }, n + ' lines')),
    );
    logsLines.value = '500';
    logsLines.addEventListener('change', refreshLogs);

    logsFilter = el('input', { class: 'ax-input', placeholder: 'Filter (substring)...' });
    logsFilter.addEventListener('input', debounce(applyLogsFilter, 100));

    const refreshBtn = el('button', { class: 'ax-btn ax-btn-ghost ax-btn-sm', onclick: refreshLogs }, 'Refresh');
    const bottomBtn  = el('button', { class: 'ax-btn ax-btn-ghost ax-btn-sm', onclick: scrollLogsToBottom }, 'Bottom');

    logsAuto = el('input', { type: 'checkbox' });
    logsAuto.addEventListener('change', () => { logsAuto.checked ? startLogsPoll() : stopLogsPoll(); });
    const autoLbl = el('label', { class: 'ax-row', style: { gap: '4px', fontSize: '12px', color: 'var(--color-text-secondary)' } },
      logsAuto, document.createTextNode('Auto-refresh (5s)'),
    );

    const bar = el('div', { class: 'log-bar' }, logsPicker, logsLines, logsFilter, refreshBtn, bottomBtn, autoLbl);
    logsOutput = el('pre', { class: 'ax-code log-output' });
    logsContainer.append(bar, logsOutput);

    await populateLogsPicker();
    if (logsKnown.length) { logsPicker.value = logsKnown[0].path; refreshLogs(); }
  }

  function unmountLogs() { stopLogsPoll(); logsContainer = null; }

  async function populateLogsPicker() {
    const r = await listDir(paths.logsDir);
    logsKnown = [];
    if (r.ok) {
      const logs = r.items.filter(n => /\.log$/.test(n));
      const ordered = [
        ...logs.filter(n => n === 'access.log'),
        ...logs.filter(n => n === 'error.log'),
        ...logs.filter(n => n !== 'access.log' && n !== 'error.log').sort(),
      ];
      logsKnown = ordered.map(n => ({ path: paths.logsDir + '/' + n, label: n }));
    } else {
      logsKnown = [
        { path: paths.logsDir + '/access.log', label: 'access.log' },
        { path: paths.logsDir + '/error.log',  label: 'error.log'  },
      ];
    }
    logsPicker.innerHTML = '';
    if (!logsKnown.length) { logsPicker.appendChild(el('option', { value: '' }, '(no logs found)')); return; }
    for (const k of logsKnown) logsPicker.appendChild(el('option', { value: k.path }, k.label));
  }

  async function refreshLogs() {
    const path = logsPicker.value;
    if (!path) return;
    const lines = Number(logsLines.value || 500);
    logsOutput.textContent = 'Loading...';
    logsOutput.style.color = '';
    const r = await tailLog(path, lines, logsUseSudo);
    if (!r.ok) {
      if (r.needsSudo) {
        logsOutput.textContent = '';
        logsOutput.style.color = 'var(--color-error)';
        logsOutput.appendChild(document.createTextNode('Permission denied reading ' + path + '\n\n'));
        const btn = el('button', { class: 'ax-btn ax-btn-outline ax-btn-sm' }, 'Read as root');
        btn.addEventListener('click', async () => { logsUseSudo = true; await refreshLogs(); });
        logsOutput.appendChild(btn);
        if (logsAuto.checked) { logsAuto.checked = false; stopLogsPoll(); }
        return;
      }
      logsOutput.textContent = 'Error: ' + (r.error || 'unknown');
      logsOutput.style.color = 'var(--color-error)';
      return;
    }
    logsLastContent = r.content;
    applyLogsFilter();
    scrollLogsToBottom();
  }

  function applyLogsFilter() {
    if (!logsOutput) return;
    const q = (logsFilter.value || '').trim();
    logsOutput.style.color = '';
    if (!q) { logsOutput.textContent = logsLastContent || '(empty)'; return; }
    const lower = q.toLowerCase();
    const filtered = logsLastContent.split('\n').filter(line => line.toLowerCase().includes(lower)).join('\n');
    logsOutput.textContent = filtered || ('(no matches for "' + q + '")');
  }

  function scrollLogsToBottom() { if (logsOutput) logsOutput.scrollTop = logsOutput.scrollHeight; }
  function startLogsPoll() { stopLogsPoll(); logsPoll = setInterval(refreshLogs, 5000); }
  function stopLogsPoll()  { if (logsPoll) { clearInterval(logsPoll); logsPoll = null; } }

  /* =========================================================================
   * SSL TAB
   * ========================================================================= */

  let sslContainer = null;

  function mountSsl(c) { sslContainer = c; }

  async function showSsl() {
    if (!sslContainer) return;
    sslContainer.innerHTML = '';
    const scanBtn     = el('button', { class: 'ax-btn ax-btn-primary ax-btn-sm', onclick: scanCerts }, 'Scan certificates');
    const renewAllBtn = el('button', { class: 'ax-btn ax-btn-outline ax-btn-sm', onclick: renewAllCerts }, 'Renew all');
    const termBtn     = el('button', { class: 'ax-btn ax-btn-ghost ax-btn-sm', onclick: openSslInTerminal }, 'Open in terminal');
    const head = el('div', { class: 'ax-row', style: { justifyContent: 'space-between' } },
      el('div', { class: 'ax-stack', style: { gap: '2px' } },
        el('span', { class: 'ax-label' }, "Let's Encrypt certificates"),
        el('span', { class: 'ax-text-muted', style: { fontSize: '11px' } }, paths.letsencryptDir),
      ),
      el('div', { class: 'ax-row', style: { gap: '6px' } }, termBtn, renewAllBtn, scanBtn),
    );
    const note = el('div', { class: 'muted-block' },
      'Scanning prompts for sudo because ',
      el('span', { class: 'ax-mono' }, paths.letsencryptDir),
      ' is typically root-only. ',
      el('strong', {}, 'Renew'),
      ' runs ',
      el('span', { class: 'ax-mono' }, 'sudo certbot renew'),
      ' through bash; if certbot is not installed on the remote, the action will surface the error.',
    );
    const list = el('div', { class: 'ax-stack', id: 'ssl-list', style: { gap: '6px' } },
      el('div', { class: 'ax-empty' },
        el('div', { class: 'ax-empty-title' }, 'No scan yet'),
        el('div', {}, 'Click Scan certificates to load.'),
      ),
    );
    sslContainer.append(head, note, list);
  }

  async function scanCerts() {
    const list = $('ssl-list');
    list.innerHTML = '';
    list.appendChild(el('div', { class: 'ax-empty' }, el('div', {}, 'Reading...')));
    let result;
    try { result = await discoverLetsEncryptCerts(); }
    catch (e) {
      list.innerHTML = '';
      list.appendChild(emptyError('Scan failed', e.message || String(e)));
      return;
    }
    if (!result.ok) {
      list.innerHTML = '';
      if (isSudoCancel(result._ex)) { list.appendChild(el('div', { class: 'ax-empty' }, el('div', {}, 'Cancelled.'))); return; }
      list.appendChild(emptyError('Scan failed', result.error || ''));
      return;
    }
    const certs = parseCerts(result.raw, result._sep);
    list.innerHTML = '';
    if (!certs.length) {
      list.appendChild(emptyError('No certificates found',
        'No fullchain.pem under ' + paths.letsencryptDir + '/live/. If you use a different SSL location, edit the plugin settings.'));
      return;
    }
    for (const c of certs) list.appendChild(renderCert(c));
  }

  function renderCert(c) {
    const expiry = c.notAfter ? new Date(c.notAfter) : null;
    let pillClass = 'ax-pill', pillText = '-', rowClass = 'list-row';
    if (expiry && !isNaN(expiry.getTime())) {
      const days = Math.floor((expiry.getTime() - Date.now()) / 86400000);
      if (days < 0)        { pillClass = 'ax-pill ax-pill-error';   pillText = 'expired ' + (-days) + 'd ago'; rowClass += ' row-error'; }
      else if (days < 7)   { pillClass = 'ax-pill ax-pill-error';   pillText = days + 'd left';                rowClass += ' row-error'; }
      else if (days < 30)  { pillClass = 'ax-pill ax-pill-warn';    pillText = days + 'd left';                rowClass += ' row-warn'; }
      else                 { pillClass = 'ax-pill ax-pill-success'; pillText = days + 'd left'; }
    }
    const meta = el('div', { class: 'cert-meta' },
      el('span', { class: 'k' }, 'CN'),     el('span', {}, c.cn || '-'),
      c.sans.length ? el('span', { class: 'k' }, 'SAN') : null,
      c.sans.length ? el('span', {}, c.sans.join(', ')) : null,
      el('span', { class: 'k' }, 'Issuer'), el('span', {}, c.issuer || '-'),
      el('span', { class: 'k' }, 'Valid'),
      el('span', {}, (c.notBefore || '-') + ' -> ' + (c.notAfter || '-') + (expiry && !isNaN(expiry) ? ' . ' + relTime(expiry) : '')),
      el('span', { class: 'k' }, 'Path'),   el('span', { class: 'ax-mono', style: { fontSize: '11px' } }, c.path),
    );
    return el('div', { class: rowClass },
      el('div', { class: 'grow' },
        el('div', { class: 'name ax-text' }, c.name),
        meta,
      ),
      el('span', { class: pillClass }, pillText),
      el('button', {
        class: 'ax-btn ax-btn-outline ax-btn-sm',
        onclick: () => renewCert(c.name),
      }, 'Renew'),
    );
  }

  // Run certbot through bash so we don't have to declare it in
  // requirements (which would prevent the plugin from loading on hosts
  // without certbot). bash itself is broad-power and already declared.
  async function runCertbot(args) {
    const cmd = 'certbot ' + args.map(shellQuote).join(' ') + ' 2>&1';
    try {
      const r = await sudo('bash -c ' + shellQuote(cmd));
      return { ok: r.exitCode === 0, output: (r.stdout || '').trim(), exitCode: r.exitCode };
    } catch (e) {
      return { ok: false, _ex: e, error: e.message || String(e) };
    }
  }

  async function renewCert(certName) {
    const ok = await confirmDialog({
      title: 'Renew ' + certName,
      message: 'Run sudo certbot renew --cert-name ' + certName + '? This may take 10-60 seconds with no progress feedback.',
      okText: 'Renew',
      danger: false,
    });
    if (!ok) return;
    notify('Renewing ' + certName + '...');
    const r = await runCertbot(['renew', '--cert-name', certName, '--non-interactive']);
    if (r._ex && isSudoCancel(r._ex)) return;
    await outputDialog({
      title: r.ok ? ('Renewal complete: ' + certName) : ('Renewal failed: ' + certName),
      text: r.output || r.error || '(no output)',
      tone: r.ok ? 'info' : 'error',
    });
    if (r.ok) { notify('Renewed ' + certName, 'success'); setPending(true); }
    scanCerts();
  }

  async function renewAllCerts() {
    const ok = await confirmDialog({
      title: 'Renew all certificates',
      message: 'Run sudo certbot renew? Only certs near expiry will actually renew. May take a while with no progress feedback.',
      okText: 'Renew all',
      danger: false,
    });
    if (!ok) return;
    notify('Running certbot renew...');
    const r = await runCertbot(['renew', '--non-interactive']);
    if (r._ex && isSudoCancel(r._ex)) return;
    await outputDialog({
      title: r.ok ? 'Renewal complete' : 'Renewal failed',
      text: r.output || r.error || '(no output)',
      tone: r.ok ? 'info' : 'error',
    });
    if (r.ok) { notify('Renewal complete', 'success'); setPending(true); }
    scanCerts();
  }

  function emptyError(title, body) {
    return el('div', { class: 'ax-empty' },
      el('div', { class: 'ax-empty-title ax-text-error' }, title),
      body ? el('div', {}, body) : null,
    );
  }

  async function openSslInTerminal() {
    try {
      if (!window.axion || !window.axion.terminal || !window.axion.terminal.openAt) {
        await messageDialog({ title: 'Terminal unavailable', message: 'The terminal launcher capability is not granted to this plugin.', tone: 'error' });
        return;
      }
      await window.axion.terminal.openAt(paths.letsencryptDir);
      notify('Terminal opened', 'info');
    } catch (e) { notify('Could not open terminal: ' + (e.message || e), 'error'); }
  }

  function parseCerts(raw, sep) {
    if (!raw) return [];
    const parts = raw.split(sep + '|').slice(1);
    return parts.map(part => {
      const lines = part.split('\n');
      const headLine = lines.shift() || '';
      const split = headLine.split('|');
      const name = split[0], path = split[1];
      let cn = '', issuer = '', notBefore = '', notAfter = '';
      const sans = [];
      let inSan = false;
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) { inSan = false; continue; }
        if (/^subject\s*=/i.test(line)) {
          cn = extractCN(line.replace(/^subject\s*=\s*/i, '')); inSan = false;
        } else if (/^issuer\s*=/i.test(line)) {
          issuer = extractCN(line.replace(/^issuer\s*=\s*/i, '')) || line.replace(/^issuer\s*=\s*/i, '').trim(); inSan = false;
        } else if (/^notBefore\s*=/i.test(line)) {
          notBefore = line.replace(/^notBefore\s*=\s*/i, '').trim(); inSan = false;
        } else if (/^notAfter\s*=/i.test(line)) {
          notAfter = line.replace(/^notAfter\s*=\s*/i, '').trim(); inSan = false;
        } else if (/Subject Alternative Name/i.test(line)) {
          inSan = true;
        } else if (inSan) {
          for (const tok of line.split(/[,\s]+/)) {
            if (/^DNS:/i.test(tok)) sans.push(tok.replace(/^DNS:/i, ''));
          }
        }
      }
      return { name: name, path: path, cn: cn, issuer: issuer, notBefore: notBefore, notAfter: notAfter, sans: sans };
    });
  }

  function extractCN(s) {
    const m = s.match(/CN\s*=\s*([^,\/]+)/i);
    return m ? m[1].trim() : s.trim();
  }

  /* =========================================================================
   * CONFIG TAB (nginx.conf + conf.d + snippets)
   * ========================================================================= */

  let configContainer = null;
  function mountConfig(c) { configContainer = c; }

  async function showConfig() {
    if (!configContainer) return;
    configContainer.innerHTML = '';
    const refreshBtn = el('button', { class: 'ax-btn ax-btn-ghost ax-btn-sm', onclick: showConfig }, 'Refresh');
    configContainer.append(
      el('div', { class: 'ax-row', style: { justifyContent: 'space-between' } },
        el('span', { class: 'ax-label' }, 'Configuration files'),
        refreshBtn,
      ),
    );
    configContainer.appendChild(configSectionHeader('Main config', paths.nginxConf));
    configContainer.appendChild(renderConfigRow({
      name: paths.nginxConf.split('/').pop(),
      path: paths.nginxConf,
      category: 'main',
      canDelete: false,
    }));
    configContainer.appendChild(configSectionHeader('conf.d snippets', paths.confDir, () => openNewConfig('conf')));
    await renderConfigSection(paths.confDir, 'conf');
    configContainer.appendChild(configSectionHeader('Reusable snippets', paths.snippetsDir, () => openNewConfig('snippet')));
    await renderConfigSection(paths.snippetsDir, 'snippet');
  }

  function configSectionHeader(title, sub, onAdd) {
    const right = onAdd ? el('button', { class: 'ax-btn ax-btn-primary ax-btn-sm', onclick: onAdd }, 'New') : null;
    return el('div', { class: 'ax-row', style: { justifyContent: 'space-between', marginTop: '14px' } },
      el('div', { class: 'ax-stack', style: { gap: '0' } },
        el('span', { class: 'ax-label' }, title),
        el('span', { class: 'ax-text-muted', style: { fontSize: '11px' } }, sub),
      ),
      right,
    );
  }

  async function renderConfigSection(dir, category) {
    const wrap = el('div', { class: 'ax-stack', style: { gap: '6px', marginTop: '6px' } });
    configContainer.appendChild(wrap);
    const r = await listDir(dir);
    if (!r.ok) {
      wrap.appendChild(el('div', { class: 'ax-empty' },
        el('div', { class: 'ax-empty-title' }, 'Not available'),
        el('div', {}, r.error || ('Cannot list ' + dir)),
      ));
      return;
    }
    const files = r.items.filter(n => n.endsWith('.conf')).sort();
    if (!files.length) {
      wrap.appendChild(el('div', { class: 'ax-empty' }, el('div', {}, 'No .conf files in ' + dir + '.')));
      return;
    }
    for (const name of files) {
      wrap.appendChild(renderConfigRow({ name: name, path: dir + '/' + name, category: category, canDelete: true }));
    }
  }

  function renderConfigRow(args) {
    const name = args.name, path = args.path, category = args.category, canDelete = args.canDelete;
    return el('div', { class: 'list-row' },
      el('div', { class: 'grow' },
        el('div', { class: 'name ax-text' }, name),
        el('div', { class: 'sub ax-mono' }, path),
      ),
      el('div', { class: 'actions' },
        el('button', { class: 'ax-btn ax-btn-ghost ax-btn-sm', onclick: () => openEditConfig(path, category, name) }, 'Edit'),
        canDelete ? el('button', { class: 'ax-btn ax-btn-ghost ax-btn-sm', onclick: () => deleteConfig(path, category, name) }, 'Delete') : null,
      ),
    );
  }

  async function openEditConfig(path, category, name) {
    await editorDialog({
      title: 'Edit ' + name,
      name: name,
      nameEditable: false,
      nameLabel: 'Filename',
      loadContent: async () => {
        const r = await readFile(path);
        if (r.ok) return r.content;
        throw new Error(r.error || 'Could not read');
      },
      onSave: async (args) => {
        const content = args.content, original = args.original;
        let tmp;
        try { tmp = await stageTemp(content); }
        catch (e) { return { ok: false, error: 'Stage failed: ' + (e.message || e) }; }
        try {
          const r = await saveAndTest(tmp, path);
          if (!r.ok) {
            const out = (r.stderr || r.stdout || '').trim();
            return { ok: false, error: 'nginx -t failed.' + (r.restored ? ' Original restored.' : '') + '\n' + out };
          }
          if (original) await pushBackup(category, name, original);
          setPending(true);
          notify('Updated ' + name, 'success');
          return { ok: true };
        } catch (e) {
          if (isSudoCancel(e)) return { ok: false, error: 'Cancelled.' };
          return { ok: false, error: e.message || String(e) };
        }
      },
      showHistory: () => openConfigHistory(path, category, name),
    });
    showConfig();
  }

  async function openNewConfig(category) {
    const dir = category === 'conf' ? paths.confDir : paths.snippetsDir;
    await editorDialog({
      title: category === 'conf' ? 'New conf.d file' : 'New snippet',
      name: '',
      nameEditable: true,
      nameLabel: 'Filename (.conf)',
      namePlaceholder: 'rate-limits.conf',
      onSave: async (args) => {
        let fname = (args.name || '').trim();
        if (!fname.endsWith('.conf')) fname += '.conf';
        if (!validFilename(fname)) {
          return { ok: false, error: 'Invalid filename. Use letters, digits, dot, underscore, dash.' };
        }
        const target = dir + '/' + fname;
        let tmp;
        try { tmp = await stageTemp(args.content); }
        catch (e) { return { ok: false, error: 'Stage failed: ' + (e.message || e) }; }
        try {
          const r = await saveAndTest(tmp, target);
          if (!r.ok) {
            const out = (r.stderr || r.stdout || '').trim();
            return { ok: false, error: 'nginx -t failed.' + (r.restored ? '' : ' New file removed.') + '\n' + out };
          }
          setPending(true);
          notify('Created ' + fname, 'success');
          return { ok: true };
        } catch (e) {
          if (isSudoCancel(e)) return { ok: false, error: 'Cancelled.' };
          return { ok: false, error: e.message || String(e) };
        }
      },
    });
    showConfig();
  }

  async function deleteConfig(path, category, name) {
    const ok = await confirmDialog({ title: 'Delete file', message: 'Delete ' + path + '?', okText: 'Delete' });
    if (!ok) return;
    try {
      const cur = await readFile(path);
      if (cur.ok) await pushBackup(category, name, cur.content);
      await sudo('rm -f ' + shellQuote(path));
      notify(name + ' deleted', 'success');
      setPending(true);
      showConfig();
    } catch (e) {
      if (!isSudoCancel(e)) notify('Delete failed: ' + (e.message || e), 'error');
    }
  }

  async function openConfigHistory(path, category, name) {
    const items = await listBackups(category, name);
    await historyDialog({
      title: 'History - ' + name,
      items: items,
      onRestore: async (entry) => {
        let tmp;
        try { tmp = await stageTemp(entry.content); }
        catch (e) { notify('Stage failed: ' + (e.message || e), 'error'); return; }
        try {
          const r = await saveAndTest(tmp, path);
          if (r.ok) { notify('Restored ' + name, 'success'); setPending(true); }
          else { notify('Restore failed nginx -t - original kept.', 'error'); }
        } catch (e) {
          if (!isSudoCancel(e)) notify('Restore failed: ' + (e.message || e), 'error');
        }
      },
    });
  }

  /* =========================================================================
   * STATUS TAB
   * ========================================================================= */

  let statusContainer = null;
  function mountStatus(c) { statusContainer = c; }
  function unmountStatus() { statusContainer = null; }

  async function showStatus() {
    if (!statusContainer) return;
    statusContainer.innerHTML = '';
    const refreshBtn = el('button', { class: 'ax-btn ax-btn-ghost ax-btn-sm', onclick: showStatus }, 'Refresh');
    statusContainer.append(
      el('div', { class: 'ax-row', style: { justifyContent: 'space-between' } },
        el('span', { class: 'ax-label' }, 'Live status'),
        refreshBtn,
      ),
    );
    const metricsHost = el('div', { class: 'ax-stack', style: { gap: '6px', marginTop: '6px' } });
    statusContainer.appendChild(metricsHost);
    await renderStub(metricsHost);
    statusContainer.appendChild(statusSectionLabel('Worker processes', 'ps -C nginx'));
    await renderWorkers();
    statusContainer.appendChild(statusSectionLabel('systemctl status', paths.service));
    await renderSystemctl();
    statusContainer.appendChild(statusSectionLabel('nginx -V', 'Build options'));
    await renderVersion();
  }

  function statusSectionLabel(title, sub) {
    return el('div', { class: 'ax-stack', style: { gap: '0', marginTop: '14px' } },
      el('span', { class: 'ax-label' }, title),
      sub ? el('span', { class: 'ax-text-muted', style: { fontSize: '11px' } }, sub) : null,
    );
  }

  async function renderStub(host) {
    if (!paths.stubStatusUrl) {
      host.appendChild(el('div', { class: 'muted-block' },
        'stub_status URL is not configured. Set it in plugin settings to enable live metrics.',
      ));
      return;
    }
    host.appendChild(el('div', { class: 'ax-text-muted', style: { fontSize: '11px' } }, paths.stubStatusUrl));
    const grid = el('div', { class: 'metric-grid' });
    host.appendChild(grid);
    const r = await fetchStubStatus();
    if (!r.ok) {
      grid.replaceWith(el('div', { class: 'muted-block' },
        r.disabled ? 'stub_status disabled.' :
        ('Could not reach ' + paths.stubStatusUrl + '. Make sure stub_status is enabled in nginx and accessible from localhost. ' + (r.error || '')),
      ));
      return;
    }
    const m = parseStub(r.raw);
    for (const k of Object.keys(m)) {
      grid.appendChild(el('div', { class: 'metric' },
        el('div', { class: 'k' }, k),
        el('div', { class: 'v' }, String(m[k])),
      ));
    }
  }

  function parseStub(text) {
    const m = {};
    const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let mt;
      if ((mt = line.match(/Active connections:\s*(\d+)/))) m.active = mt[1];
      if (/^server accepts/.test(line) && lines[i + 1]) {
        const nums = lines[i + 1].match(/(\d+)\s+(\d+)\s+(\d+)/);
        if (nums) { m.accepted = nums[1]; m.handled = nums[2]; m.requests = nums[3]; }
      }
      if ((mt = line.match(/Reading:\s*(\d+)\s+Writing:\s*(\d+)\s+Waiting:\s*(\d+)/))) {
        m.reading = mt[1]; m.writing = mt[2]; m.waiting = mt[3];
      }
    }
    return m;
  }

  async function renderWorkers() {
    const wrap = el('div', { class: 'ax-stack', style: { gap: '6px', marginTop: '6px' } });
    statusContainer.appendChild(wrap);
    const r = await workerProcesses();
    if (!r.ok || !r.items.length) {
      wrap.appendChild(el('div', { class: 'muted-block' },
        r.ok ? 'No nginx processes running.' : (r.error || 'Could not list processes.'),
      ));
      return;
    }
    for (const p of r.items) {
      wrap.appendChild(el('div', { class: 'list-row' },
        el('div', { class: 'grow' },
          el('div', { class: 'name ax-mono', style: { fontSize: '12px' } }, p.cmd),
          el('div', { class: 'sub' }, 'pid ' + p.pid + ' . ' + p.user + ' . ' + p.etime + ' . ' + fmtBytes(p.rssKb * 1024)),
        ),
      ));
    }
  }

  async function renderSystemctl() {
    const pre = el('pre', { class: 'ax-code', style: {
      marginTop: '6px', fontSize: '11px',
      minHeight: '220px', maxHeight: '320px',
      overflow: 'auto', whiteSpace: 'pre',
    } }, 'Loading...');
    statusContainer.appendChild(pre);
    try { pre.textContent = (await daemonStatusText()).trim() || '(no output)'; }
    catch (e) { pre.textContent = 'Error: ' + (e.message || e); pre.style.color = 'var(--color-error)'; }
  }

  async function renderVersion() {
    const pre = el('pre', { class: 'ax-code', style: {
      marginTop: '6px', fontSize: '11px',
      minHeight: '120px', maxHeight: '240px',
      overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    } }, 'Loading...');
    statusContainer.appendChild(pre);
    try { pre.textContent = (await nginxVersionText()) || '(no output)'; }
    catch (e) { pre.textContent = 'Error: ' + (e.message || e); pre.style.color = 'var(--color-error)'; }
  }

  /* =========================================================================
   * MAIN — tab router, boot
   * ========================================================================= */

  const TABS = [
    { id: 'sites',  label: 'Sites',  show: showSites,  unmount: null },
    { id: 'logs',   label: 'Logs',   show: showLogs,   unmount: unmountLogs },
    { id: 'ssl',    label: 'SSL',    show: showSsl,    unmount: null },
    { id: 'config', label: 'Config', show: showConfig, unmount: null },
    { id: 'status', label: 'Status', show: showStatus, unmount: unmountStatus },
  ];

  let activeTab = null;
  let mounted = false;

  async function go(id) {
    if (activeTab === id) return;
    const prev = TABS.find(t => t.id === activeTab);
    if (prev && prev.unmount) try { prev.unmount(); } catch (_) {}
    activeTab = id;
    for (const btn of document.querySelectorAll('.tab')) btn.classList.toggle('active', btn.dataset.tab === id);
    const tab = TABS.find(t => t.id === id);
    if (!tab) return;
    try { await tab.show(); }
    catch (e) {
      const host = $('tab-content');
      host.innerHTML = '';
      host.appendChild(el('div', { class: 'muted-block ax-text-error' }, 'Tab failed to render: ' + (e.message || e)));
      console.error(e);
    }
  }

  function renderTabs() {
    const nav = $('tabs-nav');
    if (!nav) return;
    nav.innerHTML = '';
    for (const t of TABS) {
      nav.appendChild(el('button', { class: 'tab', 'data-tab': t.id, onclick: () => go(t.id) }, t.label));
    }
  }

  function mountAll() {
    if (mounted) return;
    mounted = true;
    window.__nmgrMounted = true;
    try {
      mountDaemon($('daemon-host'));
      mountSites ($('tab-content'));
      mountLogs  ($('tab-content'));
      mountSsl   ($('tab-content'));
      mountConfig($('tab-content'));
      mountStatus($('tab-content'));
      renderTabs();
      refreshStatus();
      startStatusPoll();
      void go('sites');
    } catch (e) {
      console.error('Plugin init failed', e);
      const body = document.body;
      body.innerHTML = '';
      body.appendChild(el('pre', {
        style: { color: 'var(--color-error)', padding: '20px', whiteSpace: 'pre-wrap' },
      }, 'Plugin init failed:\n' + (e.stack || e.message || e)));
    }
  }

  function applyReadyInfo(info) {
    if (!info) return;
    applySettings(info.settings);
    try { window.axion && window.axion.window && window.axion.window.setTitle && window.axion.window.setTitle('Nginx Manager'); } catch (_) {}
    stopStatusPoll();
    startStatusPoll();
    refreshStatus();
  }

  // 1. If the inline bootstrap captured ready already, apply it.
  try { if (window.__nmgrReady) applyReadyInfo(window.__nmgrReady); } catch (_) {}

  // 2. Subscribe to future ready / session-change events.
  try {
    if (window.axion && typeof window.axion.on === 'function') {
      window.axion.on('ready', applyReadyInfo);
      window.axion.on('session-change', () => refreshStatus());
    }
  } catch (_) {}

  // 3. Mount UI immediately - don't gate on ready.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountAll, { once: true });
  } else {
    mountAll();
  }

  window.addEventListener('beforeunload', stopStatusPoll);
})();
