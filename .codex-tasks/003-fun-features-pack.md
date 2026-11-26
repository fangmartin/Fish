# 任务单 003：九大趣味“花活”全面升级

请完整阅读本任务单并严格按要求在现有代码基础上落地全部 9 项特性。务必保证对现有 `/opt/fish/data/tank.sqlite` 数据的平滑自动迁移、保持 `shared/domain.ts` 100% 测试覆盖率，以及 60fps 水族箱渲染流畅度。

---

## 一、九大功能详细规格

### 1. 流派特效外显 + 漫画撞击反馈（`src/tank/physics.ts`, `src/tank/meshRenderer.ts`, `src/tank/TankCanvas.tsx`, `src/audio/sound.ts`）
- **物理状态与事件扩展（`src/tank/physics.ts`）**：
  - 在 `Swimmer` 中增加视觉状态字段：`alertTimer: number`（感知发现新鱼食时的惊觉计时）、`scaredTimer: number`（敲玻璃受惊四散计时）。
  - 在 `stepTank(...)` 中新增可选的回调或事件收集参数（例如第 5 个可选参数 `events?: { onCollision?: (hit: CollisionEvent) => void; onAlert?: (fishId: string) => void }`，保持已有调用签名 100% 兼容！）：
    - 当 `swimmer.body.stats.sense >= 2` 且刚锁定一颗新鱼食时，置 `swimmer.alertTimer = 0.75` 并触发 `onAlert`；
    - 当追食冲刺触发冲撞挤推时，回调 `onCollision({ attackerId, victimId, x: (attacker.x + peer.x) / 2, y: (attacker.y + peer.y) / 2, brawn: attacker.body.stats.brawn, force })`。
- **水中视觉与音效演出（`src/tank/meshRenderer.ts`, `src/tank/TankCanvas.tsx`, `src/audio/sound.ts`）**：
  - **高感知 (`alertTimer > 0`)**：鱼头上方弹出亮黄色漫画感叹号气泡 **`！`**。
  - **高爆发 (`stats.burst >= 3 && sprinting`)**：冲刺时尾部拖出更密集明亮的**青蓝涡轮气泡链 + 轻柔速度残影线**。
  - **追食冲撞 (`onCollision`)**：在撞击点迸发漫画风 **`💥 咣！`** 星芒粒子特效（持续 ~0.65s），当 `brawn >= 3` 时叠加短暂柔和的画面微震（3～4px 衰减 ~180ms）并播放撞击音效 `bonk`；被撞晕（`swimmer.stun > 0`）的鱼头顶旋转小星星 `✦`。
  - **吃撑 3 层（`stuffedStacks === 3`）**：`drawFishMesh` 支持垂直翻转（肚皮朝天 `scaleY = -1`），在水中缓慢上下起伏漂浮，并周期性上浮 **`💤`** 呼噜气泡 + 原有的消化剩余分钟标签。

### 2. 敲玻璃惊鱼（`src/tank/physics.ts`, `src/tank/TankCanvas.tsx`, `src/audio/sound.ts`）
- 在 `src/tank/physics.ts` 导出纯函数 `knockTank(fish: Swimmer[], x: number, y: number, water: Water): string[]`（返回受惊逃散的鱼 ID 列表）：
  - 影响半径 `320px` 内、且 `stuffedStacks < 3` 的鱼立即受惊：获得背离敲击点的逃逸速度冲量（距离越近推力越大，朝向迅速背离敲击点）并置 `scaredTimer = 1.1`；
  - 处于 **3 层吃撑态（`stuffedStacks === 3`）** 的鱼**不逃跑、不获得逃逸推力**，仅极微弱原地晃动，体现“吃太撑懒得动”的反差感。
- 在 `TankCanvas.tsx` 中，**非投喂模式**下双击空白水面（`onDoubleClick`）触发 `knockTank`，播放 Web Audio 合成清脆“咚咚”敲玻璃音效（`knock`），并在敲击处渲染双层扩散玻璃波纹与受惊小感叹号。

### 3. 画板“活眼球”贴纸 & 水中实时追踪鱼食/指针（`shared/`, `server/`, `src/studio/`, `src/tank/`）
- **共享类型与校验（`shared/domain.ts`, `shared/contracts.ts`）**：
  - 定义 `EYE_STYLES = ['googly', 'deadpan', 'fierce'] as const`（豆豆眼 / 死鱼眼 / 愤怒眼）、`MAX_FISH_EYES = 4`、`FishEye = { x: number; y: number; radius: number; style: EyeStyle }`。
  - 在 `shared/domain.ts` 提供纯函数 `validateEyes(input: unknown): FishEye[] | null`（接受 `undefined` 返回 `[]`；否则必须为长度 `<= 4` 的数组，每项 `style` 合法、`x, y ∈ [0, 1]`、`radius ∈ [0.02, 0.2]` 均为有限数字）。
- **服务端存储与自动迁移（`server/storage.ts`, `server/app.ts`）**：
  - `fish` 表新增 `eyes_json TEXT NOT NULL DEFAULT '[]'`（启动事务中通过 `PRAGMA table_info(fish)` 检查缺失则 `ALTER TABLE fish ADD COLUMN eyes_json TEXT NOT NULL DEFAULT '[]'`，兼容旧库）。
  - `POST /api/fish` 接受可选 `eyes` 并通过 `validateEyes` 校验落库；`presentFish` 解析并返回 `eyes: FishEye[]`。
- **画板交互与精确坐标导出（`src/studio/Studio.tsx`, `src/studio/exportFish.ts`）**：
  - 画板右侧工具栏新增 **“活眼球”工具（快捷键 `O`）**，提供三种样式切换（豆豆眼 / 死鱼眼 / 愤怒眼）及眼球大小随当前粗细滑块微调（映射到合理半径），点击画布放置（最多 4 只，点击已有眼球附近可移除，另提供“清除眼球”按钮，与画布撤销/重做互不冲突或同步记录）。
  - 在 `src/studio/exportFish.ts` 中新增纯函数 `mapEyesToExport(eyes: CanvasEye[], bounds: ArtworkBounds, maxEdge?: number, padding?: number): FishEye[]`，在下水自动裁切四周透明空白与加边距时，将画布像素坐标下的眼球精确换算为导出后透明 PNG 的归一化 `[0, 1]` 坐标与归一化半径（保留画布上的眼球与鱼身严格对齐，绝不偏移）。
  - 画板内置“游动预览”同样渲染活眼球并随摆尾一起晃动。
- **水中实时追踪渲染（`src/tank/meshRenderer.ts`, `src/tank/TankCanvas.tsx`）**：
  - `drawFishMesh` 接收可选 `eyes?: FishEye[]` 与 `lookTarget?: { x: number; y: number }`（世界坐标）。
  - 每只眼球精准跟随所属纵向切片的正弦波 `vertical` 偏移、水平翻转与吃撑翻肚皮翻转；瞳孔实时朝向 `lookTarget`（**优先紧盯最近的黄金大餐或普通鱼食；无鱼食时温柔注视鱼缸内鼠标指针；指针不在缸内则看向前方游动方向**）；豆豆眼圆溜溜大瞳孔、死鱼眼上半睑半遮、愤怒眼带斜眉；吃撑 3 层时半闭打盹。

### 4. 画板“魔棒去背景”一键扣透明（`src/studio/paint.ts`, `src/studio/Studio.tsx`）
- 在 `src/studio/paint.ts` 新增纯函数 `magicWandErase(pixels: Uint8ClampedArray, width: number, height: number, point: Point, tolerance: number, mask?: Uint8ClampedArray): boolean`：
  - 基于 4-邻域连通洪泛匹配与起点像素 RGBA 差值 `<= tolerance` 的相连区域，将命中像素的 alpha 设为 `0`（完全透明），若起点已完全透明则返回 `false`；支持遵守模板裁剪 `mask`。
- 在 `Studio.tsx` 右侧工具栏新增 **“魔棒去底 (`W`)”** 工具，选中时显示容差滑块（默认 `36`，范围 `0~120`），支持撤销/重做，方便用户导入白底/纯色图后一键抠图涂鸦。

### 5. 鱼缸趣味榜单 & 实时吃瓜播报（`shared/`, `server/`, `src/tank/LeaderboardModal.tsx`, `src/App.tsx`）
- **数据模型与 SQLite 自动迁移（`server/storage.ts`, `server/app.ts`）**：
  - `fish` 表新增列（均带旧库自动 `ALTER TABLE` 迁移）：
    - `daily_eats_count INTEGER NOT NULL DEFAULT 0`
    - `daily_eats_date TEXT`（每次吃掉普通或黄金鱼食——含吃撑暴食——均按上海自然日累计今日总干饭数）
    - `total_knockouts INTEGER NOT NULL DEFAULT 0`（累计撞晕其他鱼次数）
  - 新增 `POST /api/tank/knockout`：`{ attackerFishId, victimFishId }`。需 Keeper 身份，受轻量 IP 频控保护（如每分钟 40 次），校验两鱼均活跃未隐藏且不同，事务内令攻击者 `total_knockouts + 1`，并通过 SSE 广播 `tank_ticker` 事件：`{ id, kind: 'knockout', text: '💥 [攻击者] 把 [被撞者] 撞晕了！', fishId: attacker.id, createdAt }`。
  - 普通吃食达到 3 层撑瘫（`stuffed_full`）时，服务端同步通过 SSE 广播 `tank_ticker`：`{ id, kind: 'stuffed', text: '🫧 [鱼名] 彻底吃撑翻肚皮了！', fishId, createdAt }`。
  - 新增 `GET /api/tank/leaderboard`：返回 3 个趣味榜（各取活跃未隐藏鱼 Top 5）：
    - `gluttons`：今日干饭王（按当日实时 `dailyCount(daily_eats_count, daily_eats_date, now)` 降序，其次 `experience` 降序）；
    - `bullies`：全缸恶霸（按 `total_knockouts` 降序，其次 `brawn` 降序）；
    - `giants`：深海巨物（按 `experience` 降序，其次 `created_at` 升序）。
- **前端展示（`src/tank/LeaderboardModal.tsx`, `src/App.tsx`）**：
  - 顶部栏新增 **“排行榜”按钮**，弹窗支持切换“今日干饭王 / 全缸恶霸 / 深海巨物”三标签，点击榜上任意鱼可定位并打开档案卡。
  - 鱼缸底部上方/左下角展示半透明**实时吃瓜播报胶囊**（最新 1 条，约 5 秒淡出，沉浸模式下自动隐藏）。
  - 前端在自己投放的鱼食争抢期间捕获到 `onCollision` 且被撞者刚进入 `stun`（做前端去抖，同一对鱼 3 秒内只上报一次防刷屏），调用 `POST /api/tank/knockout`。

### 6. 定时/累计触发“天降黄金大餐”全缸混战（`shared/`, `server/`, `src/tank/`, `src/App.tsx`）
- **领域规则（`shared/domain.ts`）**：
  - `GOLDEN_FEAST_EVERY_FEEDS = 15`（全服每累计结算 15 颗普通鱼食自动天降一颗黄金大餐）；
  - `GOLDEN_FEAST_BONUS_XP = 3`（吃到黄金大餐的未满级鱼直接获得 `+3` 有效经验，可连续跨级并产出对应数量属性点，不消耗任何玩家配额；若鱼已满级则叠加 1 层吃撑并仍触发全屏庆祝）；
  - `GOLDEN_FEAST_LIFETIME_MS = 120_000`（有效期 2 分钟）。
  - 提供纯函数 `applyGoldenFeast(state: FeedingState, nowMs: number)`（3 层撑瘫态拒绝返回 `null`；未满级经验 `min(MAX_EXPERIENCE, experience + 3)` 并算出 `levelDelta`；满级则按吃撑叠 1 层）。
- **服务端实现（`server/storage.ts`, `server/app.ts`）**：
  - 新建 `golden_feasts` 表（`id, x, y, created_at, expires_at, status, winner_fish_id, consumed_at`）与 `tank_state(key PRIMARY KEY, value INTEGER NOT NULL)` 表记录全服普通吃食累计计数 `normal_feeds_total`。
  - 当普通 `POST /api/pellets/:pelletId/claim` 成功结算时，`normal_feeds_total += 1`；若 `normal_feeds_total % GOLDEN_FEAST_EVERY_FEEDS === 0` 且当前无活跃未过期黄金大餐，自动在随机水平位置 `x ∈ [0.2, 0.8], y = 0.14` 生成一颗黄金大餐并 SSE 广播 `golden_feast_spawned`。
  - 新增 `POST /api/admin/golden-feast`（校验 `X-Admin-Secret`）支持管理员随时手动触发一颗黄金大餐（也便于测试与活动运营）。
  - `GET /api/tank/view` 同步返回 `goldenFeast: GoldenFeast | null`（当前活跃未过期黄金大餐）。
  - 新增 `POST /api/golden-feast/:id/claim`（`{ winnerFishId }`）：需 Keeper 身份，`BEGIN IMMEDIATE` 原子校验黄金大餐为 `active` 且未过期、赢家鱼在缸活跃未隐藏且未处于 3 层撑瘫，标记 `consumed`，更新鱼经验/吃撑与今日干饭数，返回结算结果并通过 SSE 广播 `golden_feast_consumed` 与 `tank_ticker`（`👑 [鱼名] 抢走了天降黄金大餐！`）。
- **水中视觉与物理（`src/tank/physics.ts`, `src/tank/TankCanvas.tsx`, `src/audio/sound.ts`）**：
  - 黄金大餐在水中更大更璀璨（金色脉冲光晕 + 闪烁星芒粒子），缓慢下沉并停留缸底；抢到后在鱼身周围绽放金色庆祝粒子束并播放专属庆祝音效 `feast`。

### 7. 鱼的“吐泡泡口头禅”（`shared/`, `server/`, `src/studio/Studio.tsx`, `src/tank/TankCanvas.tsx`, `src/tank/FishProfileModal.tsx`）
- `fish` 表新增 `tagline TEXT NOT NULL DEFAULT ''`（旧库自动迁移）；`POST /api/fish` 校验可选 `tagline`（trim 后 `<= 12` 字符、无控制字符），下水后永久锁定。
- `Studio.tsx` 放生下水弹窗新增选填输入框“口头禅（选填，最多 12 字）”。
- `TankCanvas.tsx` 中，有口头禅且未处于追食/3 层撑瘫的鱼按确定性错峰周期（每条鱼间隔约 14～24 秒，同屏最多同时显示 2 条，持续 ~3.6 秒柔和淡入淡出）在头顶吐出精致小气泡台词；`FishProfileModal.tsx` 同步展示口头禅。

### 8. 真实昼夜潮汐光影（`src/tank/ambient.ts`, `src/tank/TankCanvas.tsx`, `src/App.tsx`）
- 在 `src/tank/ambient.ts` 中新增纯函数与配置：
  - `TideMode = 'auto' | 'dawn' | 'day' | 'dusk' | 'night'`；
  - `resolveTidePhase(nowMs: number, mode: TideMode): 'dawn' | 'day' | 'dusk' | 'night'`（`auto` 按 `Asia/Shanghai` 小时判定：`5..9 -> dawn` 清晨、`10..16 -> day` 午后、`17..19 -> dusk` 黄昏、`20..23 & 0..4 -> night` 深夜）；
  - `paintWater(ctx, width, height, seconds, phase)` 为四个时段绘制各自调校的高级渐变海面、光束、气泡/水母微光与水草配色；
  - 深夜（`night`）模式下，`TankCanvas` 为水中的鱼叠加一层克制柔和的生物荧光微光（`shadowColor` + `shadowBlur`）。
- 顶部栏新增昼夜氛围一键切换按钮（循环 `自动昼夜 / 清晨 / 午后 / 黄昏 / 深夜`，持久化至 `localStorage`）。

### 9. 一键生成“鱼类档案分享海报”（`src/tank/poster.ts`, `src/tank/FishProfileModal.tsx`, `shared/domain.ts`）
- 在 `shared/domain.ts` 新增纯函数 `getBuildTitle(stats: Stats, level: number): string`，按五维加点流派自动算出趣味称号（例如无加点且初生→`初生萌鱼`，单维最高：爆发→`深海鱼雷`、冲撞→`全缸恶霸`、感知→`顺风耳`、耐力→`永动机`、灵巧→`深海泥鳅`，多维并列均衡→`全能游侠` / 满级均衡→`深海全能王`）。
- 新增 `src/tank/poster.ts`，使用纯 Canvas 2D 离屏合成 `720 × 960` 深海卡片 PNG（含深海渐变背景、鱼的高清画作与活眼球、鱼名/口头禅/创作者/等级与流派称号徽章、五维五边形雷达图与数值标注、累计吃食/撞晕战绩摘要以及站点直达链接），在 `FishProfileModal.tsx` 中新增 **“保存晒图”** 按钮一键触发下载 PNG。

---

## 二、允许创建与修改的文件范围

只允许修改或新建以下工程与业务文件：
- `shared/domain.ts`, `shared/contracts.ts`
- `server/storage.ts`, `server/app.ts`
- `src/**/*`（可按需新建 `src/tank/LeaderboardModal.tsx`, `src/tank/poster.ts` 等模块）
- `tests/**/*`

---

## 三、严禁做的事（红线）

1. **严禁执行 `git commit`、`git push`、`git reset` 或修改 `.git/`**。
2. **严禁修改** `GLOSSARY.md`、`docs/adr/*`、`Dockerfile`、`docker-compose.yml`、`Caddyfile` 与 `.codex-tasks/*`。
3. **严禁调用任何 `t3-code` MCP 工具**（如 `t3_thread_read`）。
4. **严禁破坏已有 SQLite 数据的向后兼容性**，必须通过自动迁移脚本平滑升级旧表结构。
5. **严禁留下临时测试数据或未关闭的后台进程**。

---

## 四、自测与验收标准

请补充完整自动化测试并真实执行全部检查：
1. `tests/domain.test.ts`：覆盖 `validateEyes`、`applyGoldenFeast`（+3 经验连升多级、满级叠吃撑、3 层撑瘫拒绝）、`getBuildTitle` 各流派称号，且 `shared/domain.ts` 保持 **100%** 语句/分支/函数/行覆盖率。
2. `tests/physics.test.ts`：覆盖 `knockTank`（320px 内正常鱼受惊逃逸，3 层撑瘫鱼不逃逸）、追食冲撞 `onCollision` 回调与高感知 `alertTimer` 触发。
3. `tests/studio.test.ts`：覆盖 `magicWandErase`（容差连通扣透明、不越过边界、遵守模板 mask）与 `mapEyesToExport`（裁切与边距后的归一化坐标精确换算）。
4. `tests/api.test.ts`：
   - 覆盖带 `tagline` 与 `eyes` 下水及非法值校验；
   - 覆盖 `POST /api/tank/knockout` 统计撞晕次数与 `GET /api/tank/leaderboard` 三榜排序；
   - 覆盖累计 15 颗普通进食自动触发黄金大餐、`POST /api/admin/golden-feast` 手动触发、`POST /api/golden-feast/:id/claim` 原子防并发重复领取与 +3 经验连升多级；
   - 覆盖旧版 `fish` 表（缺少 `tagline`/`eyes_json`/`daily_eats_count`/`daily_eats_date`/`total_knockouts`）启动自动迁移；
   - 覆盖 SSE 推送 `golden_feast_spawned`、`golden_feast_consumed`、`tank_ticker`。
5. 额外测试 `resolveTidePhase`（清晨/午后/黄昏/深夜按上海时间切换及手动覆盖）。
6. 真实执行并通过：
   - `pnpm run typecheck`
   - `pnpm test`
   - `pnpm run build`

完成后请简明汇报实际修改的文件清单与测试输出。
