'use strict';
// pricing.js — 模型定价表(峰谷/节假日) + provider 识别 + 自定义 API 定义(拆分自 pet-chip.js)
const fs = require('fs');
const path = require('path');
const C = require('./config');
const { PCFG } = C;   // readProvider 读 ZCode 的 provider_config.json
// ---------- 多 provider 定价 ----------
// 每个 provider 一份定义:{label 大名(气泡上显示), match 匹配词(在 provider_id+model_id 里找子串),
// balanceUrl 余额接口, balancePath 金额字段路径(可空,空则自动在返回里找), price 计价(¥/百万 tokens),
// models 按模型细分的价格覆盖(如 pro)}。
// price 的数字有两种写法:单个数字=不分峰谷;数组 [谷, 峰]=沿用 DeepSeek 那套峰谷时段规则。
// ⚠ 命中顺序 = 数组顺序(首个命中的定义生效),所以**模型关键词在前、provider_id 关键词在后**,
//   同一个 models[] 里也是**具体写法在前**(如 flashx 必须排在 flash 前)。
// 内置价格表(截至 2026-10-02 从各官网定价页抓取):这是给「➕ 添加 API」自动带出单价用的,
// 表里没有的才需要自己填。各家随时可能调价,数字对不上就在面板里直接改(改完存进 pet-providers.json 覆盖内置)。
const DS_PRICE_FLASH = { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] };
const DS_PRICE_PRO = { hit: [0.15, 0.30], miss: [4.5, 9], out: [13.5, 27] };
const BUILTIN_DEFS = [
  // —— 按模型名认家(最可靠:model_id 里通常带模型名) ——
  { label: 'DeepSeek', match: 'deepseek',
    balanceUrl: 'https://api.deepseek.com/user/balance', balancePath: 'balance_infos.0.total_balance',
    price: DS_PRICE_FLASH, models: [{ match: 'pro', price: DS_PRICE_PRO }] },
  // 智谱 GLM(官网定价页;无公开余额接口)。默认取旗舰 glm-5.3
  { label: 'GLM', match: 'glm', price: { hit: 2, miss: 8, out: 28 }, models: [
    { match: 'flashx', price: { hit: 0.57, miss: 2, out: 7 } },
    { match: 'flash', price: { hit: 0.23, miss: 0.8, out: 2.8 } },
    { match: 'air', price: { hit: 0.16, miss: 0.8, out: 2 } },
    { match: 'turbo', price: { hit: 1.2, miss: 5, out: 22 } },
    { match: '4.7', price: { hit: 0.4, miss: 2, out: 8 } },
    { match: 'plus', price: { hit: 2.5, miss: 5, out: 5 } },
    { match: 'long', price: { hit: 0.5, miss: 1, out: 1 } },
  ] },
  // 阿里通义千问(百炼;缓存命中按标准输入 10% 计,故 hit = miss×0.1)
  { label: 'Qwen', match: 'qwen', price: { hit: 0.25, miss: 2.5, out: 10 }, models: [
    { match: 'coder-plus', price: { hit: 0.4, miss: 4, out: 16 } },
    { match: 'coder-flash', price: { hit: 0.1, miss: 1, out: 4 } },
    { match: 'max', price: { hit: 0.24, miss: 2.4, out: 9.6 } },
    { match: 'plus', price: { hit: 0.08, miss: 0.8, out: 8 } },
    { match: 'turbo', price: { hit: 0.03, miss: 0.3, out: 0.6 } },
  ] },
  // Kimi / Moonshot(官方有公开余额接口)
  { label: 'Kimi', match: 'kimi',
    balanceUrl: 'https://api.moonshot.cn/v1/users/me/balance', balancePath: 'data.available_balance',
    price: { hit: 1.1, miss: 6.5, out: 27 }, models: [
    { match: 'k3', price: { hit: 2, miss: 20, out: 100 } },
    { match: 'highspeed', price: { hit: 2.6, miss: 13, out: 54 } },
    { match: 'code', price: { hit: 1.3, miss: 6.5, out: 27 } },
  ] },
  { label: 'Kimi', match: 'moonshot', price: { hit: 1.1, miss: 6.5, out: 27 } },
  // 字节豆包(火山方舟;余额需 AK/SK 签名,填不了)
  { label: '豆包', match: 'doubao', price: { hit: 1.2, miss: 6, out: 30 }, models: [
    { match: '2.0-mini', price: { hit: 0.04, miss: 0.2, out: 2 } },
    { match: '2.0-lite', price: { hit: 0.12, miss: 0.6, out: 3.6 } },
    { match: '2.0-pro', price: { hit: 0.64, miss: 3.2, out: 16 } },
    { match: '2.0-code', price: { hit: 0.64, miss: 3.2, out: 16 } },
    { match: 'lite', price: { hit: 0.16, miss: 0.8, out: 2.7 } },
    { match: 'turbo', price: { hit: 0.6, miss: 3, out: 15 } },
  ] },
  // 百度文心(千帆;官方未公布缓存命中价,按无优惠即 hit=miss 处理)
  { label: '文心', match: 'ernie', price: { hit: 0.8, miss: 0.8, out: 3.2 }, models: [
    { match: '5.', price: { hit: 4, miss: 4, out: 18 } },
  ] },
  // 腾讯混元
  { label: '混元', match: 'hunyuan', price: { hit: 2.4, miss: 2.4, out: 9.6 }, models: [
    { match: 'a13b', price: { hit: 0.5, miss: 0.5, out: 2 } },
    { match: 'translation', price: { hit: 1.2, miss: 1.2, out: 3.6 } },
    { match: 'vision', price: { hit: 3, miss: 3, out: 9 } },
  ] },
  // MiniMax(现为促销价,原价 M3 = 0.84/4.2/16.8)
  { label: 'MiniMax', match: 'minimax', price: { hit: 0.42, miss: 2.1, out: 8.4 }, models: [
    { match: 'highspeed', price: { hit: 0.42, miss: 4.2, out: 16.8 } },
  ] },
  // 阶跃星辰(官方有公开余额接口)
  { label: '阶跃', match: 'step-',
    balanceUrl: 'https://api.stepfun.com/v1/accounts', balancePath: 'balance',
    price: { hit: 0.14, miss: 0.7, out: 2.1 }, models: [
    { match: '5-preview', price: { hit: 0.35, miss: 7, out: 20 } },
    { match: '3.7', price: { hit: 0.27, miss: 1.35, out: 8.1 } },
    { match: 'vision', price: { hit: 0.5, miss: 2.5, out: 8 } },
  ] },
  // —— 按 provider_id 认家(model_id 里没带模型名时的兜底) ——
  { label: 'GLM', match: 'bigmodel', price: { hit: 2, miss: 8, out: 28 } },
  { label: 'GLM', match: 'zhipu', price: { hit: 2, miss: 8, out: 28 } },
  { label: 'Qwen', match: 'dashscope', price: { hit: 0.25, miss: 2.5, out: 10 } },
  { label: 'Qwen', match: 'alibaba', price: { hit: 0.25, miss: 2.5, out: 10 } },
  { label: '豆包', match: 'volc', price: { hit: 1.2, miss: 6, out: 30 } },
  { label: 'Kimi', match: 'moonshot', price: { hit: 1.1, miss: 6.5, out: 27 } },
  { label: '文心', match: 'qianfan', price: { hit: 0.8, miss: 0.8, out: 3.2 } },
  { label: '阶跃', match: 'stepfun', price: { hit: 0.14, miss: 0.7, out: 2.1 } },
  // —— 国外(美元/百万 tokens,cur:'$') —— 数字取自各家官方定价页,抓取日期 2026-10-02:
  // OpenAI developers.openai.com/api/docs/pricing / Anthropic platform.claude.com/docs/en/about-claude/pricing
  // Google ai.google.dev/gemini-api/docs/pricing / xAI docs.x.ai/developers/pricing / Mistral mistral.ai/pricing
  // Llama 只有第三方托管价(Together AI)。
  // 约定:官方没公布缓存价的那几档(hit 写 = miss),不是"缓存免费"。长上下文加价(OpenAI >272K、
  // Google 部分 >200K、xAI >200K)与 Batch/Flex 折扣一律没建模,按最短上下文的标准价算。
  { label: 'OpenAI', match: 'gpt', cur: '$',
    price: { hit: 0.125, miss: 1.25, out: 10 },
    models: [
      { match: 'gpt-6.1-sol', price: { hit: 0.10, miss: 2, out: 10 } },
      { match: 'gpt-6-astra', price: { hit: 1, miss: 10, out: 50 } },
      { match: 'gpt-6-luna', price: { hit: 0.01, miss: 0.10, out: 0.50 } },
      { match: 'gpt-6-sol', price: { hit: 0.20, miss: 2, out: 10 } },
      { match: 'gpt-5.6-sol', price: { hit: 0.40, miss: 4, out: 20 } },
      { match: 'gpt-5.6-terra', price: { hit: 0.20, miss: 2, out: 12 } },
      { match: 'gpt-5.6-luna', price: { hit: 0.02, miss: 0.20, out: 1.20 } },
      { match: 'gpt-5.5-pro', price: { hit: 30, miss: 30, out: 180 } },
      { match: 'gpt-5.5', price: { hit: 0.50, miss: 5, out: 30 } },
      { match: 'gpt-5.4-pro', price: { hit: 30, miss: 30, out: 180 } },
      { match: 'gpt-5.4-mini', price: { hit: 0.075, miss: 0.75, out: 4.50 } },
      { match: 'gpt-5.4-nano', price: { hit: 0.02, miss: 0.20, out: 1.25 } },
      { match: 'gpt-5.4', price: { hit: 0.25, miss: 2.50, out: 15 } },
      { match: 'gpt-5.2-pro', price: { hit: 21, miss: 21, out: 168 } },
      { match: 'gpt-5.2', price: { hit: 0.175, miss: 1.75, out: 14 } },
      { match: 'gpt-5-pro', price: { hit: 15, miss: 15, out: 120 } },
      { match: 'gpt-5-mini', price: { hit: 0.025, miss: 0.25, out: 2.00 } },
      { match: 'gpt-5-nano', price: { hit: 0.005, miss: 0.05, out: 0.40 } },
      { match: 'gpt-4.1-mini', price: { hit: 0.10, miss: 0.40, out: 1.60 } },
      { match: 'gpt-4.1-nano', price: { hit: 0.025, miss: 0.10, out: 0.40 } },
      { match: 'gpt-4.1', price: { hit: 0.50, miss: 2.00, out: 8.00 } },
      { match: 'gpt-4o-mini', price: { hit: 0.075, miss: 0.15, out: 0.60 } },
      { match: 'gpt-4o', price: { hit: 1.25, miss: 2.50, out: 10.00 } },
    ] },
  { label: 'OpenAI', match: 'openai', cur: '$', price: { hit: 0.125, miss: 1.25, out: 10 } },
  { label: 'Claude', match: 'claude', cur: '$',
    price: { hit: 0.20, miss: 2, out: 10 },
    models: [
      { match: 'fable-5-1', price: { hit: 0.25, miss: 10, out: 50 } },
      { match: 'mythos-5-1', price: { hit: 0.25, miss: 10, out: 50 } },
      { match: 'opus-5-5', price: { hit: 0.20, miss: 4, out: 20 } },
      { match: 'sonnet-5-5', price: { hit: 0.20, miss: 2, out: 10 } },
      { match: 'haiku-4-5', price: { hit: 0.10, miss: 1, out: 5 } },
      { match: 'haiku-3-5', price: { hit: 0.08, miss: 0.80, out: 4 } },
      { match: 'opus-4-1', price: { hit: 1.50, miss: 15, out: 75 } },
      { match: 'fable', price: { hit: 1, miss: 10, out: 50 } },
      { match: 'mythos', price: { hit: 1, miss: 10, out: 50 } },
      { match: 'opus', price: { hit: 0.50, miss: 5, out: 25 } },
      { match: 'sonnet-5', price: { hit: 0.20, miss: 2, out: 10 } },
      { match: 'sonnet', price: { hit: 0.30, miss: 3, out: 15 } },
      { match: 'haiku', price: { hit: 0.10, miss: 1, out: 5 } },
    ] },
  { label: 'Claude', match: 'anthropic', cur: '$', price: { hit: 0.20, miss: 2, out: 10 } },
  { label: 'Gemini', match: 'gemini', cur: '$',
    price: { hit: 0.20, miss: 2, out: 12 },
    models: [
      { match: 'gemini-3.5-flash-lite', price: { hit: 0.03, miss: 0.30, out: 2.50 } },
      { match: 'gemini-3.5', price: { hit: 0.15, miss: 1.50, out: 9.00 } },
      { match: 'gemini-3.1-flash-lite', price: { hit: 0.025, miss: 0.25, out: 1.50 } },
      { match: 'gemini-3.1-pro', price: { hit: 0.20, miss: 2.00, out: 12.00 } },
      { match: 'gemini-3.8', price: { hit: 0.075, miss: 0.75, out: 3.75 } },
      { match: 'gemini-2.5-pro', price: { hit: 0.125, miss: 1.25, out: 10.00 } },
      { match: 'gemini-2.5-flash-lite', price: { hit: 0.10, miss: 0.10, out: 0.40 } },
      { match: 'gemini-2.5-flash', price: { hit: 0.30, miss: 0.30, out: 2.50 } },
      { match: 'gemini-3-flash', price: { hit: 0.50, miss: 0.50, out: 3.00 } },
    ] },
  { label: 'Grok', match: 'grok', cur: '$',
    price: { hit: 0.50, miss: 2, out: 6 },
    models: [
      { match: 'grok-4.6', price: { hit: 0.50, miss: 2, out: 6 } },
      { match: 'grok-4.5', price: { hit: 0.30, miss: 2, out: 6 } },
      { match: 'grok-4.3', price: { hit: 0.20, miss: 1.25, out: 2.50 } },
      { match: 'grok-4.20', price: { hit: 0.20, miss: 1.25, out: 2.50 } },
      { match: 'grok-build', price: { hit: 0.20, miss: 1, out: 2 } },
    ] },
  { label: 'Mistral', match: 'mistral', cur: '$',
    price: { hit: 0.15, miss: 1.50, out: 7.50 },
    models: [
      { match: 'small', price: { hit: 0.015, miss: 0.15, out: 0.60 } },
      { match: 'large', price: { hit: 0.05, miss: 0.50, out: 1.50 } },
      { match: 'codestral', price: { hit: 0.03, miss: 0.30, out: 0.90 } },
      { match: 'ministral', price: { hit: 0.01, miss: 0.10, out: 0.10 } },
    ] },
  // Llama 官方不直接卖,这是第三方托管(Together AI)价,缓存未提供 ⇒ hit = 输入价
  { label: 'Llama', match: 'llama', cur: '$', price: { hit: 1.04, miss: 1.04, out: 1.04 } },
];
// 法定节假日全天按谷价:官方 2026-09-19 计费脚注「周一至周五(不含中国法定节假日)…其余时段,
// 包括周末、调休上班的周末及中国法定节假日全天均为空闲时段」。依据《国务院办公厅关于 2026 年
// 部分节假日安排的通知》(国办发明电〔2025〕7 号,2025-11-04)。只列放假日:2026 年的调休上班日
// (1/4、2/14、2/28、5/9、9/20、10/10)全落在周末,本来就是谷价。
// ⚠ 每年 11 月国务院发布次年安排后,必须在这里补下一年的日期。
const HOLIDAY_VALLEY = new Set([
  '2026-01-01', '2026-01-02', '2026-01-03',                                     // 元旦 1/1-1/3
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',         // 春节 2/15-2/23
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',                                     // 清明 4/4-4/6
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',         // 劳动节 5/1-5/5
  '2026-06-19', '2026-06-20', '2026-06-21',                                     // 端午 6/19-6/21
  '2026-09-25', '2026-09-26', '2026-09-27',                                     // 中秋 9/25-9/27
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',         // 国庆 10/1-10/7
  '2026-10-06', '2026-10-07',
]);
const HOLIDAY_VALLEY_FROM = Date.UTC(2026, 8, 18, 16, 0, 0); // 北京时间 2026-09-19 00:00 起生效
function isPeakBJ(ms) {
  if (!isFinite(ms)) return false;   // 时间戳缺失/非法 → 按谷价(与原行为一致)
  const d = new Date(ms + 8 * 3600e3);
  const h = d.getUTCHours(), wd = d.getUTCDay();
  if (wd === 0 || wd === 6) return false;
  if (ms >= HOLIDAY_VALLEY_FROM && HOLIDAY_VALLEY.has(d.toISOString().slice(0, 10))) return false;
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}
// 价格取档:数字=不分峰谷;数组=[谷,峰]
function pickNum(v, peak) {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  if (Array.isArray(v)) { const x = peak ? (v[1] != null ? v[1] : v[0]) : v[0]; return typeof x === 'number' && isFinite(x) ? x : 0; }
  const n = parseFloat(v);
  return isFinite(n) ? n : 0;
}
// 在 provider_id + model_id 里找 match 子串(不分大小写);没匹配到 → null(未知 provider,不计费)
// 自定义项优先于内置项;两者都命中就合并(自定义填了的字段生效,没填的沿用内置:余额地址/路径/价格/子型号表)
function defFor(providerId, modelId) {
  const hay = ((providerId || '') + ' ' + (modelId || '')).toLowerCase();
  const pick = (arr) => { for (const d of arr) if (d && d.match && hay.indexOf(String(d.match).toLowerCase()) >= 0) return d; return null; };
  const c = pick(customDefs), b = pick(BUILTIN_DEFS);
  if (c && b) return { ...b, ...c, price: c.price || b.price, models: c.models || b.models,
    balanceUrl: c.balanceUrl || b.balanceUrl, balancePath: c.balancePath || b.balancePath };
  return c || b || null;
}
function priceFor(def, modelId) {
  if (!def) return null;
  if (Array.isArray(def.models)) {
    const m = String(modelId || '').toLowerCase();
    for (const o of def.models) if (o && o.match && m.indexOf(String(o.match).toLowerCase()) >= 0 && o.price) return o.price;
  }
  return def.price || null;
}
// 一笔请求的费用(¥)。订阅套餐(provider_id 以 account: 开头,如 account:zai-start-plan)不计费 → 0。
function costOf(u, providerId, modelId, ms) {
  if (/^account:/i.test(providerId || '')) return 0;
  const price = priceFor(defFor(providerId, modelId), modelId);
  if (!price) return 0;
  const peak = isPeakBJ(ms);
  const hit = u.cacheReadTokens || 0, inp = u.inputTokens || 0, out = u.outputTokens || 0;
  return (hit * pickNum(price.hit, peak) + Math.max(0, inp - hit) * pickNum(price.miss, peak) + out * pickNum(price.out, peak)) / 1e6;
}
function curOf(providerId, modelId) { const d = defFor(providerId, modelId); return (d && d.cur) || '¥'; }
function fmtCost(c, cur) { return (cur || '¥') + (c < 1 ? c.toFixed(3) : c.toFixed(2)); }
// ---------- provider / API 检测 ----------
// ZCode 的 provider_config.json 里每个 provider 一条规则,type='api-key' 的能拿到明文 key(自动配上);
// 账号型(provider_id 形如 account:xxx,订阅套餐)不在这个文件里 → 只显示模型名,不查余额、不计费。
// 内置定义猜不到的 provider(余额接口/单价),由右键菜单「➕ 添加 API」写进 pet-providers.json。
const PROVIDER_FILE = path.join(C.DATA_DIR, 'pet-providers.json');
let apiKeys = {};      // providerId -> apiKey(来自 ZCode 配置,自动读)
let customDefs = [];   // pet-providers.json 里的自定义定义
let pcfgAt = 0;
function allDefs() { return BUILTIN_DEFS.concat(customDefs); }
function loadCustomDefs() {
  try {
    const j = JSON.parse(fs.readFileSync(PROVIDER_FILE, 'utf8'));
    const arr = Array.isArray(j) ? j : (Array.isArray(j.providers) ? j.providers : []);
    customDefs = arr.filter((p) => p && p.label && p.match);
  } catch (_) { customDefs = []; }
}
function saveCustomDefs() {
  try { fs.writeFileSync(PROVIDER_FILE, JSON.stringify(customDefs, null, 2)); return true; } catch (_) { return false; }
}
// 给右键菜单看的一份清单(带 key / 余额接口 / 是否用了 ZCode 里配的 key)
function apiList() {
  return customDefs.map((d) => ({ label: d.label, match: d.match, key: d.key ? 1 : 0, url: d.balanceUrl || '', zcode: apiKeys[d.match] ? 1 : 0 }));
}
function readProvider() {
  if (Date.now() - pcfgAt < 60000) return;
  pcfgAt = Date.now();
  const keys = {};
  try {
    const j = JSON.parse(fs.readFileSync(PCFG, 'utf8'));
    const rules = (j.config.providerConfigRules && j.config.providerConfigRules.providerRules) || [];
    for (const r of rules) {
      const a = r.config && r.config.access;
      if (r.providerId && a && a.type === 'api-key' && a.apiKey) keys[r.providerId] = a.apiKey;
    }
  } catch (_) {}
  apiKeys = keys;
}
// 模型大名:用户要求同一家统一写一个名字(DeepSeek / GLM),不写具体小版本
// 顺序:用户自己在「➕ 添加 API」里填的大名 > 内置关键词表 > 内置项 label > 原样 provider_id(去 account:)
function bigName(providerId, modelId) {
  const s = ((providerId || '') + ' ' + (modelId || '')).toLowerCase();
  for (const d of customDefs) if (d && d.match && d.label && s.indexOf(String(d.match).toLowerCase()) >= 0) return d.label;
  const hit = [[/deepseek/, 'DeepSeek'], [/glm|zhipu|zai|bigmodel|chatglm/, 'GLM'], [/claude|anthropic/, 'Claude'],
    [/gpt|openai/, 'OpenAI'], [/gemini/, 'Gemini'], [/qwen|tongyi|dashscope/, 'Qwen'],
    [/kimi|moonshot/, 'Kimi'], [/doubao|volc/, 'Doubao'], [/grok|xai/, 'Grok'], [/llama|meta/, 'Llama']];
  for (const [re, name] of hit) if (re.test(s)) return name;
  const def = defFor(providerId, modelId);
  if (def && def.label) return def.label;
  return String(providerId || '未知').replace(/^account:/i, '') || '未知';
}

// 供其他模块访问的 key/自定义表入口(避免把内部状态直接暴露成可变绑定)
function getApiKey(providerId) { return apiKeys[providerId] || null; }
function apiKeyIds() { return Object.keys(apiKeys); }
// 「➕ 添加 API」面板用:插入或按 匹配/大名 覆盖,返回下标(-1=新增)
function upsertCustomDef(def) {
  const i = customDefs.findIndex((d) => d.match === def.match || d.label === def.label);
  if (i >= 0) customDefs[i] = def; else { customDefs.push(def); return -1; }
  return i;
}
function removeCustomDef(key) {
  const n0 = customDefs.length;
  customDefs = customDefs.filter((d) => d.label !== key && d.match !== key);
  return customDefs.length !== n0;
}
// key 配置可能刚被改过:强制下一拍重读 provider_config.json
function refreshApiKeys() { pcfgAt = 0; readProvider(); }

module.exports = { BUILTIN_DEFS, isPeakBJ, pickNum, defFor, priceFor, costOf, curOf, fmtCost, loadCustomDefs, saveCustomDefs, apiList, readProvider, bigName, getApiKey, apiKeyIds, upsertCustomDef, removeCustomDef, refreshApiKeys };
