'use strict';
// pet-state.js — 养成系统:饱食度/成长值/等级/成就/存档(拆分自 pet-chip.js)
const fs = require('fs');
const path = require('path');
const C = require('./config');
// ---------- 养成系统:饱食度 + 成长值/等级 ----------
// 饱食度 0-100:随时间消耗(1 点/3 分钟),每完成一轮对话按 token 量投喂;手动喂=零食(+15,20s 冷却)。
// 成长值 = 累计吃掉的 token(永不减少),跨会话累计(查全部 model_usage,不只当前会话)。
const STATE_FILE = path.join(C.DATA_DIR, 'pet-state.json');
const FEED_COOLDOWN = 20000;   // 手动喂食冷却
const MANUAL_FEED = 15;        // 零食饱食度
const LEVELS = [0, 1e6, 5e6, 15e6, 4e7, 8e7, 1.5e8, 3e8, 6e8, 1e9, 2e9, 4e9, 8e9, 1.5e10, 3e10];
const TITLES = ['初来乍到', '小吃货', '干饭新星', '大胃王', '暴食达人', '小食神', '传说食客', '饕餮转世', '吞噬星球', '宇宙干饭王', '银河食神', '星辰饕客', '时空吞噬者', '维度暴食', '万界食堂之主'];
// 成就(实时从存档+库统计推导;test(s=宠物存档, x=库统计 {bash,tools}))
const ACH_DEFS = [
  { id: 'fed1m', name: '百万食客', desc: '累计吃掉 1M tokens', test: (s) => s.fed >= 1e6 },
  { id: 'fed10m', name: '千万胃王', desc: '累计吃掉 10M tokens', test: (s) => s.fed >= 1e7 },
  { id: 'fed100m', name: '亿口干粮', desc: '累计吃掉 100M tokens', test: (s) => s.fed >= 1e8 },
  { id: 'fed1g', name: '十亿传说', desc: '累计吃掉 1000M tokens', test: (s) => s.fed >= 1e9 },
  { id: 'lv8', name: '饕餮转世', desc: '达到 Lv.8', test: (s) => s.lv >= 8 },
  { id: 'lv12', name: '银河食神', desc: '达到 Lv.12', test: (s) => s.lv >= 12 },
  { id: 'lvmax', name: '万界食堂之主', desc: '升到满级 Lv.15', test: (s) => s.lv >= 15 },
  { id: 'streak7', name: '一周之约', desc: '连续签到 7 天', test: (s) => (s.streak || 0) >= 7 },
  { id: 'streak30', name: '持之以恒', desc: '连续签到 30 天', test: (s) => (s.streak || 0) >= 30 },
  { id: 'night', name: '夜猫子', desc: '凌晨还在陪老板干活', test: (s) => !!(s.ach && s.ach.night) },
  { id: 'night3', name: '彻夜长明', desc: '熬过 3 个通宵', test: (s) => (s.nightCount || 0) >= 3 },
  { id: 'turns100', name: '百轮老友', desc: '一起完成 100 轮对话', test: (s) => (s.turns || 0) >= 100 },
  { id: 'turns500', name: '五百轮战友', desc: '一起完成 500 轮对话', test: (s) => (s.turns || 0) >= 500 },
  { id: 'turns1000', name: '千轮传说', desc: '一起完成 1000 轮对话', test: (s) => (s.turns || 0) >= 1000 },
  { id: 'egg1', name: '晕头转向', desc: '把宠物戳晕过一次', test: (s) => (s.eggs || 0) >= 1 },
  { id: 'egg10', name: '戳宠惯犯', desc: '把宠物戳晕 10 次', test: (s) => (s.eggs || 0) >= 10 },
  { id: 'bash200', name: '键盘上的舞者', desc: '陪你跑了 200 次命令', test: (s, x) => x.bash >= 200 },
  { id: 'tools1000', name: '万能工具人', desc: '见证 1000 次工具调用', test: (s, x) => x.tools >= 1000 },
];
// 一轮对话吃多少:每 FEED_TOK_PER_POINT 个 token 涨 1 点饱食度,最少 FEED_GAIN_MIN、单轮最多 FEED_GAIN_MAX。
// 调参就看这两个常量。2026-10-02 先按"涨太快"从 2 万/点·上限 60 调回 15 万/点·上限 30
// (当时是投喂记账有 bug、一轮只吃到第一口才显得慢;修好后就不需要那么猛的换算)。
const FEED_TOK_PER_POINT = 150000;
const FEED_GAIN_MIN = 1, FEED_GAIN_MAX = 30;
function gainFromTokens(t) { return Math.min(FEED_GAIN_MAX, Math.max(FEED_GAIN_MIN, Math.round(t / FEED_TOK_PER_POINT))); }
function levelOf(fed) { let lv = 1; for (let i = 0; i < LEVELS.length; i++) if (fed >= LEVELS[i]) lv = i + 1; return lv; }
function titleOf(fed) { return TITLES[levelOf(fed) - 1] || TITLES[TITLES.length - 1]; }
let petState = { pets: {} };
function loadPetState() {
  try { const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); if (j && j.pets) petState = j; } catch (_) {}
}
function petSlot(slug) {
  if (!petState.pets[slug]) petState.pets[slug] = {};
  const s = petState.pets[slug];
  if (typeof s.sat !== 'number') s.sat = 80;
  if (typeof s.fed !== 'number') s.fed = 0;
  if (typeof s.lv !== 'number') s.lv = levelOf(s.fed);
  if (typeof s.lastDecayAt !== 'number') s.lastDecayAt = Date.now();
  if (typeof s.lastFeedAt !== 'number') s.lastFeedAt = 0;
  return s;
}
// 原子写:先写临时文件再改名,避免守护写入瞬间被读到大半截 JSON(rename 失败则退回直写)
function savePetState() {
  try {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(petState));
    fs.renameSync(tmp, STATE_FILE);
  } catch (_) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(petState)); } catch (_) {} }
}
loadPetState();
module.exports = { LEVELS, TITLES, ACH_DEFS, FEED_COOLDOWN, MANUAL_FEED, gainFromTokens, levelOf, titleOf, petSlot, savePetState, petStateRef: () => petState };
