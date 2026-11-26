# 任务单 001：自绘多人共享养鱼网页应用（Draw & Raise Fish）完整落地

> **必读前置文档**：开始编码前，必须先通读仓库根目录下的 `GLOSSARY.md` 以及 `docs/adr/` 下的 4 份架构决策记录（`0001`～`0004`），严格遵守其中的领域术语、边界与架构取舍。

---

## 一、开发目标

从零构建一个完整可运行的 TypeScript 全栈单仓网页应用，实现“多人公共共享鱼缸 + 参考图风格手绘画板 + 水面撒食全员物理抢食 + 五维属性自由加点 + 吃撑 1 小时消化循环”的完整产品闭环。

### 1.1 技术栈与运行形态（遵循 ADR-0004）
- **包管理器与运行环境**：`pnpm` + Node.js v24（仓库已确认本机可用 `node:sqlite` 的 `DatabaseSync` 与 `pnpm`）。
- **前端**：Vite + React 19 + TypeScript + HTML5 Canvas 2D（可选 Tailwind CSS 或精炼模块化 CSS，但务必打造精致的深海微光治愈风暗色半透明圆润 UI，桌面/平板横屏优先，底层 Pointer Events 统一兼容鼠标、触控板与手写笔）。
- **后端**：Node.js + Hono (`hono` + `@hono/node-server`) + Node 内置 `node:sqlite`（WAL 模式，零原生 C++ 编译依赖）+ 本地静态透明 PNG 存储（默认 `${DATA_DIR}/fish/${fishId}.png`，支持通过 `DATA_DIR` / `DB_PATH` 环境变量覆盖以便测试隔离）。
- **单进程启动**：
  - 开发态：`pnpm dev`（并行启动前端 Vite 代理 `/api` 到后端，以及后端 Node 服务）。
  - 生产态：`pnpm build` 构建前端至 `dist/`，再由 `pnpm start`（单进程 Node 服务）同时托管 `/api/*` 与静态前端资源及 SPA fallback。

### 1.2 核心领域规则（必须抽离到 `shared/domain.ts` 供前后端共用，且 100% 单元测试覆盖）

所有按“自然日零点重置”的逻辑统一以 `Asia/Shanghai` 自然日 `YYYY-MM-DD` 计算，且所有依赖当前时间的函数必须接受可注入的 `nowMs: number` 参数便于确定性单测：

1. **核心配额与上限常量**：
   - `DAILY_RATION_LIMIT = 3`：每位养鱼人（Keeper）每个自然日固定 3 次有效投喂配额，次日 00:00 重置，不跨天累加。
   - `MAX_ACTIVE_FISH_PER_KEEPER = 3`：每位养鱼人同时在公共鱼缸活跃的鱼最多 3 条；满额需通过“深海归档”将旧鱼移入个人图鉴后方可继续下水新鱼。
   - `TANK_VIEW_LIMIT = 35`：单屏水域切片最多同时展示 35 条鱼。
   - `DAILY_SATIETY_CAP = 6`：单条未满级鱼每个自然日最多将 6 颗鱼食转化为有效升级经验。
   - `REPORT_HIDE_THRESHOLD = 3`：累计被 3 名不同养鱼人举报后自动从公共视野隐藏。

2. **阶梯递增升级、成长阶段与尺寸归一化**：
   - 初生等级 `Lv.1`，满级 `Lv.11`（`MAX_LEVEL = 11`）。
   - 阶梯递增经验公式：从 `Lv.n` 升到 `Lv.n + 1` 需要 `n` 颗有效鱼食（即 `Lv.1→2` 需 1 颗，`Lv.2→3` 需 2 颗，……，`Lv.10→11` 需 10 颗；累计 `1+2+...+10 = 55` 颗有效鱼食达到满级封顶）。
   - 每次升级产出 **1 个自由属性点**，满级共获得 **10 个属性点**。
   - 成长阶段（Growth Stage）与等级映射：
     - `Lv.1 ~ Lv.2`：`fry`（鱼苗）
     - `Lv.3 ~ Lv.5`：`juvenile`（幼鱼）
     - `Lv.6 ~ Lv.9`：`adult`（成鱼）
     - `Lv.10 ~ Lv.11`：`leviathan`（鱼王）
   - 视觉尺寸曲线：初生鱼苗最长边归一化约 `40px`，随累计有效吃食数 `0..55` 平滑递增至满级约 `260px`（保证每一颗有效鱼食都带来平滑体型增长，不饿瘦不死亡）。

3. **五维属性加点与每日 1 次免费洗点**：
   - 五个属性维度：`burst`（爆发力）、`stamina`（耐力）、`sense`（感知力）、`agility`（灵巧度）、`brawn`（冲撞力）。
   - 单项属性范围 `0..6`（`MAX_STAT_VALUE = 6`，五维总容量 30，而满级仅 10 点，强制流派分化）。
   - 仅鱼主人可分配未用属性点，他人点开鱼档案卡可只读围观五维流派面板。
   - 每条鱼每个自然日最多免费洗点（重置全部已分配点数并返还 `level - 1` 点）**1 次**（通过 `lastRespecDate` 记录并校验）。

4. **全员抢食下的“吃撑减速 → 1 小时消化”时间状态机**：
   - 只要鱼当前实时计算的 `stuffedStacks < 3`，均会参与水中鱼食争抢。
   - **当未满级鱼当日有效吃食 `< 6`**：吃掉鱼食获得 `+1` 有效经验（触发升级判定与体型增长），`stuffedStacks` 不变。
   - **当未满级鱼当日有效吃食已满 `6/6`，或该鱼已满级（`Lv.11`）**：吃掉鱼食**不增加经验与体型**，而是叠加 1 层吃撑状态：`nextStacks = Math.min(3, currentEffectiveStacks + 1)`，更新 `stuffedUpdatedAt = nowMs`。
   - **基于时间戳的实时消化衰减规则**（`getDigestionState(rawStacks, stuffedUpdatedAt, nowMs)`）：
     - 若 `rawStacks >= 3`（“撑不动了”禁食态）：经过 **60 分钟（`3600_000ms`）** 消化冷却后直接恢复清零为 `0` 层，可再次进食；冷却期间保持 `3` 层并输出剩余消化秒数 `digestionRemainingSec`。
     - 若 `rawStacks` 为 `1` 或 `2`（未撑瘫的轻度吃撑）：每经过 **20 分钟（`1200_000ms`）** 自然消退 1 层（直到归零），并可输出距离下一层消退的剩余时间。
   - **物理负反馈系数**：
     - `0` 层：速度与转向 `100%`，正常抢食；
     - `1` 层：速度与转向降至 `65%`（减速 35%），冒出打饱嗝提示；
     - `2` 层：速度与转向降至 `30%`（减速 70%），明显笨重乏力；
     - `3` 层：彻底“吃不动了”，停止一切索敌与抢食，以 `25%` 慢速懒洋洋漂浮并显示消化倒计时气泡。

---

### 1.3 后端 API 与实时同步契约（`server/`）

- **身份与防刷（ADR-0003）**：
  - `GET /api/keeper/me`：未注册时返回 `{ keeper: null }`（围观免登录）；已持有有效 HttpOnly Cookie 时返回 Keeper 信息、当日剩余配额 `remainingRations`（扣除当日已结算与未过期活跃 pellet）、活跃鱼列表（含实时消化状态）、深海归档图鉴列表。
  - `POST /api/keeper/register`：`{ nickname }`（1~16 字），受服务端 IP 每日新建身份限流保护（如单 IP 每日最多注册 8 个身份，可通过环境变量配置放宽用于压测），生成唯一可读通行码（如 `FISH-XXXX-XXXX-XXXX`），签发 `HttpOnly; SameSite=Lax; Path=/` Cookie。
  - `POST /api/keeper/recover`：`{ passcode }`，校验通行码并签发对应 Keeper 的 Cookie 实现跨设备恢复。
  - `POST /api/keeper/nickname`：允许已登录 Keeper 修改昵称。

- **鱼与水域切片**：
  - `GET /api/tank/view?focusFishId=&excludeIds=`：返回至多 35 条 `status='active' AND is_hidden=0` 的鱼，优先级：`focusFishId`（若有且未隐藏） → 当前 Keeper 自己的所有在缸鱼 → 近期活跃与随机混排补齐至 35 条；每条鱼都经实时消化函数计算最新 `stuffedStacks`、`digestionRemainingSec`、`dailyFedCount`（若跨天自动按 0 返回）。
  - `GET /api/fish/search?q=`：按鱼名或创作者昵称搜索公共鱼缸活跃鱼（最多 20 条）。
  - `GET /api/fish/:id`：返回单鱼完整档案（含最近 10 条进食记录）。
  - `POST /api/fish`：校验 Keeper、在缸活跃鱼 `< 3`、鱼名 `1~16` 字、合法透明 PNG Base64（校验 PNG 魔数头、体积 `<= 512KB`、宽高合规），落盘 `${DATA_DIR}/fish/${id}.png`，插入 `Lv.1` 鱼记录，通过 SSE 广播 `fish_released`。
  - `GET /api/assets/fish/:id.png`：校验安全 ID（防目录穿越）并返回本地 PNG 文件。
  - `POST /api/fish/:id/archive`：仅主人可操作，将 `status` 设为 `archived`，SSE 广播 `fish_archived`。
  - `POST /api/fish/:id/stats`：`{ burst, stamina, sense, agility, brawn }` 增量分配，事务校验主人身份、非负整数、总增量 `<= unspentPoints`、分配后单项 `<= 6`，SSE 广播 `fish_updated`。
  - `POST /api/fish/:id/stats/reset`：仅主人可操作，校验今日尚未洗点，重置五维为 0 并返还全部 `level - 1` 点数，更新 `last_respec_date`，SSE 广播 `fish_updated`。
  - `POST /api/fish/:id/report`：需 Keeper 身份，防同一 Keeper 重复举报；达到 `REPORT_HIDE_THRESHOLD (3)` 时自动 `is_hidden = 1` 并 SSE 广播 `fish_hidden`。
  - `DELETE /api/admin/fish/:id`：校验请求头 `X-Admin-Secret` 匹配 `process.env.ADMIN_SECRET`（未设置环境变量时一律返回 403），强制隐藏/删除违规鱼并 SSE 广播 `fish_hidden`。

- **两阶段撒食物理争抢结算（ADR-0002）**：
  - `POST /api/pellets/drop`：`{ x, y }`（`0..1` 归一化坐标）。校验 Keeper 身份、IP 投喂频控、清理已过期未结算 pellet、校验 `当日已 consumed 数 + 当前未过期 pending 数 < 3`，创建 `status='pending'`、`expires_at = now + 90_000` 的 pellet 返回 `{ pelletId, x, y, expiresAt, remainingRations }`（注意：未消费前若关闭网页，90 秒后自动过期释放，不永久扣除配额）。
  - `POST /api/pellets/:pelletId/claim`：`{ winnerFishId }`。单事务内原子校验：pellet 存在且属于当前 Keeper、状态为 `pending` 且未过期；`winnerFish` 存在、`active`、未隐藏、且实时 `stuffedStacks < 3`；标记 pellet 为 `consumed`；结算鱼的经验/升级/属性点或吃撑层数与时间戳；返回 `{ outcome: 'grew' | 'leveled_up' | 'stuffed' | 'stuffed_full', fish, remainingRations, levelDelta }` 并通过 SSE 广播 `pellet_consumed`。
  - `POST /api/pellets/:pelletId/cancel`：允许前端切换水域或卸载页面时主动取消未吃掉的 `pending` pellet 立刻释放配额。
  - `GET /api/events`：SSE 事件流（`text/event-stream`），25 秒心跳保活，推送 `fish_released`、`fish_archived`、`fish_hidden`、`fish_updated`、`pellet_consumed`。

- **冷启动体验**：若数据库启动时完全为空，可考虑是否保留纯净空缸并给出清晰引导“成为第一个下水画鱼的人！”（或者提供 3~5 条内置系统演示鱼，标记 `is_system` / 属于系统养鱼人“深海管理员”，确保首次打开鱼缸就能直接看到鱼游动、体验撒食抢食与冲撞！**要求：内置 5 条精美的程序生成透明 PNG 演示鱼作为初始种子鱼**——确保首次打开网页立刻有活鱼游动与抢食体验，同时保留用户自由画鱼与全功能流转！注意演示鱼不占用真实玩家的槽位）。

---

### 1.4 前端体验与视觉实现（`src/`）

1. **公共鱼缸主场景（`src/tank/`）**：
   - **深海微光治愈风**：深海蓝渐变水体、顶部摇曳阳光折射光束（God rays）、缓慢上浮的气泡粒子、底部柔和摇曳的水草与砂石剪影；全套半透明深色圆润玻璃面板 UI。
   - **2D 网格正弦波摆尾渲染（`src/tank/meshRenderer.ts`，ADR-0001）**：
     - 将每条鱼的透明 PNG 沿水平方向切分为 16 条垂直切片，按从左（鱼头，振幅最小）到右（鱼尾，振幅最大）的权重施加正弦波垂直偏移模拟自然游动；
     - 鱼向右游时执行平滑水平翻转（`scaleX` 过渡避免生硬闪翻）；
     - 冲刺时加快摆尾频率并拖出微气泡尾迹；吃撑 1~2 层时鱼体微鼓/动作迟缓；吃撑 3 层时头顶浮现“撑不动了 + 剩余分钟”气泡；
     - 自家在缸鱼头顶带柔和微光小标识，便于在 35 条鱼中一眼辨认。
   - **物理与 AI 引擎（`src/tank/physics.ts`，须独立纯 TypeScript 模块便于单元测试）**：
     - 日常巡游：平滑曲线游动，边界柔和折返，鱼群彼此柔和错身不互撞；
     - 撒食下沉：鱼食投放在点击坐标 `(x, y)` 处，缓缓下沉，到达缸底沙地后静止停留直到被某条非撑瘫鱼嘴部碰撞吃掉；
     - 五维属性真实驱动：
       - `sense`（感知力）：索敌半径与发现反应延迟；
       - `burst`（爆发力）：追食最高瞬时冲刺速度；
       - `stamina`（耐力）：冲刺耐力槽上限与恢复速率（冲刺消耗耐力，耗尽进入短喘气减速）；
       - `agility`（灵巧度）：急转弯角速度与起步加速度；
       - `brawn`（冲撞力）：**仅在追食冲刺态下**触发鱼身碰撞挤推，结合 `brawn + 体型吨位` 施加推开冲量并短暂打断被撞者的冲刺；
     - 自然体型负重：体型越大基础转身惯性与冲刺耗耐略增，确保 `Lv.1` 轻盈小鱼苗在贴脸投喂时抢得到第一口粮；
     - 吃撑负反馈：1 层 `-35%`、2 层 `-70%`、3 层彻底放弃索敌停抢并慢速漂浮；
     - 吃食触发回调：仅由投放该鱼食的本地客户端判定吃食碰撞并调用 `/api/pellets/:id/claim`，收到服务端结果后在鱼身弹出对应浮字（`+1 成长` / `✨ Lv.Up! 获得属性点` / `🫧 嗝~ 吃撑了` / `💤 撑不动啦`）。
   - **交互与防误触控件**：
     - 顶部栏：品牌标题、水域鱼数、“换一片水域”按钮、鱼名搜索框（含下拉直达）、“定位我的鱼”、音效静音开关、一键隐藏 UI 沉浸屏保开关（按 `Esc` 或点击悬浮角标恢复）、养鱼人/通行码按钮、“画一条新鱼”主按钮；
     - 底部常驻“鱼食罐（剩余 `x/3`）”按钮：点击切换进入/退出**投喂模式**（未开启时点击鱼身打开档案卡，彻底防误触；开启后鼠标变饲料指示，点击任意水体投下 1 颗鱼食；若未设昵称则先弹出轻引导填写昵称）；
     - **单鱼档案弹窗（`FishProfileModal.tsx`）**：动态鱼预览、名称/作者/成长阶段/`Lv.X`、经验进度条、今日有效饱食 `x/6`、吃撑层数与 1 小时消化倒计时、五维属性可视化雷达图或精致进度条（主人可点击 `+` 加点并提交、每日 1 次免费洗点按钮）、复制 `?fish=<id>` 直达分享链接、举报按钮、主人专属“深海归档”按钮（二次确认）。
     - **养鱼人中心弹窗（`KeeperModal.tsx`）**：首次昵称设置、通行码展示与一键复制、通行码恢复登录、切换查看“我的在缸鱼（x/3）”与“深海归档图鉴”。

2. **三栏横屏手绘画板（`src/studio/`，对标参考图布局）**：
   - **严禁提供上传本地图片或贴图导入功能**，纯手绘创作。
   - **顶部栏**：关闭返回鱼缸、提示按钮、鱼名称输入框（1~16 字）、**“游动预览”开关**（打开后在画布上方/浮层用同款 `meshRenderer` 实时预览当前画作摆尾游动效果）、**“放生下水”**按钮（下水前明确提示外观与名称将永久锁定）。
   - **左侧栏**：撤销/重做（至少 20 步快照栈，支持 `Ctrl/Cmd+Z`、`Ctrl/Cmd+Shift+Z`）、清空画布、**鱼形模板库（`模板`）**：至少 8 款精致免费开放的鱼形剪影（标准金鱼、鲨鱼、圆胖河豚、热带三角鱼、鲸鱼、灯笼鱼、翻车鱼、长条鳗鱼），支持切换 `无模板` / `垫底参考轮廓` / `仅在模板轮廓内上色（裁剪蒙版）`。
   - **中央网格画布**：深蓝灰细网格背景、淡色 **“← 鱼头 ｜ 尾巴 →”** 朝向引导水印；基于 Pointer Events 流畅插值绘制。
   - **右侧栏**：
     - 工具切换：画笔（`B`）、橡皮擦（`E`）、油漆桶填充（`G`，支持像素容差 Flood Fill）、吸管取色（`I`）、直线工具（`L`）、水平/垂直对称辅助线开关；
     - 软边 / 硬边笔头切换；
     - HSV 环形色轮 + 饱和度明度方块选色器 + 常用色快捷点；
     - 粗细滑块（`1~60`）与不透明度滑块（`10~100%`）。
   - **下水自动裁切与归一化（`src/studio/exportFish.ts`，纯函数可单测）**：扫描透明画布非透明像素外接矩形，校验有效像素达最低阈值防空白提交，自动裁掉四周冗余空白（保留极小边距），缩放导出规范透明 PNG。

3. **Web Audio 合成音效（`src/audio/sound.ts`）**：
   - 纯 Web Audio API 轻量合成（不依赖外部音频文件）：落水声、吃食啵声、升级和弦、打饱嗝声、下水扑通声，支持静音开关与本地偏好记忆，在无 AudioContext 环境安全降级。

---

## 二、允许创建与修改的文件范围

只允许在仓库根目录 `/Users/martin/Documents/DevProjects/Fish` 下创建和修改以下工程与业务文件：
- 根配置文件：`package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `tsconfig.server.json`, `vite.config.ts`, `vitest.config.ts`, `index.html`, `.gitignore`, `README.md`
- 共享领域层：`shared/**/*`
- 后端服务层：`server/**/*`
- 前端应用层：`src/**/*`
- 自动化测试：`tests/**/*`

---

## 三、严禁做的事（红线）

1. **严禁执行 `git commit`、`git push`、`git reset` 或任何改动 git 历史的操作**（由人类决定何时提交）。
2. **严禁修改或删除** `GLOSSARY.md`、`docs/adr/*` 与 `.codex-tasks/*`。
3. **严禁引入外部数据库或云对象存储依赖**（不许要求安装 Postgres/Redis/MinIO，必须使用 Node v24 内置 `node:sqlite` + 本地数据目录）。
4. **严禁在画板添加本地图片上传 / 贴图导入入口**（必须纯手绘）。
5. **严禁伪造测试或跳过服务端权威校验**：
   - 不许把配额、饱食上限、洗点限制、加点上限只做在前端；
   - 不许删减五维属性中的任何一项（特别是 `brawn` 追食冲撞）或省略吃撑 3 层减速与 60 分钟消化逻辑。
6. **严禁留下运行中的僵尸后台进程或临时测试脏数据目录**在工作区中。

---

## 四、自测与验收要求

你必须编写并真实跑通完整的自动化测试套件（使用 Vitest）与构建校验，涵盖：

1. **领域规则单测（`tests/domain.test.ts`）**：
   - 阶梯递增升级公式：`Lv.1→2` 需 1 颗、`Lv.2→3` 需 2 颗、……、累计 55 颗满级 `Lv.11` 共 10 点属性点；
   - 成长阶段与尺寸平滑递增曲线（`40px → 260px`）；
   - 吃撑消化时间状态机：未满级 6 颗有效 + 第 7/8/9 颗分别叠 1/2/3 层；满级鱼第 1/2/3 颗直接叠 1/2/3 层；1~2 层每 20 分钟消退 1 层；3 层撑瘫满 60 分钟清零恢复且未满 60 分钟保持不可抢食；
   - `Asia/Shanghai` 跨自然日零点重置判定。
2. **后端 API 集成测试（`tests/api.test.ts`，使用独立临时 `DATA_DIR` / `DB_PATH`）**：
   - 养鱼人免注册创建、通行码跨会话恢复、IP 限流拦截；
   - 下水新鱼校验（PNG 合法性、在缸最多 3 条槽位上限、深海归档后可再下水第 4 条）；
   - 水域切片 `GET /api/tank/view`（必含自家鱼、支持 `focusFishId`、隐藏鱼不出现）；
   - 两阶段撒食结算（`drop -> claim` 正常成长升级、每日 3 次配额耗尽拒绝、未结算 `cancel`/超时释放配额、吃撑 3 层拒绝 claim、单鱼每日 6 颗有效上限后转叠吃撑）；
   - 五维属性加点校验（非主人拒绝、超点数拒绝、单项超 6 点拒绝）与每日 1 次免费洗点校验（同日第二次洗点拒绝、跨日恢复）；
   - 多人举报达阈值（3 人）自动隐藏（同人重复举报无效）与 `X-Admin-Secret` 管理员清理；
   - SSE `/api/events` 连接与事件推送验证。
3. **前端核心纯逻辑单测（`tests/physics.test.ts` & `tests/studio.test.ts`）**：
   - 物理引擎：验证 3 层吃撑鱼不追食、1~2 层吃撑明显减速、高 `sense` 鱼索敌半径更大、高 `burst` 鱼冲刺更快、追食冲刺态高 `brawn` 触发挤推而日常巡游不互撞、鱼食沉底停留；
   - 画布导出裁切：验证四周透明空白被准确裁切，空白画布被拒绝，非空白像素外接框正确计算。
4. **全量命令验证**：
   - `pnpm run typecheck` 零报错；
   - `pnpm test` 全部通过；
   - `pnpm run build` 成功产出 `dist/`；
   - 启动生产服务对关键接口（首页 HTML、`/api/tank/view`、种子鱼 PNG 资源）做一次真实 HTTP 冒烟验证，确认响应 200 后关闭服务并清理测试临时目录。

完成后，请简洁汇报新增/修改的文件清单以及上述命令的实际执行结果（不要虚报）。
