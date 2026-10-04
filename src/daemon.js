'use strict';
// daemon.js — 守护主循环:CDP 注入/心跳/右键事件/投喂签到番茄钟(拆分自 pet-chip.js)
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');   // 取 CDP 目标列表用(直连,比 fetch 稳)
const C = require('./config');
const P = require('./pricing');
const B = require('./balance');
const U = require('./usage');
const PS = require('./pet-state');
const W = require('./weather');
const PG = require('./page');
const DATA_DIR = C.DATA_DIR;
const PETS = C.PETS, POLL_MS = C.POLL_MS, CDP_PORT = C.CDP_PORT, LOCK_PORT = C.LOCK_PORT,
      BAL_INTERVAL = C.BAL_INTERVAL, LOW_BALANCE = C.LOW_BALANCE, SAT_DECAY_MS = C.SAT_DECAY_MS, dateStr = C.dateStr;
const LEVELS = PS.LEVELS, ZLOG_DIR = C.ZLOG_DIR;
const petSlot = PS.petSlot, savePetState = PS.savePetState, petState = PS.petStateRef(),
      ACH_DEFS = PS.ACH_DEFS, levelOf = PS.levelOf, titleOf = PS.titleOf,
      gainFromTokens = PS.gainFromTokens, FEED_COOLDOWN = PS.FEED_COOLDOWN, MANUAL_FEED = PS.MANUAL_FEED;
const dbStats = U.dbStats, turnStats = U.turnStats, newestRollout = U.newestRollout,
      sessionIdOf = U.sessionIdOf, db = U.db, fmt = U.fmt, seenProviders = U.seenProviders;
const resolveApi = B.resolveApi, queryBalance = B.queryBalance, readPlanQuota = B.readPlanQuota,
      pickPlanItem = B.pickPlanItem, fmtReset = B.fmtReset, fmtUnits = B.fmtUnits, balInfoFor = B.balInfoFor,
      retryBalance = B.retryBalance;
const defFor = P.defFor, priceFor = P.priceFor, isPeakBJ = P.isPeakBJ, readProvider = P.readProvider, apiList = P.apiList,
      loadCustomDefs = P.loadCustomDefs, bigName = P.bigName;
const { WEATHER, refreshWeather } = W;
const petJs = PG.petJs, setBindName = PG.setBindName;


// 单例锁:9226 被占说明已有守护在跑,直接退出(幂等启动的基础)
const lock = net.createServer();
lock.once('error', () => process.exit(0));
lock.listen(LOCK_PORT, '127.0.0.1');
// ---------- 点击内容:一言 API + 本地语录池 ----------
const HITOKOTO = { url: 'https://v1.hitokoto.cn/?c=i&c=b&c=a&encode=json', text: null, from: null, ts: 0, busy: false };
async function refreshHitokoto(force) {
  if (HITOKOTO.busy || (!force && Date.now() - HITOKOTO.ts < 90000)) return;
  HITOKOTO.busy = true;
  try {
    const r = await fetch(HITOKOTO.url);
    const j = await r.json();
    HITOKOTO.text = j.hitokoto; HITOKOTO.from = j.from_who || j.from || ''; HITOKOTO.ts = Date.now();
  } catch (_) {}
  HITOKOTO.busy = false;
}
const DEV_QUOTES = [
  'Talk is cheap. Show me the code.',
  '键盘敲得越响,bug 来得越快。',
  '编程 = 99% 排查 + 1% 编写。',
  '距下班还剩 N 行代码。',
  '这不是 bug,是未文档化的特性。',
  '程序员最讨厌两件事:写注释,和别人的代码没注释。',
  '代码能跑就别动它……除非是我写的。',
  '今天写的代码,就是明天给自己的谜语。',
  '删掉的代码才是好代码。',
  '咖啡因驱动开发(CDD),今日燃料已加满。',
];
function greetingLine() {
  const now = new Date();
  const h = now.getHours(), w = '日一二三四五六'[now.getDay()];
  const g = h < 6 ? '夜深了' : h < 11 ? '早上好' : h < 14 ? '中午好' : h < 18 ? '下午好' : h < 23 ? '晚上好' : '夜深了';
  return g + '!周' + w + '也要加油鸭';
}
let ovr = null; // {text, until}
let celebrateUntil = 0; // 升级/喂食时的跳跃庆祝窗
let pomEnd = 0;         // 番茄钟结束时刻(0=未开)
let feedTick = 0;       // 喂食事件计数(页面据此放掉落动画)
let lastToolTs = 0, lastToolReactAt = 0;
let toolCounts = { bash: 0, tools: 0 }, toolCountAt = 0; // 成就用的库统计缓存
let curSlug = (petState.active && PETS.some(function (p) { return p.slug === petState.active; })) ? petState.active : PETS[0].slug; // 页面当前宠物(fastPoll 同步,持久化防重启认错)
const HUNGRY_LINES = ['饿哭了…投喂一点 token 吧', '肚子咕噜咕噜叫了(>_<)', '看在我这么卖力干活的份上,喂口饭?', '再不喂就要饿成纸片宠了'];
function onPetClicked() {
  const slot = petSlot(curSlug);
  if (slot.sat < 15 && Math.random() < 0.5) {
    ovr = { text: HUNGRY_LINES[Math.floor(Math.random() * HUNGRY_LINES.length)], until: Date.now() + 3200 };
    return;
  }
  const r = Math.random();
  if (r < 0.15 && WEATHER.txt && Date.now() - WEATHER.ts < 7200000) {
    ovr = { text: WEATHER.txt, until: Date.now() + 4200 };
  } else if (r < 0.55 && HITOKOTO.text && Date.now() - HITOKOTO.ts < 3600000) {
    ovr = { text: '「' + HITOKOTO.text + '」' + (HITOKOTO.from ? ' —— ' + HITOKOTO.from : ''), until: Date.now() + 4500 };
    refreshHitokoto(true); // 用掉一句,后台补一句
  } else if (r < 0.85) {
    ovr = { text: DEV_QUOTES[Math.floor(Math.random() * DEV_QUOTES.length)], until: Date.now() + 4200 };
  } else {
    const st = stats || {};
    const unchecked = slot.checkinDate !== dateStr(new Date()) ? ' · 记得签到哦' : '';
    ovr = { text: greetingLine() + ' · Lv.' + slot.lv + titleOf(slot.fed) + (st.sum ? ' · 本会话已 ' + st.sum : '') + unchecked, until: Date.now() + 4200 };
  }
}
// ---------- 投喂:每完成一轮对话按 token 投喂(跨会话查全库) + 手动喂食 ----------
// 一轮对话在跑的过程中就在持续写用量行,而且每写完一行的 status 就已经是 completed、done===n 立刻成立
// ⇒ 老写法(只在"这轮没喂过"时喂一次)会在**这轮刚发出第一个请求**时就把它喂掉,只吃到那一小口 token:
// 实测 17:00 之后库里的轮涨了 85M,而成长值只涨了 2.5M(所以饱食度/等级看着不涨)。
// 现改为**按轮记账**:fedCred[turn_id] 记住这一轮已经喂过多少 token,每次轮询只喂"比上次多出来的那部分"。
// 因此一轮跑完时总量一定喂满,长对话中途也能看到饱食度与等级在涨。
// 候选窗口往前多留 30 分钟,防止"刚开始的轮"被后面新开的轮挤出水线之外、导致尾巴的 token 永远喂不到。
const FEED_WINDOW_MS = 30 * 60 * 1000;
function feedFromDb(slug) {
  const conn = db();
  if (!conn || !slug) return;
  const slot = petSlot(slug);
  try {
    const rows = conn.prepare(
      "SELECT turn_id, MAX(started_at) at, SUM(computed_total_tokens) tk,"
      + " SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) done, COUNT(*) n"
      + " FROM model_usage WHERE query_source='main_turn' GROUP BY turn_id HAVING MAX(started_at) > ?"
    ).all((petState.lastFedTurnAt || 0) - FEED_WINDOW_MS);
    if (!petState.fedCred || typeof petState.fedCred !== 'object' || Array.isArray(petState.fedCred)) petState.fedCred = {};
    const cred = petState.fedCred;
    let maxAt = petState.lastFedTurnAt || 0, fed = false;
    for (const r of rows) {
      const prev = typeof cred[r.turn_id] === 'number' ? cred[r.turn_id] : 0;
      // 只喂"所有行都 completed"的轮;喂的是这轮相对上次的增量
      if (r.done === r.n && r.tk > prev) {
        const delta = r.tk - prev;
        cred[r.turn_id] = r.tk;
        slot.fed += delta;
        const before = slot.lv;
        slot.lv = levelOf(slot.fed);
        slot.sat = Math.min(100, slot.sat + gainFromTokens(delta));
        if (prev === 0) slot.turns = (slot.turns || 0) + 1;   // 轮数只在新轮第一次喂到时 +1
        feedTick++;
        const h = new Date().getHours();
        if (h < 5) { slot.ach = slot.ach || {}; slot.ach.night = true; } // 夜猫子成就
        fed = true;
        if (slot.lv > before) {
          celebrateUntil = Date.now() + 1600;
          ovr = { text: '🎉 吃掉了 ' + fmt(slot.fed) + ' tokens,升到 Lv.' + slot.lv + '「' + titleOf(slot.fed) + '」!', until: Date.now() + 3600 };
        }
      }
      if ((r.at || 0) > maxAt) maxAt = r.at || 0;
    }
    // 只留最近 400 轮的记账(对象保持插入顺序):更早的轮已在水线外,不会再成为候选
    const keys = Object.keys(cred);
    if (keys.length > 400) for (const k of keys.slice(0, keys.length - 400)) delete cred[k];
    if (maxAt > (petState.lastFedTurnAt || 0)) { petState.lastFedTurnAt = maxAt; savePetState(); }
    else if (fed) savePetState();
  } catch (_) {}
}
function handleManualFeed() {
  const slot = petSlot(curSlug);
  const now = Date.now();
  if (now - slot.lastFeedAt < FEED_COOLDOWN) { ovr = { text: '刚吃过啦,缓缓再喂~', until: now + 2200 }; injectNow(); return; }
  if (slot.sat >= 100) { ovr = { text: '吃不下啦,圆滚滚(撑)', until: now + 2200 }; injectNow(); return; }
  slot.sat = Math.min(100, slot.sat + MANUAL_FEED);
  slot.lastFeedAt = now;
  savePetState();
  feedTick++;
  celebrateUntil = now + 900;
  ovr = { text: '呜嗷!好吃!(饱食 ' + slot.sat + '%)', until: now + 2400 };
  injectNow();
}
function handleCheckin() {
  const slot = petSlot(curSlug);
  const now = new Date();
  const today = dateStr(now);
  if (slot.checkinDate === today) { ovr = { text: '📅 今天已经签过啦(连签 ' + (slot.streak || 0) + ' 天)', until: Date.now() + 2500 }; injectNow(); return; }
  const yest = dateStr(new Date(now.getTime() - 86400000));
  slot.streak = (slot.checkinDate === yest) ? (slot.streak || 0) + 1 : 1;
  slot.checkinDate = today;
  slot.sat = Math.min(100, slot.sat + 20);
  savePetState();
  feedTick++;
  celebrateUntil = Date.now() + 900;
  ovr = { text: '📅 签到成功!连签 ' + slot.streak + ' 天(+20 饱食)', until: Date.now() + 2800 };
  injectNow();
}
function handlePom() {
  const now = Date.now();
  if (pomEnd > now) { pomEnd = 0; ovr = { text: '🍅 番茄钟已取消', until: now + 2200 }; injectNow(); return; }
  pomEnd = now + 25 * 60000;
  ovr = { text: '🍅 番茄钟开始!25 分钟专注,我陪你', until: now + 3200 };
  injectNow();
}
// ---------- 失败检测 ----------
function todayLog() {
  const d = new Date();
  const p = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return path.join(ZLOG_DIR, `zcode-${p}.jsonl`);
}
let logOffset = 0;
let lastFailTs = 0;
// 实时工作信号:来自 ZCode 自己的日志事件流(turn.phase/model.request/tool.call 的 started/completed)
// 日志每行都带 sessionId,所以**按会话各记一份**:桌宠只有一个身体,但可以有多个会话同时在跑。
// 只维护一个全局回合开关时,任一会话做完都会把别的会话正在跑的回合一起关掉
//(症状:两个任务并行,先完成的那个一结束,实时工作气泡就消失、退回旧的"敲敲敲"工具反应)。
// open=true 表示该会话的用户回合还没结束 —— 中间再长的空窗(模型思考/慢工具)也算工作中,气泡不会中途挥手。
const turns = new Map();              // sessionId -> {open, phase:{code:'think'|'tool',tool,since}, lastAt}
const TURN_STALE_MS = 180000;         // 该会话最后一条事件超过 3 分钟没动过,就当回合已悄悄结束(一天有 ~8 个崩在半路的僵尸回合,不兜住宠物会永久"工作中")
const TURN_KEEP_MS = 30 * 60 * 1000;  // 会话记录最多留 30 分钟,防 Map 无限长
let displaySess = null;               // 当前展示的会话:用户最近一次"发起回合"的那个
function turnOf(sid) {
  let t = turns.get(sid);
  if (!t) { t = { open: false, phase: null, since: 0, lastAt: 0, model: '', provider: '' }; turns.set(sid, t); }
  return t;
}
// 正在干活的会话(回合开着且刚动过);多个同时忙就取最近动过的那个 —— 宠物只有一个,展示最忙的那个
function busyTurn(now) {
  let best = null, bestSid = null;
  for (const [sid, t] of turns) {
    if (!t.open || now - t.lastAt > TURN_STALE_MS) continue;
    if (!best || t.lastAt > best.lastAt) { best = t; bestSid = sid; }
  }
  return best ? { sid: bestSid, t: best } : null;
}
function busyCount(now) {
  let n = 0;
  for (const t of turns.values()) if (t.open && now - t.lastAt <= TURN_STALE_MS) n++;
  return n;
}
// 同时在忙的会话清单(给实时工作框一段一段地显示)。子代理会话不单列 ——
// 它是被某个会话用 Task 工具派出去的,活儿本来就该算在派它的那个会话名下,
// 单列会让一个任务在气泡上出现两段(父"🤝 派活" + 子"跑命令")。
function busyList(now) {
  const out = [];
  for (const [sid, t] of turns) {
    if (!t.open || now - t.lastAt > TURN_STALE_MS) continue;
    if (/^sess_subagent/.test(sid)) continue;
    const m = sessionMeta(sid);
    if (m.taskType && m.taskType !== 'interactive') continue;
    out.push({ sid, t, title: m.title });
  }
  // 先开的排上面:顺序不随时间跳,免得两段来回换位
  out.sort((a, b) => ((a.t.since || a.t.lastAt) - (b.t.since || b.t.lastAt)) || (a.sid < b.sid ? -1 : 1));
  return out;
}
const WORK_T = { Bash: '⚙️ 跑命令', Read: '📖 查阅中', Grep: '📖 查阅中', Glob: '📖 查阅中', LS: '📖 查阅中',
  Edit: '✍️ 改代码', Write: '✍️ 写文件', MultiEdit: '✍️ 改代码', NotebookEdit: '✍️ 改代码',
  WebSearch: '🔍 查资料', WebFetch: '🔍 查资料', TodoWrite: '📝 记计划', TaskOutput: '⏳ 等任务', Task: '🤝 派活' };
// 某个会话此刻"在干什么":阶段行 + 详情行(工具/模型 · 已耗时)
function workLine(t, now) {
  const p = t.phase;
  const el = Math.max(0, Math.round((now - (p ? p.since : t.since || t.lastAt)) / 1000));
  const elTxt = el >= 60 ? Math.floor(el / 60) + ' 分 ' + Math.round(el % 60) + ' 秒' : el + ' 秒';
  if (p && p.code === 'tool') return { l2: WORK_T[p.tool] || '🔧 用工具', l3: p.tool + ' · ' + elTxt };
  if (p) return { l2: '🤔 思考中', l3: (t.model || (stats && stats.modelId) || '模型') + ' · 想了 ' + elTxt };
  return { l2: '⚡ 开工了', l3: '等模型先说话 · ' + elTxt };   // 回合刚开、还没进入具体阶段
}
// 会话标题(工作框里那一段叫什么)取自 ZCode 自己的库 session.title ——
// 只读查询 + 60 秒缓存(标题会被用户改,缓存别太久;拿不到就退回短 id)。
const sessMeta = new Map();           // sid -> {title, taskType, at}
const SESS_META_TTL = 60000;
function sessionMeta(sid) {
  const c = sessMeta.get(sid);
  const now = Date.now();
  if (c && now - c.at < SESS_META_TTL) return c;
  let rec = { title: '', taskType: '', at: now };
  try {
    const conn = U.db();
    if (conn) {
      const r = conn.prepare('SELECT title, task_type FROM session WHERE id = ?').get(sid);
      if (r) rec = { title: String(r.title || ''), taskType: String(r.task_type || ''), at: now };
    }
  } catch (_) {}
  if (sessMeta.size > 200) sessMeta.clear();
  sessMeta.set(sid, rec);
  return rec;
}
// 会话名太长就截断(气泡最宽 300px,名字行 10px 字,16 个字够用)
function clipName(s) { s = String(s || '').trim().replace(/\s+/g, ' '); return s.length > 16 ? s.slice(0, 16) + '…' : s; }
function shortSid(sid) { const m = /^sess_(.{6})/.exec(sid); return m ? m[1] : sid.slice(0, 6); }
// 每个会话自己的用量/拆账:多会话时菜单里一个会话一行。dbStats 按会话全量查询,30 秒缓存
const sessStatsCache = new Map();     // sid -> {turn,turnCost,sum,sumCost,provTxt,at}
function sessStatsFor(sid, now) {
  const c = sessStatsCache.get(sid);
  if (c && now - c.at < 30000) return c;
  let rec = { turn: '', turnCost: '', sum: '', sumCost: '', provTxt: '' };
  try { const s = dbStats(sid); if (s) rec = { turn: s.turn, turnCost: s.cost || '', sum: s.sum, sumCost: s.sumCost, provTxt: s.provTxt }; } catch (_) {}
  if (sessStatsCache.size > 50) sessStatsCache.clear();
  rec.at = now;
  sessStatsCache.set(sid, rec);
  return rec;
}
// ---------- 多会话合并统计 ----------
// ≥2 个会话同时在跑时记下名单(陆续完工的也不丢);等**全部**跑完(busy 归零),
// Σ 胶囊改成「Σ13M¥0.67+25M+8M+…」分段相加各会话的用量 —— 钱跟在每个 M 后面,
// 超过 3 段折叠省略号。单会话跑保持现状;下一次新回合开始,汇总自动让位。
let multiSids = [];                   // 本轮多会话的名单
let multiSum = null;                  // {txt, at} 全部跑完后的分段相加文本
// 多会话状态机的纯函数一步(便于单测):输入旧状态与当前在忙名单,返回新状态
function multiRunStep(sids, sum, busySess, now) {
  const n = busySess.length;
  if (n >= 2) {
    const list = sids.slice();
    for (const x of busySess) if (list.indexOf(x.sid) < 0) list.push(x.sid);
    return { multiSids: list, multiSum: null };          // 新一轮(或续跑):清旧汇总、扩充名单
  }
  if (n === 1) {
    if (sids.indexOf(busySess[0].sid) >= 0) return { multiSids: sids, multiSum: sum };   // 多会话剩一只,等它完工
    return { multiSids: [], multiSum: null };            // 名单外的单会话:新一轮,旧汇总让位
  }
  if (sids.length >= 2) return { multiSids: [], multiSum: buildMultiSum(sids, now) };    // 全部跑完 → 生成分段相加
  return { multiSids: [], multiSum: sum };               // 普通空闲:汇总保持(下个回合再让位)
}
function buildMultiSum(sids, now) {
  const ZW = '\u200B';   // 零宽空格:胶囊挤满时浏览器在 + 号后面换行,不会把数字断成两截
  const segs = [], tsegs = [];
  for (const sid of sids) {
    const s = sessStatsFor(sid, now);
    if (!s || !s.sum) continue;                          // 查不到用量(如探针)的会话不进汇总
    segs.push(s.sum.replace(/^Σ/, '') + (s.sumCost || ''));                                   // Σ累计段
    if (s.turn) tsegs.push(s.turn.replace(/^⚡/, '').replace(/×\d+$/, '') + (s.turnCost || ''));  // ⚡本轮段(去掉×请求数)
  }
  if (segs.length < 2) return null;                      // 凑不满两段就没有"分段"的意义
  const pack = (a, pre) => pre + a.slice(0, 3).join('+' + ZW) + (a.length > 3 ? '+' + ZW + '…' : '');
  return { txt: pack(segs, 'Σ'), turnTxt: pack(tsegs, '⚡'), at: now };
}
function stepMultiRun(busySess, now) {
  const r = multiRunStep(multiSids, multiSum, busySess, now);
  multiSids = r.multiSids; multiSum = r.multiSum;
}

function sweepTurns(now) {
  // 不管回合开没开,只要这么久没再动过就丢。光判 !t.open 是不够的:
  // 崩在半路的回合(有 started、永远等不到 completed)本身就是 open=true,
  // 只清已关闭的记录等于把最该清的那种僵尸留下来,Map 会一天涨几条。
  for (const [sid, t] of turns) if (now - t.lastAt > TURN_KEEP_MS) turns.delete(sid);
}
// 统计口径的"当前会话":优先用户最近发起回合的那个。按最新 rollout 的写入时间来挑是不行的
// —— 两个会话交替写,谁最后写谁就被当成"当前会话",气泡里的 token 数字会来回跳。
function currentSessionId(now) {
  const b = busyTurn(now);
  if (b && busyCount(now) === 1) return b.sid;   // 只有一个会话在跑,那它就是用户在等的那只
  if (displaySess && turns.has(displaySess)) {
    const t = turns.get(displaySess);
    if (now - t.lastAt < TURN_KEEP_MS) return displaySess;
  }
  return b ? b.sid : null;
}
function scanLogForFailures() {
  try {
    const f = todayLog();
    if (!fs.existsSync(f)) return;
    const size = fs.statSync(f).size;
    if (size <= logOffset) { logOffset = size; return; }
    const fd = fs.openSync(f, 'r');
    const buf = Buffer.alloc(size - logOffset);
    fs.readSync(fd, buf, 0, buf.length, logOffset);
    fs.closeSync(fd);
    logOffset = size;
    const text = buf.toString('utf8');
    for (const line of text.split('\n')) {
      if (line.indexOf('"event":') < 0) continue;
      const failed = line.includes('"turn.failed"');
      const isEvt = failed || line.indexOf('"turn.phase.') >= 0 || line.indexOf('"model.request.started"') >= 0
        || line.indexOf('"tool.call.started"') >= 0 || line.indexOf('"turn.completed"') >= 0 || line.indexOf('"turn.started"') >= 0;
      if (!isEvt) continue;
      let ts = Date.now();
      try {
        const j = JSON.parse(line);
        if (j && j.timestamp) { const p = Date.parse(j.timestamp); if (isFinite(p)) ts = p; }
        const ev = j && j.event;
        const sm = /"sessionId":"([^"]+)"/.exec(line);
        const sid = (sm && sm[1]) || (j && j.sessionId) || '(未知会话)';
        const t = turnOf(sid);
        t.lastAt = ts;
        // 工具调用行的 context 里带 providerId/modelId(model.request.started 行没有)⇒ 从工具行顺手记下
        // 这个会话在用哪家的什么模型,「各会话」二级菜单和工作框的思考行都用它
        const mp = /"providerId":"([^"]+)"/.exec(line);
        if (mp) t.provider = mp[1];
        const mm = /"modelId":"([^"]+)"/.exec(line);
        if (mm) t.model = mm[1];
        if (ev === 'turn.phase.started' || ev === 'turn.started') {
          if (!t.open) { t.phase = null; t.since = ts; }   // 新回合:清掉上一回合残留的阶段
          t.open = true;
          displaySess = sid;                               // 用户刚在这个会话发起回合 ⇒ 它就是"当前会话"
        } else if (ev === 'turn.completed') t.open = false;
        else if (ev === 'turn.failed') { t.open = false; t.phase = null; }
        // turn.phase.completed 不关回合:一个 turn 有多个 phase(首个是 context_initialization)。
        // 老写法拿它当"回合结束",才不得不靠 act.lastActivity 的 25 秒兜底,
        // 也正因为它是全局的,别的会话一完工就把这个会话的回合一起关了(bug 来源)
        else if (ev === 'turn.phase.completed') { /* 阶段收尾,回合继续 */ }
        else if (ev === 'model.request.started') t.phase = { code: 'think', since: ts };
        else if (ev === 'tool.call.started') {
          const m = /"toolName":"([^"]+)"/.exec(line);
          t.phase = { code: 'tool', tool: m ? m[1] : '工具', since: ts };
        }
        if (failed) lastFailTs = ts;
      } catch (_) {
        if (failed) lastFailTs = Date.now();
      }
    }
    sweepTurns(Date.now());
  } catch (_) {}
}

// ---------- 状态机 ----------
const act = { lastActivity: 0, waveUntil: 0, prevState: 'idle' };
function decideState(now, busy) {
  let s;
  if (now - lastFailTs < 60000) s = 'failed';
  else if (busy || now - act.lastActivity < 25000) s = 'running';   // 任一会话回合没关 = 一直在工作(思考/慢工具的空窗不挥手)
  else if (now < act.waveUntil) s = 'waving';
  else s = 'idle';
  if (act.prevState === 'running' && s === 'idle') act.waveUntil = now + 6000;   // 只有真完工才挥手
  act.prevState = s;
  return s;
}
const sockets = new Map();
const cdpPending = new Map();   // 等 CDP 响应的回调表(sendTo 用;曾漏声明 → 每次 evaluate 抛 ReferenceError 被吞)
let lastPayload = '';
let tick = 0;
let msgId = 0;
function sendTo(ws, js, wantValue) {
  return new Promise((res) => {
    try {
      if (ws.readyState !== 1) return res(wantValue ? null : false);
      const id = ++msgId;
      cdpPending.set(id, (m) => {
        // 页面里 throw 不是协议错误:m.error 为空,只体现在 result.exceptionDetails。
        // 不认这一项的话,注入"看起来成功了"其实页面早就在半路抛异常(症状:改了跟没改一样)
        const ex = m.result && m.result.exceptionDetails;
        if (m.error) sendErr = (m.error.message || JSON.stringify(m.error));
        else if (ex) sendErr = '页面异常: ' + ((ex.exception && (ex.exception.description || ex.exception.value)) || ex.text || 'unknown') + ' @line ' + (ex.lineNumber != null ? ex.lineNumber : '?');
        res(wantValue ? (m.result && m.result.result ? m.result.result.value : null) : !(m.error || ex));
      });
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: js, returnByValue: !!wantValue } }));
      setTimeout(() => { if (cdpPending.has(id)) { cdpPending.delete(id); sendErr = sendErr || 'TIMEOUT'; res(wantValue ? null : false); } }, 3000);
    } catch (_) { res(wantValue ? null : false); }
  });
}

let lastFile = null, lastSize = 0, stats = null, statsAt = 0, settleAt = 0;
async function tickOnce() {
  tick++;
  const now = Date.now();
  readProvider();
  const file = newestRollout();
  let due = stats === null;                       // 首跑
  if (file) {
    if (file !== lastFile) { lastFile = file; lastSize = 0; due = true; }
    try {
      const size = fs.statSync(file).size;
      if (size !== lastSize) {
        lastSize = size;
        act.lastActivity = fs.statSync(file).mtimeMs;
        settleAt = now + 3000;                    // 库里的行可能比 rollout 晚一拍入库,3 秒后补一次
        due = true;
      }
    } catch (_) {}
  }
  if (settleAt && now >= settleAt) due = true;
  if (now - statsAt > 30000) due = true;          // 心跳:兜住库写入滞后
  if (due) {
    statsAt = now; settleAt = 0;
    // 统计跟着"当前会话"走,不再跟着最新写入的 rollout 文件走(否则并发时会话会来回翻)
    const vid = currentSessionId(now);
    const s = (vid && dbStats(vid)) || dbStats(sessionIdOf(file)) || (file ? turnStats(file) : null);
    if (s) stats = s;
    feedFromDb(curSlug);                          // 养成:跨会话投喂新完成的一轮
    // 一次性迁移:轮数成就回填全部历史(与成长值"历史不亏"口径一致)
    if (!petState.turnsBackfilled) {
      const connB = db();
      if (connB) {
        try {
          const n = connB.prepare("SELECT COUNT(*) n FROM (SELECT turn_id FROM model_usage WHERE query_source='main_turn' GROUP BY turn_id)").get().n;
          const s0 = petSlot(curSlug);
          s0.turns = Math.max(s0.turns || 0, n);
          petState.turnsBackfilled = 1;
          savePetState();
        } catch (_) {}
      }
    }
  }
  // 饱食度随时间消耗(1 点/3 分钟,见 SAT_DECAY_MS)
  const slot = petSlot(curSlug);
  if (slot.sat > 0 && now - slot.lastDecayAt >= SAT_DECAY_MS) {
    const steps = Math.floor((now - slot.lastDecayAt) / SAT_DECAY_MS);
    slot.sat = Math.max(0, slot.sat - steps);
    slot.lastDecayAt += steps * SAT_DECAY_MS;
    savePetState();
  }
  scanLogForFailures();
  const busy = busyTurn(now);                     // 正在干活的会话(任意一个),null = 全闲
  let state = decideState(now, busy);
  if (now < celebrateUntil) state = 'jumping';    // 升级/喂食庆祝优先
  else if (slot.sat < 15 && state === 'idle') state = 'waiting'; // 饿了讨食
  // 气泡进度条改用「等级进度」:饱食度已经在文字里写了百分比(🍖63%),条再重复一遍没意义
  const lvIdx = Math.max(0, Math.min(LEVELS.length - 1, levelOf(slot.fed) - 1));
  const lvNext = LEVELS[lvIdx + 1];
  const sat = {
    pct: slot.sat, lv: slot.lv, title: titleOf(slot.fed),
    lvp: lvNext === undefined ? 100 : Math.max(0, Math.min(100, ((slot.fed - LEVELS[lvIdx]) / (lvNext - LEVELS[lvIdx])) * 100)),
    maxLv: lvNext === undefined ? 1 : 0,
  };
  // 工具调用反应:库里有新工具调用且正在干活时,冒一句短台词(8s 限频,不抢正在显示的气泡)
  try {
    const conn = db();
    if (conn) {
      const tr = conn.prepare('SELECT tool_name, started_at FROM tool_usage ORDER BY started_at DESC LIMIT 1').get();
      if (tr && tr.started_at > lastToolTs) {
        lastToolTs = tr.started_at;
        // 只在"没有任何会话在实时工作时"才冒工具台词:否则会和实时工作框打架
        //(气泡被 ovr 顶掉 → 页面跳过动画还原 → 跑步停下重跑 + 冒出老的"敲敲敲"界面)
        if (state === 'running' && !busy && now - lastToolReactAt > 8000 && now >= celebrateUntil && !(ovr && ovr.until > now)) {
          const TOOL_SAY = { Read: '翻找中…', Grep: '搜索中…', Glob: '翻找中…', Bash: '敲敲敲…', Edit: '改改改…', Write: '奋笔疾书…', WebFetch: '上网查查…', WebSearch: '上网查查…', TodoWrite: '列个清单…', Task: '派小弟干活…' };
          ovr = { text: '🔧 ' + (TOOL_SAY[tr.tool_name] || '忙忙忙…'), until: now + 2200 };
          lastToolReactAt = now;
        }
      }
    }
  } catch (_) {}
  // 作息:深夜 23-7 点打瞌睡(不散步,头顶 Zzz);凌晨 1-5 点还在干活则劝睡(每夜一次)
  const hr = new Date().getHours();
  const night = hr >= 23 || hr < 7;
  if (hr >= 1 && hr < 5 && state === 'running' && slot.nightWarn !== dateStr(now)) {
    slot.nightWarn = dateStr(now);
    slot.nightCount = (slot.nightCount || 0) + 1;
    savePetState();
    if (!(ovr && ovr.until > now)) ovr = { text: '都 ' + hr + ' 点了…早点睡呀,明天再战', until: now + 4000 };
  }
  // 番茄钟
  let pom = null;
  if (pomEnd) {
    if (pomEnd > now) pom = { left: Math.max(1, Math.ceil((pomEnd - now) / 60000)) };
    else { pomEnd = 0; celebrateUntil = now + 1500; ovr = { text: '🍅 番茄钟到!休息一下,摸鱼 5 分钟~', until: now + 3600 }; }
  }
  // 点击内容包:全部内容随注入下发,页面本地即时回应(不依赖 CDP 回传,点击永不失灵)
  const clickPack = {
    dev: DEV_QUOTES,
    hungry: HUNGRY_LINES,
    greet: greetingLine(),
    sum: (stats && stats.sum) || '',
    lv: slot.lv, title: titleOf(slot.fed),
    wx: (WEATHER.txt && Date.now() - WEATHER.ts < 7200000) ? WEATHER.txt : null,
    hit: (HITOKOTO.text && Date.now() - HITOKOTO.ts < 3600000) ? { t: HITOKOTO.text, f: HITOKOTO.from } : null,
    checkin: slot.checkinDate === dateStr(new Date()) ? 1 : 0,
  };
  const ext = {
    sat,
    ach: (() => {
      let tc = { bash: 0, tools: 0 }; // 库统计(10s 缓存)
      try {
        if (now - (toolCountAt || 0) > 10000) {
          const conn2 = db();
          if (conn2) {
            toolCounts = {
              bash: conn2.prepare("SELECT COUNT(*) n FROM tool_usage WHERE tool_name='Bash'").get().n,
              tools: conn2.prepare('SELECT COUNT(*) n FROM tool_usage').get().n,
            };
            toolCountAt = now;
          }
        }
        tc = toolCounts || tc;
      } catch (_) {}
      return { list: ACH_DEFS.map((a) => ({ name: a.name, desc: a.desc, got: a.test(slot, tc) ? 1 : 0 })), got: ACH_DEFS.filter((a) => a.test(slot, tc)).length, total: ACH_DEFS.length };
    })(),
    pom, night: night ? 1 : 0, feedTick, pack: clickPack,
    checkin: { done: slot.checkinDate === dateStr(new Date()) ? 1 : 0, streak: slot.streak || 0 },
  };
  // 实时工作框:一个会话在跑就是老样子(阶段行 + 详情行);多个会话同时在跑时一段一段列出来,
  // 段与段之间由页面画虚线分隔,谁完工谁那一段自己消失。
  // 点击回应/喂食/番茄钟到点等 override 期间由页面隐藏它,结束自动回来。
  // 关键点:判据是"任意会话在忙"(busy),不是"这一个全局回合开关"——
  // 否则两个任务并行时,先完成的那一个会把另一个正在跑的回合一起关掉,气泡当场消失。
  const busySess = busyList(now);
  stepMultiRun(busySess, now);   // 多会话合并统计状态机(全部跑完后 Σ 胶囊变分段相加,见 multiRunStep)
  ext.work = (function () {
    if (state !== 'running') return null;
    const list = busySess;
    if (!list.length) return null;
    const MAXW = 3;                                  // 最多列 3 段,再多折叠成"…还有 N 个会话"
    const show = list.slice(0, MAXW);
    const dup = {};                                  // 两条会话标题撞了就用短 id 区分开
    for (const it of show) { const nm = it.title || ''; if (nm) dup[nm] = (dup[nm] || 0) + 1; }
    const items = show.map((it) => {
      const line = workLine(it.t, now);
      let nm = clipName(it.title);
      if (!nm || dup[it.title] > 1) nm = (nm ? nm + ' ' : '') + '#' + shortSid(it.sid);
      return { k: it.sid, n: nm, l2: line.l2, l3: line.l3 };
    });
    return { items, more: list.length - show.length, multi: items.length > 1 };
  })();

  const st = stats || { turn: '', cost: '', sum: '', sumCost: '', providerId: '', modelId: '' };
  resolveApi(st.providerId, st.modelId);          // 当前会话实际在用的 provider/模型
  // 余额/额度还没拿到就每 20 秒补试几次:刚启动那会儿 provider 可能还没认出来,
  // 一次查空就白等 3 分钟(点菜单刷新是 force=true,不走这里)——逻辑在 balance.retryBalance
  retryBalance(now);
  const curApi = B.getCurApi(), bal = B.getBal();
  const badges = [];
  if (st.turn) badges.push({ t: multiSum ? multiSum.turnTxt : st.turn + (st.cost ? ' ' + st.cost : ''), c: 'turn', w: multiSum ? 1 : 0 });
  if (st.sum) {
    // 多会话全部跑完后的汇总态:两个胶囊都分段相加(Σ累计与⚡本轮),长胶囊由页面在 + 号后自动换行
    badges.push({ t: multiSum ? multiSum.txt : st.sum + (st.sumCost ? ' ' + st.sumCost : ''), c: 'sum', w: multiSum ? 1 : 0 });
  }
  let balLine = '', lowBal = false;
  // 峰/谷只在"价格分峰谷"的 provider 上有意义(内置 DeepSeek);自定义 provider 单价不分峰谷就不标
  const peak = curApi.peakBased ? isPeakBJ(now) : null;
  const peakTxt = peak === null ? '' : (peak ? '·峰' : '·谷');
  const bAge = bal ? Math.round((now - bal.ts) / 60000) : 0;
  const bAgeTxt = bAge >= 1 ? '(' + bAge + '分前)' : '';
  if (bal && bal.providerId === (curApi.providerId || '')) {
    if (bal.kind === 'quota') {
      // 订阅额度:显示"已用 x%"(不是钱,所以不带峰谷标记)
      const used = Math.round(bal.used);
      const hot = used >= 90;
      const qTxt = '📊 用' + used + '%' + (bal.win ? '·' + bal.win : '') + bAgeTxt;
      lowBal = hot;
      badges.push({ t: (hot ? '⚠ ' : '') + qTxt, c: hot ? 'bal-low' : 'bal-ok' });
      balLine = qTxt + ' ' + bal.label + '额度' + (bal.level ? '(' + bal.level + ')' : '') +
        (bal.resetAt ? ' · ' + fmtReset(bal.resetAt - now) + '后重置' : '') + ' · 点击刷新';
    } else if (bal.kind === 'plan') {
      // 账号型订阅套餐(数据来自 ZCode 自己的日志):显示当前模型那份额度用了多少
      const it = pickPlanItem(bal.items, curApi.modelId);
      if (it) {
        const pct = it.total ? Math.round(((it.used || 0) / it.total) * 100) : 0;
        const hot = pct >= 90;
        const pAge = Math.max(0, Math.round((now - (bal.at || now)) / 60000));
        const pTxt = '📊 用' + pct + '%' + (pAge >= 1 ? '(' + pAge + '分前)' : '');
        lowBal = hot;
        badges.push({ t: (hot ? '⚠ ' : '') + pTxt, c: hot ? 'bal-low' : 'bal-ok' });
        balLine = pTxt + ' ' + it.name + (it.remain != null && it.total != null ? ' 剩 ' + fmtUnits(it.remain) + '/' + fmtUnits(it.total) : '') +
          (it.end ? ' · ' + fmtReset(it.end - now) + '后重置' : '') + ' · 点击刷新';
      }
    } else if (bal.kind === 'money' && bal.amt != null) {
      const balTxt = '余' + (bal.cur === 'USD' ? '$' : '¥') + bal.amt.toFixed(2) + peakTxt + bAgeTxt;
      lowBal = bal.amt < (bal.cur === 'USD' ? 1.5 : LOW_BALANCE);
      badges.push({ t: (lowBal ? '⚠ ' : '') + balTxt, c: lowBal ? 'bal-low' : 'bal-ok' });
      balLine = balTxt + (peak === null ? '' : (peak ? ' 峰时价' : ' 谷时价')) + (lowBal ? ' ⚠余额偏低' : '') + ' · 点击刷新';
    } else {
      // 这家没有余额接口:只报探活结果(HTTP 401 = key 不认;0 = 连不上)
      balLine = curApi.label + ':没有余额接口' + (bal.probe ? '(探活 HTTP ' + bal.probe + ')' : '(探活连不上)') + ' · 点击重试';
    }
  } else if (curApi.sub) {
    // 账号型订阅(account:xxx)且没从日志里捞到额度:老实说"只显示模型名"
    balLine = curApi.label + ':订阅套餐(账号登录,额度没读到) · 只显示模型名';
  } else if (curApi.key) {
    balLine = balInfoFor(curApi.providerId, curApi.modelId, curApi.def) ? '余额:获取中… · 点击刷新' : curApi.label + ':这家没内置余额接口(右键「添加 API」可填地址)';
  } else if (curApi.providerId) {
    balLine = curApi.label + ':没配 API key(查不了余额)';
  }
  // 当前模型(大名)+ 已知 API 清单,供气泡与右键菜单显示
  const curVid = currentSessionId(now);           // 统计/气泡当前跟的会话(菜单里标 ● 的那只)
  const apiInfo = {
    cur: curApi.label, sub: curApi.sub ? 1 : 0, model: curApi.modelId, pid: curApi.providerId,
    hasKey: curApi.key ? 1 : 0, billed: curApi.billed ? 1 : 0, peak: peak === null ? -1 : (peak ? 1 : 0),
    list: apiList(),
    seen: seenProviders(),
    auto: P.apiKeyIds().filter((k) => !defFor(k, '')),
    // 本会话按家拆账(菜单「💸 本会话」行;stats 为空/还没算出来时留空)
    provTxt: (stats && stats.provTxt) || '',
    // ZCode 自己那份套餐额度(给账号型订阅用;顺便便于排查有没有读到)
    plan: (() => { const p = readPlanQuota(); return p ? { at: p.at, items: p.items.map((i) => i.name + ' ' + (i.used || 0) + '/' + (i.total || 0) + (i.end ? ' 剩' + fmtReset(i.end - Date.now()) : '')) } : null; })(),
  };
  // 多会话时的「各会话」二级菜单:每个在跑的会话一行(会话名 + 模型大名 + 计费方式 + 该家余额/额度)。
  // 余额来自按 provider 的缓存(balCache);没查到的家由下面的补查循环去问,查到前这格留空。
  apiInfo.busy = busySess.map((it) => {
    let pid = it.t.provider || '', mid = it.t.model || '';
    if ((!pid || !mid) && it.sid === curVid && stats) { pid = pid || stats.providerId || ''; mid = mid || stats.modelId || ''; }
    const sub = /^account:/i.test(pid);
    const bb = pid ? B.balFor(pid) : null;
    let balTxt = '';
    if (bb && now - bb.ts < 120000) {
      if (bb.kind === 'money' && bb.amt != null) balTxt = '余' + (bb.cur === 'USD' ? '$' : '¥') + bb.amt.toFixed(2);
      else if (bb.kind === 'quota') balTxt = '📊 用' + Math.round(bb.used) + '%' + (bb.win ? '·' + bb.win : '');
      else if (bb.kind === 'plan') {
        const ip = pickPlanItem(bb.items, mid);
        if (ip) balTxt = '📊 用' + (ip.total ? Math.round(((ip.used || 0) / ip.total) * 100) : 0) + '%';
      } else if (bb.kind === 'none') balTxt = '无余额接口';
    }
    if (!balTxt && pid) balTxt = sub ? '额度没读到' : (P.getApiKey(pid) ? '获取中…' : '没配 key');
    return {
      sid: it.sid, n: clipName(it.title) || ('#' + shortSid(it.sid)), cur: it.sid === curVid ? 1 : 0,
      mdl: pid ? bigName(pid, mid) : '', sub: sub ? 1 : 0,
      billed: pid ? (!sub && !!priceFor(defFor(pid, mid), mid) ? 1 : 0) : 0,
      bal: balTxt, prov: sessStatsFor(it.sid, now).provTxt,
      usg: (() => { const s = sessStatsFor(it.sid, now); return (s.turn ? s.turn + ' · ' : '') + s.sum + (s.sumCost ? ' ' + s.sumCost : ''); })(),
    };
  });
  // 给在跑会话的各家 provider 补查余额(菜单用):内部有 25 秒 TTL,这里 5 拍一轮就够
  if (tick % 5 === 0) {
    for (const it of busySess) {
      const pid = it.t.provider || (it.sid === curVid && stats ? stats.providerId : '');
      if (!pid) continue;
      const mid = it.t.model || (it.sid === curVid && stats ? stats.modelId : '');
      const c = B.balFor(pid);
      if (c && now - c.ts < 120000) continue;       // 2 分钟内的缓存就算了,别反复打接口
      B.queryBalance(false, { providerId: pid, modelId: mid });
    }
  }
  ext.model = apiInfo;
  curState=state;curBadges=badges;curBalLine=balLine;curLowBal=lowBal;curExt=ext;
  const payload = state + '|' + JSON.stringify(badges) + '|' + balLine + '|' + JSON.stringify(ovr) + '|' + JSON.stringify(ext);
  const force = tick % 5 === 0;
  if (payload === lastPayload && !force) return;
  lastPayload = payload;

  let targets = [];
  try {
    targets = await new Promise((res, rej) => {   // 用 http.get(直连,已验证稳定),不用 fetch
      const rq = http.get(`http://127.0.0.1:${CDP_PORT}/json/list`, (rs) => {
        let d = ''; rs.on('data', (c) => (d += c)); rs.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
      });
      rq.on('error', rej); rq.setTimeout(2000, () => rq.destroy(new Error('timeout')));
    });
  } catch (e) { targets = []; try { fs.writeFileSync(path.join(DATA_DIR, '.tick-err.txt'), new Date().toISOString() + ' /json/list 失败: ' + (e && e.message)); } catch (_) { } }
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl && !/^devtools/.test(t.url || ''));
  const alive = new Set(pages.map((t) => t.id));
  for (const [id, ws] of sockets) {
    // 任何非 OPEN(1) 的状态(含 undici 幽灵态 -1)超过 5 秒都视为死连接,必须重建
    const stuck = (ws.readyState !== 1 || Date.now() - (ws.__born || 0) > 45000) && Date.now() - (ws.__born || 0) > 5000;
    if (!alive.has(id) || ws.readyState > 1 || stuck) {
      try { ws.close(); } catch (_) { }
      sockets.delete(id);
    }
  }
  for (const t of pages) {
    let ws = sockets.get(t.id);
    const age = ws ? Date.now() - (ws.__born || 0) : 0;
    // 只在「没有连接」或「连接已死/超龄」时重建;绝不在「仍在建立中」时推倒重来
    if (ws && (ws.readyState > 1 || (ws.readyState !== 1 && age > 20000) || (ws.readyState === 1 && age > 60000))) {
      try { ws.close(); } catch (_) { }
      sockets.delete(t.id);
      ws = null;
    }
    if (!ws) {
      ws = new WebSocket(t.webSocketDebuggerUrl);
      ws.__born = Date.now();
      bindName = '__tokPetEmit' + (++bindSeq); // 每次新会话换绑定名:旧会话遗留的同名绑定不会再吃掉事件
      setBindName(bindName);
      sockets.set(t.id, ws);
      attachSocket(ws);
      ws.addEventListener('open', () => { try { ws.send(JSON.stringify({ id: ++msgId, method: 'Runtime.addBinding', params: { name: bindName } })); } catch (_) {} });
    }
    if (ws.readyState !== 1) continue;  // 还在建立中:本拍跳过,下一拍再来(不销毁连接)
    sendErr = '';
    const jsTpl = petJs(state, badges, balLine, lowBal, ovr, ext);
    const sent = await sendTo(ws, jsTpl);
    if (!sent) {
      // 把 CDP 报的错记下来:页面模板是字符串,node --check 查不出里面的语法错,只会表现为"改了跟没改一样"
      try { fs.writeFileSync(path.join(DATA_DIR, '.inj-err.txt'), new Date().toISOString() + ' 注入失败: ' + (sendErr || 'unknown')); } catch (_) { }
      // 超时(渲染进程忙的时候 evaluate 偶发超过 3 秒)不代表连接死了 ⇒ 留着连接、下一拍继续注入;
      // 只有协议层真报错(m.error)才断开重连,否则会陷入"每拍重建连接"的抖动。
      if (sendErr !== 'TIMEOUT') { try { ws.close(); } catch (_) { } sockets.delete(t.id); }
    }
  }
}

let curState="idle",curBadges=[],curBalLine="",curLowBal=false,curExt=null;
let pollBusy=false;
async function fastPoll(){
  if(pollBusy)return;pollBusy=true;
  try{
    for(const [id,ws] of sockets){
      if(ws.readyState!==1)continue;
      const req=await sendTo(ws,"JSON.stringify({b:localStorage.getItem('tokPetBalReq')||'',c:localStorage.getItem('tokPetClickReq')||'',g:localStorage.getItem('tokPetSlug')||'',f:localStorage.getItem('tokPetFeedReq')||'',k:localStorage.getItem('tokPetCheckinReq')||'',p:localStorage.getItem('tokPetPomReq')||'',e:localStorage.getItem('tokPetEggReq')||'',a:localStorage.getItem('tokPetApiAddReq')||'',d:localStorage.getItem('tokPetApiDelReq')||''})",true);
      try{
        const rq=JSON.parse(req||"{}");
        const nb=parseInt(rq.b,10)||0,nc=parseInt(rq.c,10)||0,nf=parseInt(rq.f,10)||0,nk=parseInt(rq.k,10)||0,np=parseInt(rq.p,10)||0,ne=parseInt(rq.e,10)||0;
        const ra=String(rq.a||''),rd=String(rq.d||'');
        const FUTURE=Date.now()+60000; // 超过当前时间 1 分钟的通道值=被测试脚本污染的毒值,拒绝且不进基线(自愈)
        const ok=(v)=>v>0&&v<FUTURE;
        if(!fastPollPrimed){ // 重启后首拍:localStorage 里的陈旧请求只对齐基线,不触发(防幽灵喂食/点击)
          lastBalReqTs=ok(nb)?nb:0;lastClickReqTs=ok(nc)?nc:0;lastFeedReqTs=ok(nf)?nf:0;lastCheckinReqTs=ok(nk)?nk:0;lastPomReqTs=ok(np)?np:0;lastEggReqTs=ok(ne)?ne:0;lastApiAddRaw=ra;lastApiDelRaw=rd;fastPollPrimed=true;
        }
        if(rq.g&&rq.g!==curSlug)activatePet(rq.g);
        if(ok(nb)&&nb>lastBalReqTs&&emitTs.bal!==nb){lastBalReqTs=nb;emitTs.bal=nb;queryBalance();}
        if(ok(nc)&&nc>lastClickReqTs&&emitTs.click!==nc){lastClickReqTs=nc;emitTs.click=nc;onPetClicked();injectNow();}
        if(ok(nf)&&nf>lastFeedReqTs&&emitTs.feed!==nf){lastFeedReqTs=nf;emitTs.feed=nf;handleManualFeed();}
        if(ok(nk)&&nk>lastCheckinReqTs&&emitTs.checkin!==nk){lastCheckinReqTs=nk;emitTs.checkin=nk;handleCheckin();}
        if(ok(np)&&np>lastPomReqTs&&emitTs.pom!==np){lastPomReqTs=np;emitTs.pom=np;handlePom();}
        if(ok(ne)&&ne>lastEggReqTs&&emitTs.egg!==ne){lastEggReqTs=ne;emitTs.egg=ne;const eg=petSlot(curSlug);eg.eggs=(eg.eggs||0)+1;savePetState();}
        if(ra.length>3)handleApiAdd(ra);
        if(rd.length>1)handleApiDel(rd);
      }catch(_){}
    }
  }finally{pollBusy=false}
}
let bindSeq=0, bindName=null, sendErr='';
let lastBalReqTs=0,lastClickReqTs=0,lastFeedReqTs=0,lastCheckinReqTs=0,lastPomReqTs=0,lastEggReqTs=0,fastPollPrimed=false;
const emitTs = {}; // binding/localStorage 双通道去重
// 换宠物:顺带把新宠的饱食度衰减起点重置,否则它按"建槽至今的分钟数"一次性掉饱食度(长期没激活的宠物一换过去就饿)
function activatePet(slug) {
  if (!slug || slug === curSlug || !PETS.some((p) => p.slug === slug)) return false;
  curSlug = slug;
  petState.active = slug;
  petSlot(slug).lastDecayAt = Date.now();
  savePetState();
  return true;
}
// ---------- 手动添加 API(右键菜单「➕ 添加 API」) ----------
// 页面把表单内容(JSON 字符串)发过来 → 写进 pet-providers.json → 立刻生效,不用重启守护。
// 去重按"原文不同才算新请求"(不是时间戳),首拍对齐基线防重启后重放旧请求。
let lastApiAddRaw = '', lastApiDelRaw = '';
function numOr(v, d) { const n = parseFloat(v); return isFinite(n) ? n : d; }
// 单价字段可写「1」= 不分峰谷,或「0.02,0.04」= 谷价,峰价(数组形式沿用 DeepSeek 那套时段规则)
function priceVal(v) {
  const t = String(v == null ? '' : v).trim();
  if (t.indexOf(',') < 0 && t.indexOf(' ') < 0) return numOr(t, 0);
  const p = t.split(/[,\s]+/).filter((x) => x !== '').map((x) => parseFloat(x)).filter((n) => isFinite(n));
  return p.length >= 2 ? [p[0], p[1]] : (p.length ? p[0] : 0);
}
function handleApiAdd(raw) {
  const s = String(raw || '');
  if (!s || s === lastApiAddRaw) return;
  lastApiAddRaw = s;
  let o; try { o = JSON.parse(s); } catch (_) { ovr = { text: '⚠ API 配置内容坏了,没保存', until: Date.now() + 4000 }; return; }
  const label = String(o.label || '').trim(), match = String(o.match || '').trim();
  if (!label || !match) { ovr = { text: '⚠ 大名和匹配词都得填', until: Date.now() + 4000 }; return; }
  const def = { label, match };
  const k = String(o.key || '').trim(); if (k) def.key = k;
  const u = String(o.url || '').trim(); if (u) def.balanceUrl = u;
  const p = String(o.path || '').trim(); if (p) def.balancePath = p;
  const uu = String(o.usedUrl || '').trim(); if (uu) def.balanceUsedUrl = uu;      // 中转站那类:第二个接口取"已用"
  const sc = parseFloat(o.scale); if (isFinite(sc) && sc > 0 && sc !== 1) def.balanceScale = sc;
  const at = String(o.auth || '').trim(); if (at) def.balanceAuth = at;           // 鉴权头模板,默认 Bearer {key}
  if (['hit', 'miss', 'out'].some((x) => String(o[x] || '').trim() !== '')) {
    def.price = { hit: priceVal(o.hit), miss: priceVal(o.miss), out: priceVal(o.out) };
  }
  const i = P.upsertCustomDef(def);
  const ok = P.saveCustomDefs();
  if (ok) { P.refreshApiKeys(); const a = B.getCurApi(); B.resolveApi(a.providerId, a.modelId); B.invalidateBal(); B.queryBalance(); }
  ovr = { text: ok ? '✅ 已保存 ' + label + (i >= 0 ? '(覆盖旧的)' : '') : '⚠ 写 pet-providers.json 失败', until: Date.now() + 4000 };
  injectNow();
}
function handleApiDel(labelRaw) {
  const key = String(labelRaw || '').trim();
  if (!key || key === lastApiDelRaw) return;
  lastApiDelRaw = key;
  const removed = P.removeCustomDef(key);
  const ok = removed && P.saveCustomDefs();
  if (ok) { P.refreshApiKeys(); const a = B.getCurApi(); B.resolveApi(a.providerId, a.modelId); B.invalidateBal(); }
  ovr = { text: ok ? '🗑 已删除 ' + key : '⚠ 没找到自定义 API:' + key, until: Date.now() + 3500 };
  injectNow();
}
function handleEmit(k, v) {
  const t = parseInt(v, 10) || 0;
  if (k !== 'slug' && k !== 'apiadd' && k !== 'apidel' && t) { if (emitTs[k] === t) return; emitTs[k] = t; }
  switch (k) {
    case 'click': onPetClicked(); injectNow(); break;
    case 'feed': handleManualFeed(); break;
    case 'checkin': handleCheckin(); break;
    case 'pom': handlePom(); break;
    case 'bal': queryBalance(); break;
    case 'egg': { const eg = petSlot(curSlug); eg.eggs = (eg.eggs || 0) + 1; savePetState(); break; }
    case 'slug': activatePet(v); break;
    case 'apiadd': handleApiAdd(v); break;
    case 'apidel': handleApiDel(v); break;
  }
}
function attachSocket(ws) {
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.id && cdpPending.has(m.id)) {
      cdpPending.get(m.id)(m); cdpPending.delete(m.id);
    }
    else if (m.method === 'Runtime.bindingCalled' && m.params && m.params.name === bindName) {
      const s = String(m.params.payload || '');
      const i = s.indexOf('|');
      if (i > 0) { try { handleEmit(s.slice(0, i), s.slice(i + 1)); } catch (_) {} }
    }
  });
}
function injectNow(){
  for(const [id,ws] of sockets){ if(ws.readyState===1) sendTo(ws, petJs(curState,curBadges,curBalLine,curLowBal,ovr,curExt)); }
}
setInterval(fastPoll,250);
loadCustomDefs();
readProvider();
function tickSafe(){tickOnce().catch((e)=>{try{fs.writeFileSync(path.join(DATA_DIR,".tick-err.txt"),new Date().toISOString()+" "+((e&&(e.stack||e.message))||e))}catch(_){ }});}
setInterval(tickSafe, POLL_MS);
tickSafe();
setInterval(queryBalance, BAL_INTERVAL);
setTimeout(queryBalance, 5000);
setInterval(() => refreshHitokoto(false), 90000);
setTimeout(() => refreshHitokoto(true), 4000);
setInterval(() => refreshWeather(), 60000); // 成功后 30 分钟缓存;失败 ts 清零,60s 后重试
setTimeout(() => refreshWeather(), 8000);
// 吞掉但不装没看见:写进诊断文件,桌宠行为异常时好查(曾因静默吞错排查了半天)
process.on('uncaughtException', (e) => { try{fs.writeFileSync(path.join(DATA_DIR,'.uncaught-err.txt'),new Date().toISOString()+' '+((e&&(e.stack||e.message))||e))}catch(_){} });
process.on('unhandledRejection', (e) => { try{fs.writeFileSync(path.join(DATA_DIR,'.rej-err.txt'),new Date().toISOString()+' '+((e&&(e.stack||e.message))||e))}catch(_){} });

