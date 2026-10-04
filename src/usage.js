'use strict';
// usage.js — ZCode 用量库(db.sqlite)统计 + rollout 兜底 + 面板「见过的 provider」(拆分自 pet-chip.js)
const fs = require('fs');
const path = require('path');
const C = require('./config');
const P = require('./pricing');
const B = require('./balance');
const { ROLLOUT, DB_PATH } = C;   // newestRollout / db 用
const { defFor, priceFor, costOf, curOf, fmtCost, bigName } = P;   // 逐行计价与大名
const { balInfoFor } = B;          // 面板「见过的 provider」用
// 「匹配」不用用户自己去找:脚本把用量库里出现过的 provider_id 全列出来(带次数/最新模型/已知的余额与单价),
// 面板上点一下就填好。30 秒缓存,顺便省掉面板每次打开都查库。
let seenCache = null, seenAt = 0;
function seenProviders() {
  if (seenCache && Date.now() - seenAt < 30000) return seenCache;
  let out = [];
  const conn = db();
  if (conn) {
    try {
      const rows = conn.prepare(
        "SELECT provider_id, model_id, n, tot FROM ("
        + " SELECT provider_id, model_id, COUNT(*) n, MAX(started_at) at,"
        + " SUM(COUNT(*)) OVER (PARTITION BY provider_id) tot,"
        + " ROW_NUMBER() OVER (PARTITION BY provider_id ORDER BY MAX(started_at) DESC) rn"
        + " FROM model_usage WHERE provider_id IS NOT NULL AND provider_id <> ''"
        + " GROUP BY provider_id, model_id) WHERE rn = 1 ORDER BY at DESC LIMIT 12"
      ).all();
      out = rows.map((r) => {
        const def = defFor(r.provider_id, r.model_id);
        const price = (def && priceFor(def, r.model_id)) || null;
        const bi = balInfoFor(r.provider_id, r.model_id, def);
        const fmt = (v) => (v == null ? '' : (Array.isArray(v) ? v.join(',') : v));
        return {
          p: r.provider_id, m: r.model_id || '', n: r.tot || r.n || 0,
          label: bigName(r.provider_id, r.model_id),
          url: (def && def.balanceUrl) || (bi && bi.url) || '', path: (def && def.balancePath) || (bi && bi.path) || '',
          quota: (bi && bi.quota) ? 1 : 0, nb: (bi && bi.noBal) ? 1 : 0,
          hit: price ? fmt(price.hit) : '', miss: price ? fmt(price.miss) : '', out: price ? fmt(price.out) : '',
          zcode: P.getApiKey(r.provider_id) ? 1 : 0,
        };
      });
      // 在 ZCode 里配了 key、但还没真正用过的 provider 也列上(用户刚配完就来加单价,这时用量库里还没有它)
      const have = new Set(out.map((x) => x.p));
      for (const k of P.apiKeyIds()) {
        if (have.has(k)) continue;
        const def = defFor(k, '');
        const price = (def && priceFor(def, '')) || null;
        const bi = balInfoFor(k, '', def);
        const fmt = (v) => (v == null ? '' : (Array.isArray(v) ? v.join(',') : v));
        out.push({ p: k, m: '', n: 0, label: bigName(k, ''), url: (def && def.balanceUrl) || (bi && bi.url) || '',
          path: (def && def.balancePath) || (bi && bi.path) || '', quota: (bi && bi.quota) ? 1 : 0, nb: (bi && bi.noBal) ? 1 : 0,
          hit: price ? fmt(price.hit) : '', miss: price ? fmt(price.miss) : '',
          out: price ? fmt(price.out) : '', zcode: 1 });
      }
    } catch (_) { out = []; }
  }
  seenCache = out; seenAt = Date.now();
  return out;
}
// ---------- 统计(与 token-chip 同口径 + 费用) ----------
function fmt(n) {
  if (n < 1000) return String(n);
  if (n < 100000) return (n / 1000).toFixed(1) + 'K';
  if (n < 1e6) return Math.round(n / 1000) + 'K';
  return (n / 1e6).toFixed(n < 1e7 ? 1 : 0) + 'M';
}

// ---------- 会话累计:优先读 ZCode 自己的用量库 ----------
// rollout 的 model-io 文件有 64MiB 上限,撞上限时 ZCode 会把**同一个会话**的文件清空重写
// (新首行带 modelIOReset, reason=session_file_size_limit),旧记录随之消失 —— 只对文件求和
// 会让 Σ 突然缩水。db.sqlite 的 model_usage 表留有全部历史,逐条口径与 rollout 一致
// (computed_total_tokens == rollout 里 usage.totalTokens,已按 turn_9bed1 25 次/2,626,021 核对)。
// 读库失败(库被写事务占住/Node 无 node:sqlite)就退回 rollout 口径。
const SESSION_RE = /^model-io-(sess_.+)\.jsonl$/;
function sessionIdOf(file) {
  const m = SESSION_RE.exec(path.basename(file || ''));
  return m ? m[1] : null;
}
let dbConn = null, dbBroken = false;
function db() {
  if (dbConn || dbBroken) return dbConn;
  try {
    const { DatabaseSync } = require('node:sqlite');
    dbConn = new DatabaseSync(DB_PATH, { readOnly: true });
  } catch (_) { dbBroken = true; }
  return dbConn;
}
// 一组同属一个会话的 model_usage 行(query_source='main_turn')→ ⚡本轮 / Σ累计 / 按家拆账。
// dbStats(按会话查库)与 recentBySession(全表扫完按会话分组)共用这一份 —— 面板要列几十个会话,
// 每个再单独查一次库就是几十次全表扫描(实测每会话约 13ms),同一口径分两处写也迟早走偏。
function aggRows(rows) {
  if (!rows || !rows.length) return null;
  const turns = new Map();
  let sessTotal = 0, sessCost = 0, latestAt = -1, latestProv = '', latestModel = '';
  const perCur = new Map();   // 币种 → 费用(混币种会话极少见,避免把 $ 直接加到 ¥ 上)
  const perProv = new Map();  // provider → 费用(菜单「本会话」明细用:Σ 胶囊不拆家,看不出钱花在哪)
  for (const r of rows) {
    const u = { cacheReadTokens: r.cache_read_input_tokens || 0, inputTokens: r.input_tokens || 0, outputTokens: r.output_tokens || 0 };
    const c = costOf(u, r.provider_id, r.model_id, r.started_at); // 订阅套餐(account: 开头)不计费 → 0
    const tk = r.computed_total_tokens != null ? r.computed_total_tokens : u.inputTokens + u.outputTokens;
    sessTotal += tk; sessCost += c;
    const cur = curOf(r.provider_id, r.model_id);
    perCur.set(cur, (perCur.get(cur) || 0) + c);
    const pk = r.provider_id || '?';
    const pe = perProv.get(pk) || { label: bigName(r.provider_id, r.model_id), cost: 0, cur };
    pe.cost += c;
    perProv.set(pk, pe);
    if ((r.started_at || 0) >= latestAt) { latestAt = r.started_at || 0; latestProv = r.provider_id || ''; latestModel = r.model_id || ''; }
    const t = turns.get(r.turn_id) || { total: 0, n: 0, cost: 0, at: -1 };
    t.total += tk; t.n += 1; t.cost += c;
    if ((r.started_at || 0) >= t.at) t.at = r.started_at || 0;
    turns.set(r.turn_id, t);
  }
  let last = null;
  for (const t of turns.values()) if (!last || t.at >= last.at) last = t;
  let curMain = '¥', curMax = -1;
  for (const [k, v] of perCur) if (v >= curMax) { curMax = v; curMain = k; }
  // 只有"按量计费的 API"才显示费用:订阅套餐没有单价,未知 provider 没有价格表 → 都不显示
  const billed = !/^account:/i.test(latestProv) && !!priceFor(defFor(latestProv, latestModel), latestModel);
  // Σ 胶囊的 ¥ 只算**当前在用的这家**(用户 2026-10-03:"我用那个模型,蓝色胶囊就显示那个模型的计费");
  // 整个会话混家的总账在菜单「💸 本会话」里看
  const curCost = (perProv.get(latestProv) || { cost: 0 }).cost;
  return {
    turn: `⚡${fmt(last.total)}${last.n > 1 ? '×' + last.n : ''}`,
    cost: billed ? fmtCost(last.cost, curOf(latestProv, latestModel)) : '',
    sum: 'Σ' + fmt(sessTotal),
    sumCost: billed ? fmtCost(curCost, curOf(latestProv, latestModel)) : '',
    providerId: latestProv, modelId: latestModel,
    // 本会话按家拆账(只列花了钱的,最多 3 家;不 gated 在 billed 上——当前切回订阅时明细照样能看)
    provTxt: (() => {
      const arr = [...perProv.values()].filter((e) => e.cost > 0.0005).sort((a, b) => b.cost - a.cost).slice(0, 3);
      return arr.length ? fmtCost(sessCost, curMain) + '(' + arr.map((e) => e.label + ' ' + fmtCost(e.cost, e.cur)).join(' · ') + ')' : '';
    })(),
  };
}

function dbStats(sessionId) {
  if (!sessionId) return null;
  const conn = db();
  if (!conn) return null;
  try {
    const rows = conn.prepare(
      "SELECT turn_id, provider_id, model_id, started_at, input_tokens, output_tokens, cache_read_input_tokens, computed_total_tokens"
      + " FROM model_usage WHERE session_id = ? AND query_source = 'main_turn'"
    ).all(sessionId);
    return aggRows(rows);
  } catch (_) { return null; }   // 库忙/被占 → 保留上一次结果
}

// ---------- 每个会话最近几轮(右键菜单「📊 各会话用量与最近三轮」用) ----------
// 一轮 = 一个 turn_id:轮内每次请求的 token 相加(与 Σ 胶囊同口径,computed_total_tokens),
// 模型与费用按该轮**最后一次**请求算(一轮里边聊边换模型极少见),时间取该轮第一次请求的 started_at。
// 子代理会话(sess_subagent_*)不列:它们的活算在派它的父会话名下,工作框也不单列。
// 归档会话(session.time_archived 非空)不列:用户在 ZCode 里归档了就是不想再看见它。
// 一次全表扫描换回所有会话的成本很低(4k 行 <50ms),但没必要跟着 1 秒的拍走 —— 由调用方缓存。
// 顺手用同一批行算出每个会话的 ⚡本轮 / Σ累计 / 按家拆账(aggRows,与菜单「💸 本会话」同一份口径),
// 调用方就不用为面板里几十个会话各查一次库了。
// 返回 { items, total, maxSess }:total = 有记录的会话总数,items 只取最近的 maxSess 个。
function recentBySession(n, maxSess) {
  const conn = db();
  if (!conn) return null;
  const want = n > 0 ? n : 3, maxN = maxSess > 0 ? maxSess : 6;
  try {
    const rows = conn.prepare(
      "SELECT mu.session_id, mu.turn_id, mu.provider_id, mu.model_id, mu.started_at,"
      + " COALESCE(mu.computed_total_tokens, mu.input_tokens + mu.output_tokens) tk,"
      + " mu.input_tokens, mu.output_tokens, mu.cache_read_input_tokens, mu.computed_total_tokens"
      + " FROM model_usage mu LEFT JOIN session s ON s.id = mu.session_id"
      + " WHERE mu.query_source = 'main_turn' AND mu.session_id NOT LIKE 'sess_subagent%'"
      + " AND COALESCE(s.time_archived, 0) = 0"
      + " ORDER BY mu.started_at"
    ).all();
    const bySess = new Map();             // session_id → 该会话的行(按 started_at 递增)
    for (const r of rows) {
      let a = bySess.get(r.session_id);
      if (!a) { a = []; bySess.set(r.session_id, a); }
      a.push(r);
    }
    const out = [];
    for (const [sid, rs] of bySess) {
      const byTurn = new Map();           // turn_id → 该轮合计
      for (const r of rs) {
        let t = byTurn.get(r.turn_id);
        if (!t) { t = { at: r.started_at, n: 0, tokens: 0, cost: 0, pid: '', mid: '' }; byTurn.set(r.turn_id, t); }
        t.n += 1;
        t.tokens += r.tk || 0;
        t.cost += costOf({ cacheReadTokens: r.cache_read_input_tokens || 0, inputTokens: r.input_tokens || 0, outputTokens: r.output_tokens || 0 }, r.provider_id, r.model_id, r.started_at);
        t.pid = r.provider_id || ''; t.mid = r.model_id || '';   // 行按时间递增 ⇒ 最后落下的就是该轮最后用的模型
      }
      const recent = [...byTurn.values()].slice(-want).reverse();   // 新的一轮排在前面
      if (!recent.length) continue;
      out.push({
        sid, at: recent[0].at,
        agg: aggRows(rs),                 // ⚡本轮 / Σ累计 / 按家拆账(与菜单「💸 本会话」逐字同一份代码)
        turns: recent.map((t) => {
          // 订阅套餐(account: 开头)没有单价;未知 provider 没有价格表 ⇒ 这一轮不显费用
          const billed = !/^account:/i.test(t.pid) && !!priceFor(defFor(t.pid, t.mid), t.mid);
          return { turn: t.turn_id, at: t.at, n: t.n, tokens: t.tokens, pid: t.pid, mid: t.mid,
                   costTxt: billed ? fmtCost(t.cost, curOf(t.pid, t.mid)) : '' };
        }),
      });
    }
    out.sort((a, b) => b.at - a.at);
    return { items: out.slice(0, maxN), total: out.length, maxSess: maxN };
  } catch (_) { return null; }
}

function newestRollout() {
  let files;
  try { files = fs.readdirSync(ROLLOUT).filter((f) => /^model-io-sess_.+\.jsonl$/.test(f)); }
  catch (_) { return null; }
  let best = null, bestM = -1;
  for (const f of files) {
    const p = path.join(ROLLOUT, f);
    try { const m = fs.statSync(p).mtimeMs; if (m > bestM) { bestM = m; best = p; } } catch (_) {}
  }
  return best;
}

function turnStats(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    const turns = new Map();
    let sessCost = 0, sessTotal = 0, lastBilled = false, lastProv = '', lastModel = '';
    const perProv = new Map();  // 按家拆账(与 dbStats 同口径)
    for (const l of lines) {
      let j; try { j = JSON.parse(l); } catch (_) { continue; }
      if (j.querySource !== 'main_turn') continue;
      const u = j.response && j.response.usage;
      if (!u) continue;
      const pv = (j.model && j.model.providerId) || '', md = (j.model && j.model.modelId) || '';
      const c = costOf(u, pv, md, Date.parse(j.startedAt) || undefined);
      lastBilled = !/^account:/i.test(pv) && !!priceFor(defFor(pv, md), md);
      lastProv = pv; lastModel = md;
      sessCost += c;
      sessTotal += u.totalTokens || 0;
      const pk = pv || '?';
      const pe = perProv.get(pk) || { label: bigName(pv, md), cost: 0, cur: curOf(pv, md) };
      pe.cost += c;
      perProv.set(pk, pe);
      const t = turns.get(j.turnId) || { total: 0, n: 0, cost: 0 };
      t.total += u.totalTokens || 0; t.n += 1; t.cost += c;
      turns.set(j.turnId, t);
    }
    if (turns.size === 0) return null;
    const last = [...turns.values()].pop();
    const provArr = [...perProv.values()].filter((e) => e.cost > 0.0005).sort((a, b) => b.cost - a.cost).slice(0, 3);
    return {
      turn: `⚡${fmt(last.total)}${last.n > 1 ? '×' + last.n : ''}`,
      cost: lastBilled ? fmtCost(last.cost) : '',
      sum: 'Σ' + fmt(sessTotal),
      sumCost: lastBilled ? fmtCost(sessCost) : '',
      providerId: lastProv, modelId: lastModel,
      provTxt: provArr.length ? fmtCost(sessCost, curOf(lastProv, lastModel)) + '(' + provArr.map((e) => e.label + ' ' + fmtCost(e.cost, e.cur)).join(' · ') + ')' : '',
    };
  } catch (_) { return null; }
}
module.exports = { seenProviders, fmt, db, sessionIdOf, dbStats, recentBySession, newestRollout, turnStats };
