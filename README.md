# zcode-pet 桌宠 🐾

一只住在 **ZCode** 窗口里的像素桌宠（Petdex 素材），不是悬浮窗，而是直接注入在 ZCode 主窗口里：会跟着你干活的状态变换动作（干活狂奔、报错摔倒、摸头跳跃），身上挂着这一轮/本会话的 **token、费用、余额、订阅额度**胶囊，还有一整套**养成系统**（喂食、签到、等级、成就）。

> 也可以理解为：一个会撒娇的用量监控。代码由「单文件守护进程 + CDP 注入页面脚本」构成，无第三方依赖，Node 22+ 直接跑。

**English**: A pixel desktop pet living inside the ZCode window (injected via CDP), showing token usage / cost / balance / subscription-quota pills, with a tamagotchi-style raising system. Zero dependencies, Node 22+.

---

## 功能一览

| 模块 | 说明 |
| --- | --- |
| 用量胶囊 | `⚡本轮`、`Σ本会话`（token + 估算费用，只显示当前在用模型的账）；数据读 ZCode 用量库 `db.sqlite`（全部历史，会话文件被重写也不丢），读不到才回退 rollout 文件 |
| 多厂商计价 | 内置 15+ 家价格表（DeepSeek/GLM/Qwen/Kimi/豆包/文心/混元/MiniMax/阶跃 + OpenAI/Claude/Gemini/Grok/Mistral/Llama），自动识别当前 provider/model；DeepSeek 峰谷价含法定节假日全天谷（每年 11 月需补次年日期表） |
| 余额 / 订阅额度 | 有 API key 的家：调厂商接口查充值余额或 Coding Plan「窗口已用%+重置倒计时」；**账号登录的订阅**（key 加密拿不到）：从 ZCode 自己的日志里读套餐额度，同模型多份额度自动挑「正在用的那份」 |
| 💸 本会话明细 | 右键菜单里按厂商拆账（如 `¥1.27(DeepSeek ¥0.943 · Qwen ¥0.163)`），费用逐行按各家的价算，订阅行 ¥0 |
| 养成系统 | 饱食度（3 分钟 -1，按 token 自动投喂）、成长值/等级（15 级称号）、18 枚成就、每日签到、连续签到、戳晕彩蛋 |
| 实时状态 | 有会话在跑时气泡显示正在跑的命令/工具（Bash、Edit…）或「🤔 思考中」+ 模型名与已用时长；**多个会话并行时一个会话占一段**（写清会话标题，段间棕色虚线分隔，最多 3 段、多的折成「…还有 N 个会话在跑」），某个会话干完它那一段立刻消失，全部停下来才回到 token 胶囊 |
| 互动 | 摸头跳跃、拖拽换方向、空闲散步（走完自己恢复原动作）、工具调用反应（🔧 敲敲敲…）、天气（wttr.in 全中文）、一言、番茄钟、深夜劝睡 |
| 多宠物 | Petdex 清单 4800+ 只：`search / preview / install / remove` 一条命令装宠物，每只独立存档 |

## 安装

### 0. 前置条件（只做一次）

桌宠靠 CDP 注入，ZCode 必须带调试端口启动：给 ZCode 的快捷方式目标追加

```
 --remote-debugging-port=9222
```

Node ≥ 22（`node -v` 确认；Windows 自带的 `node:sqlite` 需要它）。

### 1a. 以插件方式安装（推荐）

本仓库根就是一份 ZCode 插件市场清单，两种装法：

- **从 GitHub 装**：插件市场 → 添加 → 添加插件市场 → 粘贴本仓库地址（`https://github.com/LLh-xuesj/zcode-pet`）→ 在个人市场里找到「桌宠」→ 安装。
- **从本地目录装**：克隆仓库后，添加插件市场时粘贴仓库文件夹路径即可。

装好后：ZCode 每次启动会自动通过插件的 MCP 入口拉起守护进程（幂等，不会双开），数据目录在 `~/.zcode/cli/plugins/data/<市场名>-后缀目录`（安装时自动决定，右键菜单/工具里看得到）。

### 1b. 不装插件、直接跑

```bash
node src/daemon.js
```

数据目录默认 `~/.zcode/hooks/`（想换位置设环境变量 `PET_CHIP_DATA`）。想开机自启就自己加个启动项，例如 Windows 在启动文件夹放一个：

```vbs
Set ws = CreateObject("WScript.Shell")
ws.Run "node C:\path\to\zcode-pet\src\daemon.js", 0, False
```

### 2. 装宠物（下载精灵图）

精灵图不在仓库里（素材来自 [Petdex](https://petdex.dev)，4800+ 只，版权归各自作者）。装好插件后**直接在 ZCode 对话里输 `/pet` 命令**最省事：

```text
/pet list            看装了哪几只、当前激活哪只
/pet 柴犬            按关键词找，AI 会拉出预览图帮你挑长相
                     （Petdex 名字与长相常对不上，以预览图为准）
/pet install shiba   装（校验尺寸 → 写名单 → 自动重启守护）
/pet switch shiba    切换当前宠物
/pet remove shiba    移除（加 --purge 连素材一起删）
```

不想进对话、想手动操作的话，用自带的命令行工具（无依赖，数据目录自动识别）：

```bash
node scripts/pet-add.js list                 # 看装了哪几只
node scripts/pet-add.js search 柴犬           # 关键词找（中英文都行）
node scripts/pet-add.js preview shiba piyo   # 生成缩略图先看长相
node scripts/pet-add.js install shiba        # 装
node scripts/pet-add.js restart              # 只重启守护
```

## 使用

装好后 ZCode 窗口右下角就会出现宠物。**左键**摸头（随机台词/天气/一言）、**连点 4 次**戳晕彩蛋、**拖拽**换方向并记忆位置、**右键**菜单：

```
🤖 当前模型:DeepSeek · API 按量
💰 余¥13.57·谷 · 点击刷新
🤖 各会话模型/余额(2) ▸        ← 多个会话同时在跑时才出现
💸 本会话 ¥1.27(DeepSeek ¥0.943 · Qwen ¥0.163 · GLM ¥0.160)
🐾 切换宠物(当前:Boba 小水獭) ▸
🍖 喂食(饱食 54%)      📅 已签到(连签 2 天)
🍅 番茄钟 25 分钟      🏆 成就墙(10/18)
➕ 添加 API(多模型计价/余额)
🔍 调整大小(40/55/75/100%)   🙈 隐藏
```

「➕ 添加 API」面板：自动列出 ZCode 里配过 key 的厂商（点一下自动填），手填单价/余额接口即可；也可给 ZCode 内置表没有的模型补价。

## 配置

所有数据文件都在数据目录（插件模式 `~/.zcode/cli/plugins/data/zcode-pet/`）：

| 文件 | 说明 |
| --- | --- |
| `pets.json` | 宠物名单（`pets.json.example` 有格式说明），守护启动时读一次 |
| `pet-state.json` | 养成存档（饱食度/成长值/签到/成就），自动生成，删掉即重置 |
| `pet-providers.json` | 你手填的自定义 API（大名/匹配词/单价/余额接口） |
| `pet-<slug>/sprite.webp` | 精灵图（8 列 × 192px，帧高 208，`rows`=高/208） |

改价格表/峰谷日期/投喂换算：在 `src/pricing.js`（`BUILTIN_DEFS`、`HOLIDAY_VALLEY`）与 `src/pet-state.js`（`FEED_TOK_PER_POINT` 等）里，都有注释标明调参点。

## 原理（一分钟版）

```
守护进程(daemon.js, 1s 心跳)
  ├─ 读 ~/.zcode/cli/db/db.sqlite 的 model_usage 表 → token/费用/养成投喂(权威)
  ├─ 读 ~/.zcode/v2/logs/*.log → 账号订阅的套餐额度(ZCode 自己查好写下的)
  ├─ 读厂商余额接口 → 充值余额 / Coding Plan 窗口用量
  ├─ 读 ~/.zcode/cli/log/zcode-<日期>.jsonl 的 turn/工具事件(每行带 sessionId)
  │    → 按会话各记一份"回合开着没"→ 实时工作气泡(每个在跑的会话一段,段间虚线)
  │       会话标题查 db.sqlite 的 session 表(60 秒缓存);统计跟着当前会话走
  └─ CDP(127.0.0.1:9222) 每拍注入页面脚本 → 宠物/气泡/菜单/动画
页面脚本 ↔ 守护:localStorage 键 + CDP Binding 双通道(点击/喂食/签到/加 API)
单例锁:127.0.0.1:9226(重复启动自动退出;MCP 入口靠它幂等拉起,并每 30 秒巡检一次、掉了自动重拉)
```

## FAQ（常见问题）

| 现象 | 处理 |
| --- | --- |
| 宠物不见了 | `netstat -ano \| findstr 9226` 看守护在不在（MCP 入口每 30 秒巡检，掉了会在半分钟内自动重拉；也可 `node scripts/pet-add.js restart`）；在则多半是 ZCode 没带 `--remote-debugging-port=9222` 启动，或右键点过「隐藏」（重开窗口 / 重启 ZCode 就回来） |
| 多个会话同时在跑，气泡/数字会不会串 | 不会。实时工作气泡的判据是"**任意**会话的回合还开着"，且每个在跑的会话在工作框里占一段（会话标题 + 它自己的工具/耗时）—— 两个任务并行时先做完的那个**只让它那一段消失**，不碰别人；token 统计认"最近发起回合的那个会话"，并粘住不来回跳。会话名显示成 `#xxxxxx` = 库里还没给这个会话记标题（新会话/探针会话），退回短 id；改过标题最多 1 分钟生效（60 秒缓存） |
| 数字不动 / 费用不显示 | 订阅套餐（`account:` 开头）本就不显示费用（只显示 token 与套餐额度）；别家没配单价也只显示 token |
| Σ 的费用看着不对 | 费用是**逐行**按每个请求自己的 provider/模型计价的，订阅行 ¥0；钱花在哪家看菜单「💸 本会话」 |
| 喂食没反应 | 20 秒冷却或饱食度已满，正常 |
| 想彻底重置养成 | 关守护，删 `pet-state.json`，再启动（会按库中历史重新折算已完成的轮次） |

更多实现细节（注入版本守卫、余额描述表字段、排障清单）见 [docs/zh-CN/说明.md](docs/zh-CN/说明.md)。

## 目录结构

```
zcode-pet/
├─ .zcode-plugin/plugin.json   # 插件清单(mcpServers 负责随 ZCode 启动拉起守护)
├─ marketplace.json            # 让本仓库可被"添加为插件市场"
├─ mcp/server.js               # MCP 入口:幂等拉起守护 + pet_status 诊断工具
├─ src/
│  ├─ config.js                # 路径/常量/数据目录(含一次性迁移)
│  ├─ pricing.js               # 价格表、峰谷节假日、provider 识别、自定义 API
│  ├─ balance.js               # 余额/订阅额度(厂商描述表 + 日志兜底)
│  ├─ usage.js                 # 用量库统计 + rollout 兜底
│  ├─ pet-state.js             # 养成:等级/成就/存档(原子写)
│  ├─ weather.js               # wttr.in 全中文天气
│  ├─ page.js                  # 注入页面的模板(VER/MENUV/CLAMPV 版本守卫)
│  └─ daemon.js                # 主循环:CDP 注入/事件/投喂
├─ scripts/pet-add.js          # Petdex 装宠物 CLI
└─ commands/pet.md             # /pet 斜杠命令(装/删/切宠物)
```

## 致谢

- 精灵素材与帧约定：[Petdex](https://petdex.dev)（素材归各自作者所有，本项目不打包分发）
- 余额/额度的「厂商描述表」设计参考了 [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)（DSH 小鲸鱼挂件）

## License

[MIT](LICENSE)
