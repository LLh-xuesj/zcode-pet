'use strict';
// config.js — 路径与常量(拆分自 pet-chip.js)
const fs = require('fs');
const path = require('path');
function __dirnameFallback() { return path.dirname(__filename); }
// 数据目录:插件模式由环境变量指定;默认仍是老位置(~/.zcode/hooks),老用户零迁移成本
const DATA_DIR = process.env.PET_CHIP_DATA || path.join(process.env.USERPROFILE || process.env.HOME, '.zcode', 'hooks');
// 一次性迁移:第一次以插件数据目录运行时,把老位置的存档/名单/自定义 API/精灵素材复制过来。
// 只复制不删除(老位置原样保留,回滚零成本);已存在的不覆盖。
const LEGACY_DIR = path.join(process.env.USERPROFILE || process.env.HOME, '.zcode', 'hooks');
if (path.resolve(DATA_DIR) !== path.resolve(LEGACY_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    for (const f of ['pet-state.json', 'pets.json', 'pet-providers.json']) {
      const dst = path.join(DATA_DIR, f);
      if (!fs.existsSync(dst) && fs.existsSync(path.join(LEGACY_DIR, f))) {
        let txt = fs.readFileSync(path.join(LEGACY_DIR, f), 'utf8');
        if (f === 'pets.json') {
          // 名单里的精灵 URL 指着老目录:重写成新数据目录(素材目录也一并搬)
          const legacyUrl = 'file:///' + LEGACY_DIR.replace(/\\/g, '/');
          const newUrl = 'file:///' + DATA_DIR.replace(/\\/g, '/');
          txt = txt.split(legacyUrl).join(newUrl);
        }
        fs.writeFileSync(dst, txt);
      }
    }
    for (const d of fs.readdirSync(LEGACY_DIR)) {
      if (!/^pet-[^/\\]+$/.test(d)) continue;                    // pet-wangcai / pet-boba / … 素材目录
      if (!fs.statSync(path.join(LEGACY_DIR, d)).isDirectory()) continue;   // pet-add.js 这类文件跳过
      const dst = path.join(DATA_DIR, d);
      if (!fs.existsSync(dst)) fs.cpSync(path.join(LEGACY_DIR, d), dst, { recursive: true });
    }
  } catch (_) { }   // 迁移失败不致命:读不到名单会退回内置两只,存档读不到会重新养成
}
const CDP_PORT = 9222;
const ROLLOUT = path.join(process.env.USERPROFILE || process.env.HOME, '.zcode', 'cli', 'rollout');
const DB_PATH = path.join(process.env.USERPROFILE || process.env.HOME, '.zcode', 'cli', 'db', 'db.sqlite');
const ZLOG_DIR = path.join(process.env.USERPROFILE || process.env.HOME, '.zcode', 'cli', 'log');
const PCFG = path.join(process.env.USERPROFILE || process.env.HOME, '.zcode', 'v2', 'provider_config.json');
// 宠物名单:优先读同目录 pets.json(用 pet-add.js 装宠物会写这个文件,改完重启守护生效),
// 读不到/格式不对时退回下面内置的两只。
const PETS = (function () {
  const DEF = [
    { slug: 'wangcai', name: '旺财', sprite: 'file:///C:/Users/14534/.zcode/hooks/pet-wangcai/sprite.webp', rows: 9 },
    { slug: 'boba', name: 'Boba 小水獭', sprite: 'file:///C:/Users/14534/.zcode/hooks/pet-boba/sprite.webp', rows: 11 },
  ];
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'pets.json'), 'utf8'));
    if (Array.isArray(j) && j.length && j.every((p) => p && p.slug && p.sprite && p.rows > 0)) {
      return j.map((p) => ({ slug: p.slug, name: p.name || p.slug, sprite: p.sprite, rows: p.rows }));
    }
  } catch (_) { }
  return DEF;
})();
const LOCK_PORT = 9226;
const POLL_MS = 1000;
const SCALE = 0.55;
const BAL_INTERVAL = 180000;   // 余额自动刷新:3 分钟
const LOW_BALANCE = 10;        // 低余额预警线(元)
const SAT_DECAY_MS = 180000;   // 饱食度消耗:1 点 / 3 分钟(2026-10-02 按用户要求从 1 点/分钟调慢 3 倍)
function dateStr(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
module.exports = { DATA_DIR, CDP_PORT, ROLLOUT, DB_PATH, ZLOG_DIR, PCFG, PETS, LOCK_PORT, POLL_MS, SCALE, BAL_INTERVAL, LOW_BALANCE, SAT_DECAY_MS, dateStr };
