---
description: 管理桌宠：搜 Petdex / 预览长相 / 装宠物 / 删宠物 / 切换当前宠物
argument-hint: [list | <关键词> | install <slug> | remove <slug> | switch <slug>]
allowed-tools: Bash, Read, Write, Edit
---

用户在管理 **ZCode 桌宠**（zcode-pet 插件：ZCode 窗口里的桌面宠物，CDP 注入实现）。

固定路径（本机，与当前工作区无关；若下面文件不存在，先确认 zcode-pet 插件已安装）：
- 装宠物工具：`~/.zcode/cli/plugins/cache/**/zcode-pet/*/scripts/pet-add.js`（单文件 Node，无依赖；优先用已安装插件里的这份，装好插件后 `~/.zcode/cli/plugins/installed_plugins.json` 里能查到 `installPath`）
- 宠物名单：`pet-add.js` 会自动解析的数据目录（插件模式下是 `~/.zcode/cli/plugins/data/zcode-pet/`，老版手动模式是 `~/.zcode/hooks/`）下的 `pets.json`（守护**启动时只读一次**）
- 守护进程：插件内 `src/daemon.js`（单例锁端口 9226，CDP 调试端口 9222；由插件的 MCP 入口随 ZCode 启动自动拉起）
- 养成存档：数据目录下 `pet-state.json`

按 `$ARGUMENTS` 判断意图并执行（用户可能写中文也可能写英文）：

- **空 / `list` / `列表`** → 跑 `node <pet-add.js> list`，报告装了哪几只、当前激活哪只。
- **`search <关键词>` 或直接给关键词**（如 `shiba`、`柴犬`、`cat`）→ 先 `search`，再挑最相关的 3–6 只跑 `preview <slug...>`（在**当前工作目录**生成 `pet-preview.png`），然后**用 Read 工具真的看一眼这张图**，把每只长什么样说出来让用户挑。必须提醒：Petdex 清单里名字与长相常对不上（搜 "shiba" 出来的 `shibao`/`aka-shiba` 是猫），**以预览图为准**。
- **`install <slug>` / `装 <slug>`** → 跑 `install <slug>`（工具会校验图片尺寸、写名单、自动重启守护）。装完用 CDP 验证：`http://127.0.0.1:9222/json/list` 取页面 target，`Runtime.evaluate` 读 `document.getElementById('tok-pet')` 的 `dataset.slug` 与 `backgroundImage`（可能需要先在页面里写 `localStorage['tokPetSlug']='<slug>'` 触发切换守卫）。截图或读气泡文本确认新宠物真的渲染出来，再报告。
- **`remove <slug>` / `删 <slug>`** → 先 `list` 确认删的是哪只，再 `remove <slug> --purge`；顺手把 `pet-state.json` 里 `pets['<slug>']` 这个存档槽删掉、确认 `active` 指向还存在的宠物。
- **`switch <slug>` / `切换 <slug>`** → 通过 CDP 往页面写 `localStorage['tokPetSlug']='<slug>'`（守护侧的下一次轮询会读到并切换），或直接告诉用户：右键宠物 → 切换宠物。

硬规矩：

1. 重启守护**只能**按 9226 端口定位 PID 再 `taskkill /PID <pid> /F`，**绝不能** `taskkill /IM node.exe`（会误杀别的 node 进程）。`pet-add.js` 已经这么做，优先用它的 `restart`。
2. 改完 `pets.json` 必须重启守护才生效（`PETS` 只在启动时读一次）。
3. 调试页面时往 `tokPet*Req` 这类 localStorage 通道写值，**只能用 `Date.now()` 量级的时间戳**；写大了（如 15 位）会永久压制真实请求，得重启守护才能恢复。
4. 预览图、调试脚本这类临时产物用完即删；如果保留 `pet-preview.png` 给用户看，报告里要说明。
