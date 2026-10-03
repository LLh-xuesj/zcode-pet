'use strict';
// balance.js — 余额/订阅额度:厂商描述表 BAL_INFO + 账号订阅日志兜底 readPlanQuota(拆分自 pet-chip.js)
const fs = require('fs');
const path = require('path');
const P = require('./pricing');
const { defFor, priceFor, bigName } = P;   // resolveApi 用
// 当前会话实际在用的 provider(model_usage 里最新一行的 provider_id/model_id)
let curApi = { label: '', model: '', providerId: '', modelId: '', sub: false, billed: false, def: null, key: null, balanceUrl: null };
function resolveApi(providerId, modelId) {
  const sub = /^account:/i.test(providerId || '');
  const def = defFor(providerId, modelId);
  const key = (def && def.key) || P.getApiKey(providerId) || null;
  const price = priceFor(def, modelId);
  // 峰值/谷值只在价格表写成数组 [谷,峰] 时才谈得上(内置 DeepSeek);单一价的自定义 provider 不标峰谷
  // 分时段(峰/谷)计价:只有价格表写成 [谷,峰] 数组的家才算 —— 目前内置表里**只有 DeepSeek** 是这种,
  // 别家(GLM/Qwen/Kimi/豆包/Claude/GPT…)都是单一价,气泡上不会出现"·峰/·谷"(用户 2026-10-03 专门确认过)
  const peakBased = !!price && (Array.isArray(price.hit) || Array.isArray(price.miss) || Array.isArray(price.out));
  if (bal && bal.providerId !== (providerId || '')) bal = null;   // 换 provider 了,上一家的余额作废
  curApi = {
    label: bigName(providerId, modelId), model: modelId || '', providerId: providerId || '', modelId: modelId || '',
    sub, def, key, peakBased,
    billed: !sub && !!price,
    balanceUrl: (def && def.balanceUrl) || null,
  };
  return curApi;
}

// ---------- 余额 / 订阅额度 ----------
// 这一块的整体思路抄自 DSH 的小鲸鱼挂件(dsh-whale-widget):把"查余额"做成一张**厂商描述表**,
// 而不是写死某一家。每条的字段:
//   url / path       余额接口 + 金额在 JSON 里的路径(路径留空=自动在返回里扫带 balance/amount 的字段)
//   usedUrl/usedPath 第二个接口取"已用" ⇒ 余额 = 总额 - 已用(OneAPI / New API 那类中转站两接口);
//                    省略 usedUrl 表示"同一个响应里的另一个字段"(如 OpenRouter 的 total_credits - total_usage)
//   scale            乘数(Novita 的余额是万分之一单位;中转站的 usage 是美分 → 0.01)
//   auth             鉴权头模板,默认 'Bearer {key}';智谱的额度接口要裸 key,写 '{key}'
//   quota            订阅额度接口(**不是钱**,是"窗口已用%"):{url, auth, kind}
//   noBal / probeUrl 这家没有余额接口(要 AK/SK 签名或已下线):只能拿 probeUrl 探活,看 key 通不通
//   cur              'USD' 的按美元显示,其余按 ¥
// 命中顺序 = 数组顺序(首个命中生效)。用户自己加的 API 在面板里填了余额地址就优先用他的那套。
// 各家接口与字段(2026-10-02 核实,部分实测):
//   DeepSeek  官方 /user/balance,balance_infos[0].total_balance(另有赠金/充值两个字段)
//   Kimi CN   /v1/users/me/balance,data.available_balance;国际站 api.moonshot.ai 同结构(独立账号)
//   阶跃      /v1/accounts,balance
//   OpenRouter /api/v1/credits,data.total_credits - data.total_usage
//   Novita    /v3/user/balance,availableBalance,scale 0.0001
//   智谱      **充值余额没有公开接口**;订阅额度接口 /api/monitor/usage/quota/limit(裸 key),
//             data.limits[] 里按 type + unit 挑(unit 3 = 5 小时窗口、6 = 周窗口)。国际站 api.z.ai 同款
//   Kimi Coding /coding/v1/usages,usage.remaining/limit/resetTime
//   MiniMax Coding /v1/api/openplatform/coding_plan/remains,model_remains[0].current_interval_remaining_percent
//   OpenCode Go   /zen/go/v1/usage,usage.rolling.percent + resetsAt
//   火山/阿里/腾讯/百度/OpenAI 这类要云账号 AK/SK 签名或没有公开接口 ⇒ 只探活 + 提示,显示"没有余额接口"
const BAL_INFO = [
  { match: 'deepseek', url: 'https://api.deepseek.com/user/balance', path: 'balance_infos[0].total_balance' },
  { match: 'kimi', url: 'https://api.moonshot.cn/v1/users/me/balance', path: 'data.available_balance',
    quota: { url: 'https://api.kimi.com/coding/v1/usages', kind: 'kimi' } },
  { match: 'moonshot', url: 'https://api.moonshot.cn/v1/users/me/balance', path: 'data.available_balance',
    quota: { url: 'https://api.kimi.com/coding/v1/usages', kind: 'kimi' } },
  { match: 'step-', url: 'https://api.stepfun.com/v1/accounts', path: 'balance' },
  { match: 'stepfun', url: 'https://api.stepfun.com/v1/accounts', path: 'balance' },
  { match: 'glm', noBal: true, probeUrl: 'https://open.bigmodel.cn/api/paas/v4/models',
    quota: { url: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit', auth: '{key}', kind: 'zhipu' } },
  { match: 'bigmodel', noBal: true, probeUrl: 'https://open.bigmodel.cn/api/paas/v4/models',
    quota: { url: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit', auth: '{key}', kind: 'zhipu' } },
  { match: 'zhipu', noBal: true, probeUrl: 'https://open.bigmodel.cn/api/paas/v4/models',
    quota: { url: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit', auth: '{key}', kind: 'zhipu' } },
  { match: 'minimax', quota: { url: 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains', kind: 'minimax' } },
  { match: 'opencode', quota: { url: 'https://opencode.ai/zen/go/v1/usage', kind: 'opencode' } },
  { match: 'openrouter', url: 'https://openrouter.ai/api/v1/credits', path: 'data.total_credits',
    usedPath: 'data.total_usage', cur: 'USD' },
  { match: 'novita', url: 'https://api.novita.ai/v3/user/balance', path: 'availableBalance',
    scale: 0.0001, cur: 'USD' },
  { match: 'volc', noBal: true, probeUrl: 'https://ark.cn-beijing.volces.com/api/v3/models' },
  { match: 'doubao', noBal: true, probeUrl: 'https://ark.cn-beijing.volces.com/api/v3/models' },
  { match: 'dashscope', noBal: true, probeUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/models' },
  { match: 'alibaba', noBal: true, probeUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/models' },
  { match: 'siliconflow', noBal: true, probeUrl: 'https://api.siliconflow.cn/v1/models' },
  { match: 'gpt', noBal: true, probeUrl: 'https://api.openai.com/v1/models' },
  { match: 'openai', noBal: true, probeUrl: 'https://api.openai.com/v1/models' },
];
const NO_PLAN_RE = /coding plan|不存在|未开通|未订阅|not subscribed|no plan|no active|subscription/i;
const noPlanProviders = new Set();   // 探到"这个 key 没订编码套餐",以后就不再问额度接口
// 挑这家的余额/额度描述:面板里手填过余额地址就用他填的,否则套内置表
function balInfoFor(providerId, modelId, def) {
  const hay = (String(providerId || '') + ' ' + String(modelId || '')).toLowerCase();
  const cu = {
    url: (def && def.balanceUrl) || '', path: (def && def.balancePath) || '',
    usedUrl: (def && def.balanceUsedUrl) || '', scale: (def && def.balanceScale) || 0, cur: (def && def.cur) || '',
  };
  // 手填了就按手填的来(不再叠加内置的额度接口,免得两套口径混在一起)
  if (cu.url || cu.usedUrl) return { url: cu.url, path: cu.path, usedUrl: cu.usedUrl, scale: cu.scale, cur: cu.cur, auth: (def && def.balanceAuth) || null, quota: null, noBal: false, probeUrl: '' };
  for (const b of BAL_INFO) if (b.match && hay.indexOf(b.match) >= 0) return b;
  return null;
}
let bal = null; // {kind:'money'|'quota'|'none', providerId, label, amt|used, cur, win, resetAt, probe, ts}
let balBusy = false;
let balTryAt = 0;    // 上次尝试取余额的时刻(见 tickOnce 的补试)
let balFails = 0;    // 连续查空几次:启动时 provider 可能还没认出来,补试几次再退回 3 分钟一次
function atPath(o, p) {
  const parts = String(p || '').replace(/\[(\d+)\]/g, '.$1').split('.').filter((x) => x !== '');
  let c = o;
  for (const k of parts) { if (c == null) return null; c = c[k]; }
  return c;
}
function numOf(v) { const n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) ? n : null; }
// 返回里扫带 balance/amount 的字段(路径没配、或配的路径对不上时的兜底)
// 用 numOf 而不是 typeof number:DeepSeek 这类接口把金额写成字符串 "16.69"
function scanAmount(j) {
  let hit = null;
  (function walk(o, d) {
    if (!o || typeof o !== 'object' || Array.isArray(o) && !o.length || d > 4 || hit) return;
    if (Array.isArray(o)) { for (const x of o) walk(x, d + 1); return; }
    const ks = Object.keys(o);
    for (const k of ks) { const n = numOf(o[k]); if (n != null && /balance|amount|credit|remain|quota|avail|left/i.test(k)) { hit = n; return; } }
    for (const k of ks) walk(o[k], d + 1);
  })(j, 0);
  return hit;
}
// 鉴权头模板:'Bearer {key}' / '{key}'(智谱额度那种裸 key)/ 'none'(不要鉴权头)。
// 注意:空字符串/null 一律按默认 Bearer 处理 —— 曾经把"用户手填了地址但没填模板"默认成 '' 导致不带
// Authorization 头,DeepSeek 回 401 "Authentication Fails (governor)",排查了半天(2026-10-02)。
function authOf(authTpl, key) {
  if (authTpl == null || authTpl === '') return { Authorization: 'Bearer ' + key };
  const t = String(authTpl);
  if (t === 'none') return {};
  return { Authorization: t.replace('{key}', key) };
}
// HTTP 200 也可能是业务错误(智谱那种),所以成功也要看一眼 body
function bizErrOf(j) {
  if (!j || typeof j !== 'object') return '';
  if (j.success === false) return String(j.msg || j.message || '业务错误');
  const br = j.base_resp;   // MiniMax 那一套:base_resp.status_code ≠ 0 才是错(实测没带 key 时它回 HTTP 200)
  if (br && numOf(br.status_code) != null && numOf(br.status_code) !== 0) return String(br.status_msg || ('base_resp ' + br.status_code));
  const c = j.code;
  if (c != null && typeof c !== 'object' && !/^(0|200)$/.test(String(c))) return String(j.msg || j.message || ('code ' + c));
  return '';
}
async function reqJson(url, authTpl, key, ms) {
  const r = await fetch(url, { headers: authOf(authTpl, key), signal: AbortSignal.timeout(ms || 8000) });
  let txt = ''; try { txt = await r.text(); } catch (_) {}
  if (!r.ok) return { status: r.status, err: 'HTTP' + r.status, msg: txt.slice(0, 200) };
  let j = null; try { j = JSON.parse(txt); } catch (_) { return { status: r.status, err: 'PARSE' }; }
  const biz = bizErrOf(j);
  if (biz) return { status: r.status, err: 'BIZ', msg: biz };
  return { status: r.status, j };
}
// 把各家的额度返回归一到 {used(已用%), win(窗口名), resetAt(时间戳), level}
// ⚠ 智谱的 percentage 按"已用%"理解(它没有文档写清);哪天发现显示反了,就是把这里改成 100 - used
function parseQuota(j, kind) {
  if (kind === 'zhipu') {
    const d = j && j.data; if (!d) return null;
    const arr = Array.isArray(d.limits) ? d.limits : [];
    const ofUnit = (u) => {
      const byType = arr.find((x) => x && numOf(x.unit) === u && /TOKENS_LIMIT|CREDIT_LIMIT/i.test(String((x.types || []).join(' ') + ' ' + (x.type || ''))));
      return byType || arr.find((x) => x && numOf(x.unit) === u) || null;
    };
    const five = ofUnit(3), week = ofUnit(6), main = five || week || arr[0];
    if (!main) return null;
    const used = numOf(main.percentage);
    return { used, win: five ? '5小时' : '周', resetAt: numOf(main.nextResetTime), level: d.level || '' };
  }
  if (kind === 'kimi') {
    const u = j && j.usage; if (!u) return null;
    const lim = numOf(u.limit), rem = numOf(u.remaining);
    if (lim == null || rem == null || lim <= 0) return null;
    return { used: Math.max(0, Math.min(100, (1 - rem / lim) * 100)), win: '本期', resetAt: numOf(u.resetTime), level: '' };
  }
  if (kind === 'minimax') {
    const m = j && ((j.model_remains || [])[0]); if (!m) return null;
    const rem = numOf(m.current_interval_remaining_percent);
    if (rem == null) return null;
    return { used: Math.max(0, Math.min(100, 100 - rem)), win: '5小时', resetAt: numOf(m.end_time), level: '' };
  }
  if (kind === 'opencode') {
    const u = j && j.usage && (j.usage.rolling || j.usage.weekly || j.usage.monthly); if (!u) return null;
    const p = numOf(u.percent); if (p == null) return null;
    return { used: Math.max(0, Math.min(100, p)), win: j.usage.rolling ? '5小时' : '本期', resetAt: numOf(u.resetsAt), level: '' };
  }
  return null;
}
// 重置还剩多久:"3 小时 20 分" 这种
function fmtReset(ms) {
  if (!isFinite(ms) || ms <= 0) return '即将';
  const m = Math.round(ms / 60000);
  if (m < 60) return m + ' 分钟';
  const h = Math.floor(m / 60), mm = m % 60;
  if (h < 24) return h + ' 小时' + (mm ? ' ' + mm + ' 分' : '');
  return Math.floor(h / 24) + ' 天' + (h % 24 ? ' ' + (h % 24) + ' 小时' : '');
}
// ---------- 账号型订阅的"套餐额度"(不需要 key,白拿 ZCode 自己的日志) ----------
// 账号登录的 provider(provider_id 形如 account:xxx,key 是加密存在凭据库里的,我们读不到)
// 但它自己会向 zcode.z.ai/api/v1/zcode-plan/billing/balance 取额度,并把结果写进 v2/logs/<日期>.log:
//   [usage-stats] billing/balance 请求完成 {"balanceCount":2,"balances":[{"show_name":"GLM-5.3-Flash",
//      "total_units":5000000,"used_units":0,"remaining_units":5000000,"period_end":1791043199}, ...]}
// ⇒ 从日志尾部捞最近一条就能显示"套餐用了多少"。读不到就当没有(退回"只显示模型名")。
const VLOG_DIR = path.join(process.env.USERPROFILE || process.env.HOME, '.zcode', 'v2', 'logs');
let planCache = { ts: 0, data: null };
function fmtUnits(n) {
  if (n == null || !isFinite(n)) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'G';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}
function readPlanQuota() {
  const now = Date.now();
  // 有数据就 30 秒刷一次;没有数据 15 秒重试一次
  if (planCache.data ? now - planCache.ts < 30000 : now - planCache.ts < 15000) return planCache.data;
  planCache.ts = now;
  let best = null;
  for (let d = 0; d < 2 && !best; d++) {
    const day = new Date(now - d * 86400000);
    const f = path.join(VLOG_DIR, day.getFullYear() + '-' + String(day.getMonth() + 1).padStart(2, '0') +
      '-' + String(day.getDate()).padStart(2, '0') + '.log');
    let size = 0, fd = -1;
    try { size = fs.statSync(f).size; fd = fs.openSync(f, 'r'); } catch (_) { continue; }
    // 从尾部往回一段段找:日志一天能涨到十几 MB,只读尾部 400KB 会让那条记账日志很快滑出窗口
    // (2026-10-03 踩过:额度胶囊突然没了),所以按 512KB 分段往回翻,最多翻 8MB
    const CHUNK = 512 * 1024, MAX_BACK = 8 * 1024 * 1024;
    let end = size, back = 0;
    while (end > 0 && back < MAX_BACK && !best) {
      const start = Math.max(0, end - CHUNK);
      let txt = '';
      try {
        const buf = Buffer.alloc(end - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        txt = buf.toString('utf8');
      } catch (_) { break; }
      const lines = txt.split('\n');
      if (start > 0) lines.shift();   // 首行可能是被截断的半行,丢掉
      let cand = 0;
    for (let i = lines.length - 1; i >= 0 && cand < 40; i--) {
      const L = lines[i];
      if (L.indexOf('billing/balance 请求完成') < 0) continue;
      const a = L.indexOf('{'), b = L.lastIndexOf('}');
      if (a < 0 || b <= a) continue;
      let j = null;
      try { j = JSON.parse(L.slice(a, b + 1)); } catch (_) { continue; }
      // 日志里 balances 可能在三个位置:顶层 / j.data.balances / j.payload.data.balances
      const arr = !j ? null : (Array.isArray(j.balances) ? j.balances
        : (j.data && Array.isArray(j.data.balances) ? j.data.balances
          : (j.payload && j.payload.data && Array.isArray(j.payload.data.balances) ? j.payload.data.balances : null)));
      if (!arr || !arr.length) continue;
      cand++;
      const m = /\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/.exec(L);
      const at = m ? Date.parse(m[1] + 'T' + m[2]) : now;   // 宿主日志写的是本地时间
      const items = [];
      let hasEnd = false;
      for (const it of arr) {
        const total = numOf(it.total_units), used = numOf(it.used_units);
        const remain = numOf(it.remaining_units != null ? it.remaining_units : it.available_units);
        const pe = numOf(it.period_end) || numOf(it.expires_at);
        if (pe) hasEnd = true;
        if (total == null && remain == null) continue;
        items.push({ name: String(it.show_name || it.entitlement_id || '额度'), total, used, remain, end: pe ? pe * 1000 : null });
      }
      if (!items.length) continue;
      // 两种日志行:带 period_end 的那种信息全(重置时间),信息全的优先,其次取最近的
      if (!best || (hasEnd && !best.hasEnd)) best = { at: isFinite(at) ? at : now, items, hasEnd };
      if (best.hasEnd) break;
      }
      back += end - start;
      end = start;
    }
    try { fs.closeSync(fd); } catch (_) {}
  }
  if (!best) {
    // 一时没读到(日志里那条行还没刷新/被顶出窗口)就用上一次的,别让额度从气泡上消失
    if (planCache.data && now - planCache.data.at < 12 * 3600 * 1000) return planCache.data;
    planCache.data = null;
    return null;
  }
  planCache.data = best;
  return best;
}
// 挑"跟当前模型对得上"的那份额度(名字互相包含);对不上就用全部的
// 同一模型可能有好几份额度(如 GLM-5.3-Flash 既有一次性 100M 又有每日 5M),
// 取"用得更满的那份";都还没用就取总额小的那份(先耗尽的才是真约束)
function pickPlanItem(items, modelId) {
  if (!items || !items.length) return null;
  const clean = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9.]/g, '');
  const mo = clean(modelId);
  let pool = items;
  if (mo) {
    // 谁的名字跟模型名更"对得上"就用谁(名字长的优先,避免 GLM-5.3-Flash 被 GLM-5.3 抢走)
    const scored = [];
    for (const it of items) {
      const nm = clean(it.name);
      if (!nm) continue;
      let score = 0;
      if (nm === mo) score = 1e6;
      else if (mo.indexOf(nm) >= 0 || nm.indexOf(mo) >= 0) score = Math.min(nm.length, mo.length);
      if (score > 0) scored.push([score, it]);
    }
    if (scored.length) {
      let mx = 0;
      for (const s of scored) if (s[0] > mx) mx = s[0];
      pool = scored.filter((s) => s[0] === mx).map((s) => s[1]);
    }
  }
  // 用尽的份额不再是约束:ZCode 会自动切到下一份(实测每日 5M 用完后继续在一次性 100M 上跑),
  // 所以先在"还有剩"的份额里挑最紧的;全部用尽才退回旧规则(用得最满的那份,配 ⚠ 提醒)
  const alive = pool.filter((it) => it.total == null || (it.remain != null ? it.remain : it.total - (it.used || 0)) > 0);
  if (alive.length) pool = alive;
  let best = null, br = -1;
  for (const it of pool) {
    const r = it.total ? (it.used || 0) / it.total : 0;
    if (r > br || (r === br && best && it.total != null && (best.total == null || it.total < best.total))) { br = r; best = it; }
  }
  return best;
}
async function queryBalance(force) {
  const a = curApi;
  if (!a || balBusy) return;
  const now0 = Date.now();
  balTryAt = now0;
  // 25 秒内不重复打接口(和那只小鲸鱼一个数);点菜单刷新时 force=true 跳过
  if (!force && bal && bal.ts && now0 - bal.ts < 25000) return;
  const put = (o) => { bal = Object.assign({ providerId: a.providerId, label: a.label, ts: now0 }, o); };
  // 0) 账号型订阅(account:xxx):key 读不到,但套餐额度写在 ZCode 自己的日志里
  if (/^account:/i.test(a.providerId || '')) {
    const pq = readPlanQuota();
    if (pq) put({ kind: 'plan', items: pq.items, at: pq.at });
    return;
  }
  const key = a.key;
  const info = balInfoFor(a.providerId, a.modelId, a.def);
  if (!info || !key) return;
  if (!info.url && !info.usedUrl && !info.quota && !info.noBal) return;
  balBusy = true;
  try {
    // 1) 订阅额度优先:有 coding plan 的 key,充值余额通常没意义(搞不到就往下走)
    if (info.quota && !noPlanProviders.has(a.providerId)) {
      const r = await reqJson(info.quota.url, info.quota.auth, key);
      if (r.j) {
        const q = parseQuota(r.j, info.quota.kind);
        if (q && q.used != null) { put({ kind: 'quota', used: q.used, win: q.win, resetAt: q.resetAt, level: q.level, cur: info.cur || 'CNY' }); balBusy = false; return; }
      } else if (r.err === 'BIZ' && NO_PLAN_RE.test(r.msg || '')) {
        noPlanProviders.add(a.providerId);   // 这个 key 没订套餐,别再问额度了
      }
    }
    // 2) 充值型余额
    if (info.url || info.usedUrl) {
      const url = info.url || info.usedUrl;
      const r = await reqJson(url, info.auth, key);
      if (r.j) {
        let amt = info.path ? numOf(atPath(r.j, info.path)) : null;
        if (amt == null) amt = scanAmount(r.j);
        if (amt != null) {
          if (info.usedPath) {
            const uj = info.usedUrl && info.usedUrl !== url ? (await reqJson(info.usedUrl, info.auth, key)).j : r.j;
            const u = uj ? numOf(atPath(uj, info.usedPath)) : null;
            if (u != null) amt -= u;
          }
          if (info.scale) amt *= info.scale;
          put({ kind: 'money', amt, cur: info.cur || 'CNY' });
          balBusy = false; return;
        }
      }
    }
    // 3) 没有余额接口的家:只探活,看 key 通不通(HTTP 401 = key 不认)
    if (info.noBal && info.probeUrl) {
      let pr = null;
      try { const r = await fetch(info.probeUrl, { headers: authOf(info.auth, key), signal: AbortSignal.timeout(6000) }); pr = r.status; } catch (_) { pr = 0; }
      put({ kind: 'none', probe: pr, cur: info.cur || 'CNY' });
      balBusy = false; return;
    }
  } catch (_) {}
  balBusy = false;
}

function getCurApi() { return curApi; }
function getBal() { return bal; }
function invalidateBal() { bal = null; }   // 换 provider / 改配置后调用,下一拍重查
// tickOnce 每拍调用:余额还没拿到时按 20 秒节奏补试几次,拿到后归零计数
function retryBalance(now) {
  if (bal) { balFails = 0; return; }
  if (curApi.key && balTryAt && now - balTryAt > 20000 && balFails < 6) { balFails++; queryBalance(); }
}

module.exports = { resolveApi, getCurApi, getBal, invalidateBal, retryBalance, queryBalance, readPlanQuota, pickPlanItem, balInfoFor, fmtReset, fmtUnits };
