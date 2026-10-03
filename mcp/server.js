#!/usr/bin/env node
// mcp/server.js — zcode-pet 插件的 MCP 入口。
// ZCode 每次 App 启动都会拉起这里(manifest 的 mcpServers);第一件事是"顺手"把常驻守护进程
// 幂等地拉起来(健康检查 9226 单例锁端口,不在跑才 spawn 脱管进程)。这一招学自 zcode-beautify。
// 之后本进程作为标准 MCP stdio server 存活,只暴露一个 pet_status 诊断工具。
'use strict';
const net = require('net');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = __dirname;
const DATA_DIR = process.env.PET_CHIP_DATA
  || path.join(process.env.USERPROFILE || process.env.HOME, '.zcode', 'cli', 'plugins', 'data', 'zcode-pet');
const DAEMON = path.join(ROOT, '..', 'src', 'daemon.js');
const LOCK_PORT = 9226;

function portAlive(port, ms) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = (v) => { try { s.destroy(); } catch (_) {} resolve(v); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    setTimeout(() => done(false), ms);
  });
}

// 幂等拉起:9226 没人听才 spawn;守护自己也有单例锁,双保险
async function ensureDaemon() {
  try { if (await portAlive(LOCK_PORT, 800)) return 'already-running'; } catch (_) { }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    cp.spawn(process.execPath, [DAEMON], {
      detached: true, stdio: 'ignore', windowsHide: true,
      cwd: DATA_DIR,
      env: Object.assign({}, process.env, { PET_CHIP_DATA: DATA_DIR }),
    }).unref();
    // 给它一点起跑时间再确认一次
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 300));
      try { if (await portAlive(LOCK_PORT, 500)) return 'spawned'; } catch (_) { }
    }
    return 'spawn-uncertain';
  } catch (e) {
    return 'spawn-failed: ' + (e && e.message);
  }
}

function petStatus() {
  const j = (f) => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch (_) { return null; } };
  const state = j('pet-state.json');
  const pets = j('pets.json');
  return JSON.stringify({
    dataDir: DATA_DIR,
    daemonScript: DAEMON,
    daemonScriptExists: fs.existsSync(DAEMON),
    lockPort: LOCK_PORT,
    active: state && state.active,
    pets: pets ? pets.map((p) => ({ slug: p.slug, name: p.name, rows: p.rows })) : null,
    petSlots: state && state.pets ? Object.fromEntries(Object.entries(state.pets).map(([k, v]) => [k, { lv: v.lv, sat: v.sat, fed: v.fed, turns: v.turns }])) : null,
    customProviders: (() => { const p = j('pet-providers.json'); return p ? p.map((x) => x.label) : null; })(),
  }, null, 2);
}

// ---------- 极简 MCP stdio server(无第三方依赖) ----------
const TOOLS = [{
  name: 'pet_status',
  description: '查看 ZCode 桌宠守护进程状态:数据目录、当前宠物、养成存档、自定义 API 清单',
  inputSchema: { type: 'object', properties: {}, required: [] },
}];

function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return null;
  if (msg.method === 'initialize') {
    return {
      id: msg.id, jsonrpc: '2.0',
      result: {
        protocolVersion: msg.params && msg.params.protocolVersion ? msg.params.protocolVersion : '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'zcode-pet', version: require('../package.json').version },
      },
    };
  }
  if (msg.method === 'tools/list') {
    return { id: msg.id, jsonrpc: '2.0', result: { tools: TOOLS } };
  }
  if (msg.method === 'tools/call' && msg.params && msg.params.name === 'pet_status') {
    let text;
    try { text = petStatus(); } catch (e) { text = 'pet_status 失败: ' + (e && e.message); }
    return { id: msg.id, jsonrpc: '2.0', result: { content: [{ type: 'text', text }], isError: false } };
  }
  if (msg.id !== undefined && msg.method) {
    return { id: msg.id, jsonrpc: '2.0', error: { code: -32601, message: 'Method not found: ' + msg.method } };
  }
  return null;   // notification(initialized 等):不回
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch (_) { continue; }
    const resp = handleMessage(msg);
    if (resp) process.stdout.write(JSON.stringify(resp) + '\n');
  }
});
process.stdin.on('end', () => process.exit(0));
process.on('uncaughtException', () => { });   // MCP 入口绝不能崩:崩了 ZCode 可能重连风暴

ensureDaemon().then((r) => {
  try { fs.appendFileSync(path.join(DATA_DIR, 'mcp-bootstrap.log'), new Date().toISOString() + ' ' + r + '\n'); } catch (_) { }
});
