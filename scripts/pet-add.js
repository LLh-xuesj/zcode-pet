#!/usr/bin/env node
// pet-add.js — 桌宠「装宠物」工具:从 Petdex 公开清单里按名字装一只宠物到 ZCode 桌宠。
// 清单:https://petdex.dev/api/manifest/v2 (307 跳到 assets.petdex.dev),无需登录。
// 精灵图约定(与 src/page.js 的 FRAMES 一致):8 列 × 192px 宽,每帧 192×208,
//   row0 idle / 1 running-right / 2 running-left / 3 waving / 4 jumping /
//   5 failed / 6 waiting / 7 running / 8 review;v1 是 8×9、v2 是 8×11,行偏移不变。
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const cp = require('child_process');

// 数据目录与守护进程用的是同一套解析:优先插件注入的 PET_CHIP_DATA,默认老位置 ~/.zcode/hooks
const DATA_DIR = process.env.PET_CHIP_DATA || path.join(process.env.USERPROFILE || process.env.HOME, '.zcode', 'hooks');
const PETS_JSON = path.join(DATA_DIR, 'pets.json');
const STATE_FILE = path.join(DATA_DIR, 'pet-state.json');
const MANIFEST_CACHE = path.join(DATA_DIR, '.pet-manifest.json');
const MANIFEST_URL = 'https://petdex.dev/api/manifest/v2';
const MANIFEST_TTL = 24 * 3600 * 1000;
const FW = 192, FH = 208, COLS = 8;
const LOCK_PORT = 9226;
const PLUGINS_REGISTRY = path.join(process.env.USERPROFILE || process.env.HOME, '.zcode', 'cli', 'plugins', 'installed_plugins.json');
const PLUGIN_DATA_DIR = path.join(process.env.USERPROFILE || process.env.HOME, '.zcode', 'cli', 'plugins', 'data', 'zcode-pet');

const DEF_PETS = [
  { slug: 'wangcai', name: '旺财', sprite: 'file:///' + path.join(DATA_DIR, 'pet-wangcai', 'sprite.webp').replace(/\\/g, '/'), rows: 9 },
  { slug: 'boba', name: 'Boba 小水獭', sprite: 'file:///' + path.join(DATA_DIR, 'pet-boba', 'sprite.webp').replace(/\\/g, '/'), rows: 11 },
];

// ---------- 基础 ----------
function get(url, depth) {
  depth = depth || 0;
  return new Promise((resolve, reject) => {
    const rq = https.get(url, { headers: { 'user-agent': 'pet-add/1' } }, (r) => {
      if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location && depth < 5) {
        r.resume();
        return resolve(get(new URL(r.headers.location, url).href, depth + 1));
      }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error('HTTP ' + r.statusCode + ' ' + url)); }
      const c = [];
      r.on('data', (d) => c.push(d));
      r.on('end', () => resolve(Buffer.concat(c)));
    });
    rq.on('error', reject);
    rq.setTimeout(60000, () => rq.destroy(new Error('超时 ' + url)));
  });
}

function dimsOf(b) {
  if (!b || b.length < 32) return null;
  if (b.slice(1, 4).toString('ascii') === 'PNG') {
    if (b.length < 24) return null;
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), fmt: 'png' };
  }
  const fmt = b.toString('ascii', 12, 16);
  try {
    if (fmt.startsWith('VP8L')) { const n = b.readUInt32LE(21); return { w: (n & 0x3fff) + 1, h: ((n >> 14) & 0x3fff) + 1, fmt: 'webp' }; }
    if (fmt.startsWith('VP8X')) return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3), fmt: 'webp' };
    if (fmt.startsWith('VP8 ')) return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff, fmt: 'webp' };
  } catch (_) { }
  return null;
}

function readPets() {
  try {
    const j = JSON.parse(fs.readFileSync(PETS_JSON, 'utf8'));
    if (Array.isArray(j) && j.length) return j;
  } catch (_) { }
  return DEF_PETS.slice();
}
function writePets(list) {
  fs.writeFileSync(PETS_JSON, JSON.stringify(list, null, 2));
}

async function loadManifest(force) {
  if (!force) {
    try {
      const c = JSON.parse(fs.readFileSync(MANIFEST_CACHE, 'utf8'));
      if (c.data && c.data.pets && Date.now() - c.fetchedAt < MANIFEST_TTL) return c.data;
    } catch (_) { }
  }
  process.stdout.write('· 拉取 Petdex 清单… ');
  const m = JSON.parse((await get(MANIFEST_URL)).toString('utf8'));
  fs.writeFileSync(MANIFEST_CACHE, JSON.stringify({ fetchedAt: Date.now(), data: m }));
  console.log('共 ' + m.total + ' 只(快照 ' + m.generatedAt + ')');
  return m;
}

function entriesOf(m) {
  const f = m.fields, at = (k) => f.indexOf(k);
  const iS = at('slug'), iN = at('displayName'), iK = at('kind'), iB = at('submittedBy'), iSp = at('spritesheet'), iV = at('spriteVersionNumber');
  return m.pets.map((r) => ({
    slug: r[iS], name: r[iN], kind: r[iK], by: r[iB], url: m.assetBase + '/' + r[iSp], v: r[iV],
    ext: (r[iSp].match(/\.[a-z0-9]+$/i) || ['.webp'])[0],
  }));
}

function pick(entries, q) {
  const k = String(q).toLowerCase();
  return entries.find((e) => e.slug.toLowerCase() === k) || entries.find((e) => String(e.name).toLowerCase() === k) || null;
}

function fmtRow(h) {
  const r = h / FH;
  return Number.isInteger(r) ? r + ' 行' : '⚠ ' + (h / FH).toFixed(2) + ' 行(不是 208 的整数倍)';
}

// ---------- 命令 ----------
async function cmdSearch(argv) {
  const q = argv.join(' ').trim();
  const ents = entriesOf(await loadManifest(argv.includes('--refresh')));
  let hits;
  if (!q) hits = ents;
  else {
    const k = q.toLowerCase();
    hits = ents.filter((e) => e.slug.toLowerCase().includes(k) || String(e.name).toLowerCase().includes(k));
    hits.sort((a, b) => (String(a.name).toLowerCase() === k ? -1 : 0) - (String(b.name).toLowerCase() === k ? -1 : 0));
  }
  console.log('匹配 ' + hits.length + ' 只' + (q ? '("' + q + '")' : '') + (hits.length > 40 ? ',只显示前 40:' : ':'));
  hits.slice(0, 40).forEach((e) => console.log('  ' + e.slug.padEnd(26) + String(e.name).slice(0, 22).padEnd(24) + String(e.kind || '').padEnd(11) + 'v' + e.v + ' ' + e.ext + (e.by ? '  by ' + e.by : '')));
  if (hits.length && hits.length <= 8) console.log('\n看长相:node pet-add.js preview ' + hits.map((h) => h.slug).join(' '));
  console.log('装一只:node pet-add.js install <slug>');
}

async function cmdInstall(argv) {
  const q = argv.filter((a) => !a.startsWith('--'))[0];
  if (!q) throw new Error('用法:node pet-add.js install <slug 或 名字>');
  const ents = entriesOf(await loadManifest(argv.includes('--refresh')));
  const e = pick(ents, q);
  if (!e) {
    const near = ents.filter((x) => x.slug.toLowerCase().includes(String(q).toLowerCase())).slice(0, 6);
    throw new Error('清单里没找到「' + q + '」' + (near.length ? ',你是指:' + near.map((x) => x.slug).join(' / ') : ''));
  }
  console.log('· ' + e.name + ' (' + e.slug + ', ' + e.kind + ', v' + e.v + ')');
  process.stdout.write('· 下载精灵图… ');
  const buf = await get(e.url);
  const d = dimsOf(buf);
  if (!d) throw new Error('图片格式认不出来(既不是 webp 也不是 png)');
  const rows = d.h / FH;
  console.log((buf.length / 1048576).toFixed(2) + 'MB ' + d.w + '×' + d.h + ' ' + d.fmt);
  if (d.w !== FW * COLS) throw new Error('宽度 ' + d.w + ' 不是 ' + (FW * COLS) + '(8 列 × 192),这只的排版和桌宠不兼容');
  if (!Number.isInteger(rows)) throw new Error('高度 ' + d.h + ' 不是 208 的整数倍,切不出整齐的帧');
  const dir = path.join(DATA_DIR, 'pet-' + e.slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'sprite' + e.ext);
  fs.writeFileSync(file, buf);
  const list = readPets();
  const rec = {
    slug: e.slug,
    name: String(e.name).slice(0, 16),
    sprite: 'file:///' + file.replace(/\\/g, '/'),
    rows: rows,
  };
  const i = list.findIndex((p) => p.slug === e.slug);
  if (i >= 0) { list[i] = rec; console.log('· 已在名单里,已更新'); } else { list.push(rec); }
  writePets(list);
  console.log('✅ 装好:' + rec.name + ' → pet-' + e.slug + '/sprite' + e.ext + '(' + rows + ' 行,共 ' + list.length + ' 只)');
  if (!argv.includes('--no-restart')) restartDaemon();
}

async function cmdList() {
  const list = readPets();
  let active = '?';
  try { active = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).active || '?'; } catch (_) { }
  console.log('装了 ' + list.length + ' 只(当前激活:' + active + '):');
  list.forEach((p, i) => {
    let ok = '✓ 就绪';
    try {
      const d = dimsOf(fs.readFileSync(decodeURI(p.sprite.replace(/^file:\/\/\//, ''))));
      if (!d) ok = '⚠ 图片认不出来';
      else if (d.h / FH !== p.rows) ok = '⚠ 行数对不上(图 ' + (d.h / FH) + ' 行,登记 ' + p.rows + ')';
    } catch (_) { ok = '⚠ 文件找不到'; }
    console.log('  ' + (i + 1) + '. ' + p.slug.padEnd(24) + String(p.name).padEnd(18) + p.rows + ' 行  ' + ok);
  });
  console.log('\n装新的:node pet-add.js search <关键词>  →  install <slug>');
  console.log('右键宠物 → 切换宠物 可轮换;删一只:node pet-add.js remove <slug> --purge');
}

async function cmdRemove(argv) {
  const q = argv.filter((a) => !a.startsWith('--'))[0];
  if (!q) throw new Error('用法:node pet-add.js remove <slug> [--purge]');
  const list = readPets();
  const i = list.findIndex((p) => p.slug === q);
  if (i < 0) throw new Error('名单里没有 ' + q);
  const [gone] = list.splice(i, 1);
  if (!list.length) throw new Error('不能删到一只不剩');
  writePets(list);
  console.log('· 已从名单移除 ' + gone.slug);
  if (argv.includes('--purge')) {
    fs.rmSync(path.join(DATA_DIR, 'pet-' + gone.slug), { recursive: true, force: true });
    console.log('· 已删掉它的素材文件夹');
  }
  restartDaemon();
}

async function cmdPreview(argv) {
  const qs = argv.filter((a) => !a.startsWith('--'));
  if (!qs.length) throw new Error('用法:node pet-add.js preview <slug...>(最多 8 只,给的是 idle 首帧缩略图)');
  const ents = entriesOf(await loadManifest(false));
  const picks = qs.slice(0, 8).map((q) => { const e = pick(ents, q); if (!e) throw new Error('没找到 ' + q); return e; });
  const tmp = path.join(DATA_DIR, '.pet-preview');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const frames = [];
  for (let i = 0; i < picks.length; i++) {
    const e = picks[i];
    process.stdout.write('· 取 ' + e.slug + ' 的首帧… ');
    const buf = await get(e.url);
    const src = path.join(tmp, 's' + i + e.ext);
    fs.writeFileSync(src, buf);
    const out = path.join(tmp, 'f' + i + '.png');
    cp.execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-vf', 'crop=' + FW + ':' + FH + ':0:0,scale=128:139:flags=neighbor', '-frames:v', '1', out]);
    frames.push(out);
    console.log('ok');
  }
  const args = [];
  frames.forEach((f) => args.push('-i', f));
  const y = path.join(process.cwd(), 'pet-preview.png');
  args.push('-filter_complex', frames.map((_, i) => '[' + i + ':v]').join('') + 'hstack=inputs=' + frames.length, '-frames:v', '1', '-update', '1', '-y', y);
  cp.execFileSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'inherit'] });
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n预览图(从左到右 idle 首帧):' + y);
  picks.forEach((e, i) => console.log('  ' + (i + 1) + '. ' + e.slug + ' — ' + e.name));
  console.log('\n挑好了:node pet-add.js install <slug>');
}

// 找到守护进程脚本:优先已安装的 zcode-pet 插件,其次环境变量,最后老版单文件
function findDaemon() {
  try {
    const reg = JSON.parse(fs.readFileSync(PLUGINS_REGISTRY, 'utf8'));
    const list = Array.isArray(reg) ? reg : (reg.plugins || []);
    const entry = list.find((p) => p && String(p.id || '').startsWith('zcode-pet@')) ||
      list.find((p) => p && p.name === 'zcode-pet');
    if (entry && entry.installPath) {
      const d = path.join(entry.installPath, 'src', 'daemon.js');
      if (fs.existsSync(d)) return { script: d, dataDir: PLUGIN_DATA_DIR, via: '插件(' + entry.version + ')' };
    }
  } catch (_) { }
  if (process.env.PET_CHIP_DAEMON && fs.existsSync(process.env.PET_CHIP_DAEMON)) {
    return { script: process.env.PET_CHIP_DAEMON, dataDir: DATA_DIR, via: 'PET_CHIP_DAEMON' };
  }
  const legacy = path.join(process.env.USERPROFILE || process.env.HOME, '.zcode', 'hooks', 'pet-chip.js');
  if (fs.existsSync(legacy)) return { script: legacy, dataDir: path.dirname(legacy), via: '老版单文件' };
  return null;
}

function restartDaemon() {
  try {
    let pid = null;
    const out = cp.execSync('netstat -ano', { encoding: 'utf8' });
    out.split(/\r?\n/).forEach((l) => {
      const m = l.match(new RegExp(':' + LOCK_PORT + '\\s+\\S+\\s+LISTENING\\s+(\\d+)'));
      if (m && !pid) pid = m[1];
    });
    if (pid) { cp.execSync('taskkill /PID ' + pid + ' /F', { stdio: 'ignore' }); console.log('· 已停旧守护进程 PID ' + pid); }
    const d = findDaemon();
    if (d) {
      cp.spawn(process.execPath, [d.script], { detached: true, stdio: 'ignore', windowsHide: true, env: Object.assign({}, process.env, { PET_CHIP_DATA: d.dataDir }) }).unref();
      console.log('· 已重新拉起守护进程(' + d.via + '),1~2 秒后在窗口里右键宠物即可切换');
      return;
    }
    console.log('⚠ 没找到守护进程脚本(插件未安装且老版 pet-chip.js 不存在),请手动启动');
  } catch (e) {
    console.log('⚠ 自动重启失败(' + e.message + '),重启一次 ZCode 即可(插件的 MCP 入口会自动拉起守护)');
  }
}

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'search') return await cmdSearch(rest);
    if (cmd === 'install') return await cmdInstall(rest);
    if (cmd === 'list' || !cmd) return await cmdList();
    if (cmd === 'remove') return await cmdRemove(rest);
    if (cmd === 'preview') return await cmdPreview(rest);
    if (cmd === 'restart') return restartDaemon();
    console.log('pet-add.js — 给 ZCode 桌宠装宠物(Petdex 清单,共 4872 只)\n' +
      '  node pet-add.js list                       看装了哪几只\n' +
      '  node pet-add.js search 柴犬                 按名字/关键词找(中英文都行,空着=全列出前 40)\n' +
      '  node pet-add.js preview <slug...>           生成缩略图先看长相\n' +
      '  node pet-add.js install <slug>              装(下载→切帧校验→登记→重启守护)\n' +
      '  node pet-add.js remove <slug> [--purge]     移除(--purge 连素材一起删)\n' +
      '  node pet-add.js restart                     只重启守护进程\n' +
      '  加 --refresh 可强制刷新清单(默认缓存 24 小时)');
  } catch (e) {
    console.error('✗ ' + (e && e.message ? e.message : e));
    process.exit(1);
  }
})();
