# Changelog

## 0.1.0 (2026-10-03)

首个开源版本。由长期在用的单文件守护进程（pet-chip.js，约 2200 行）重构而来：

### 结构

- 拆分为 8 个职责单一的模块（config / pricing / balance / usage / pet-state / weather / page / daemon），纯 CommonJS，零依赖。
- 以 ZCode 插件形式分发：manifest 的 `mcpServers` 让 ZCode 每次启动自动幂等拉起守护进程（学自 zcode-beautify），并提供 `pet_status` 诊断工具。
- 数据目录支持 `PET_CHIP_DATA` 环境变量；首次以插件数据目录运行时自动从老位置（`~/.zcode/hooks`）迁移存档/名单/自定义 API/精灵素材（只复制不删除）。
- `/pet` 斜杠命令随插件分发。

### 修复与改进

- 养成存档改原子写（临时文件 + rename），写入中途被读不再可能拿到半截 JSON。
- `uncaughtException` 不再静默吞掉，写诊断文件。
- 页面模板的不变量（FRAMES/PAGE_CSS/PETS）预序列化，注入不再每拍重复 stringify。
- 删除死代码：`entryCost`、`FW/FH`、`isDS`、模板内未用的 `var LOW`。

### 功能（与重构前一致）

- token/费用/余额/套餐额度胶囊，多厂商计价（内置 15+ 家价格表，DeepSeek 峰谷 + 法定节假日），逐行按各家计价，Σ 只显示当前在用模型的账，菜单「💸 本会话」按家拆账。
- 账号登录订阅的套餐额度从 ZCode 日志读取（分段回翻最多 8MB + 12 小时兜底），多份额度自动跳过已用尽的。
- 养成系统：投喂按轮增量记账（fedCred）、15 级、18 成就、签到、番茄钟、天气全中文、散步、工具反应、戳晕彩蛋。
- Petdex 装宠物 CLI（search/preview/install/remove/restart）。
