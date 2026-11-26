# 任务单 004：鱼肚子容量、六维「胃口」属性与 Lv.18「鱼皇」升级

请完整阅读本任务单并严格按要求在现有代码基础上实现全部需求。务必保证旧版 SQLite 数据库平滑自动迁移、保持 `shared/domain.ts` 100% 语句/分支/函数/行测试覆盖率，以及 60fps 水族箱流畅渲染。

---

## 一、核心目标与精确数值规则

### 1. 移除每日 6 颗上限，改为「鱼肚子容量 + 实时消化」
- 移除 `DAILY_SATIETY_CAP`（不再有单鱼每日有效饱食上限），不再使用 `dailyFedCount / dailyFedDate` 拦截成长。
- 将每日投喂配额调整为：`DAILY_RATION_LIMIT = 20`（单人每日 20 颗，配合每 15 颗触发一次的黄金大餐，1 天即可稳步养出鱼王）。

### 2. 等级与五阶段体系（Lv.1 ~ Lv.18，1 天封鱼王，次日冲鱼皇）
- 升级经验阶梯（共 17 次升级，总经验 `33`，满级共 `17` 点可分配属性点）：
  - `LEVEL_XP_COSTS = [1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3] as const`
  - `MAX_LEVEL = 18`（即 `LEVEL_XP_COSTS.length + 1`）
  - `MAX_EXPERIENCE = 33`（即 `LEVEL_XP_COSTS` 之和）
- 五个成长阶段 `GrowthStage = 'fry' | 'juvenile' | 'adult' | 'leviathan' | 'emperor'`：
  - `fry`（鱼苗）：`Lv.1 ~ 3`（累计 0 ~ 2 经验）
  - `juvenile`（幼鱼）：`Lv.4 ~ 7`（累计 3 ~ 6 经验）
  - `adult`（成鱼）：`Lv.8 ~ 11`（累计 8 ~ 14 经验）
  - `leviathan`（鱼王）：`Lv.12 ~ 16`（累计 16 ~ 27 经验，第 1 天稳出）
  - `emperor`（鱼皇）：`Lv.17 ~ 18`（累计 30 ~ 33 经验）
- 尺寸曲线：`size = 40 + 235 * xp / MAX_EXPERIENCE`（`40px` 线性长到满级 `275px`；老库中 `experience > 33` 的历史鱼通过 `Math.min(MAX_EXPERIENCE, experience)` 平滑封顶为 `Lv.18 鱼皇`）。

### 3. 五维升级为六维，新增独立属性「胃口 (`appetite`)」
- `STAT_KEYS = ['burst', 'stamina', 'sense', 'agility', 'brawn', 'appetite'] as const`
- `EMPTY_STATS = { burst: 0, stamina: 0, sense: 0, agility: 0, brawn: 0, appetite: 0 }`
- 单项上限保持 `MAX_STAT_VALUE = 6`；`unspentPoints(level, stats)` 与 `allocateStats` 全面支持 6 维。
- 流派称号 `getBuildTitle(stats, level)` 升级（支持「胃口」单维与常见双主修组合称号）：
  - 无加点且 `level === 1`：`初生萌鱼`
  - 单维唯一最高：
    - `burst` → `深海鱼雷`
    - `stamina` → `永动机`
    - `sense` → `顺风耳`
    - `agility` → `深海泥鳅`
    - `brawn` → `全缸恶霸`
    - `appetite` → `深海无底洞`
  - 双维并列最高（`highest > 0 && leaders.length === 2`）：
    - `brawn + appetite` → `霸王餐恶霸`
    - `burst + appetite` → `深海吸尘器`
    - `sense + appetite` → `干饭雷达`
    - `burst + brawn` → `深海泥头车`
    - `burst + agility` → `水中幽灵`
  - 其余并列情况或无加点且 `level > 1`：`level === MAX_LEVEL ? '六边形战神' : '全能游侠'`

### 4. 鱼肚子容量、消化速度与进食流转（`shared/domain.ts`）
- **基础容量数组（Lv.1 ~ Lv.18）**：
  - `BASE_BELLY_BY_LEVEL = [2, 3, 4, 5, 6, 7, 9, 11, 13, 15, 17, 19, 22, 25, 28, 31, 34, 38] as const`
  - `APPETITE_CAPACITY_BONUS = 2`
  - `getBellyCapacity(level, appetite = 0)` = `BASE_BELLY_BY_LEVEL[clampLevel(level) - 1] + clampAppetite(appetite) * 2`
    - 验证边界：Lv.1/0胃口 = `2`，Lv.12/0胃口 = `19`，Lv.18/0胃口 = `38`，Lv.18/6胃口 = `50`。
- **单格消化时间（等级越高越快 + 胃口加速）**：
  - `getDigestIntervalMs(level, appetite = 0)`：
    - `baseSec = 120 - (clampLevel(level) - 1) * 6`（Lv.1 为 `120 秒`，Lv.18 为 `18 秒`）
    - 返回 `Math.max(8, Math.round(baseSec * (1 - clampAppetite(appetite) * 0.08))) * 1000`
    - 验证边界：Lv.1/0胃口 = `120_000ms`（2 分钟），Lv.18/0胃口 = `18_000ms`（18 秒），Lv.18/6胃口 = `9_000ms`（9 秒）。
- **撑翻休眠时长（等级越高越快 + 胃口加速）**：
  - `getStuffedComaMs(level, appetite = 0)`：
    - `baseSec = 240 - (clampLevel(level) - 1) * 10`（Lv.1 为 `240 秒`，Lv.18 为 `70 秒`）
    - 返回 `Math.max(25, Math.round(baseSec * (1 - clampAppetite(appetite) * 0.08))) * 1000`
    - 验证边界：Lv.1/0胃口 = `240_000ms`（4 分钟），Lv.18/0胃口 = `70_000ms`（1 分 10 秒），Lv.18/6胃口 = `36_000ms`（36 秒）。
- **黄金大餐胃口占用**：
  - `getGoldenFeastBellyCost(capacity)` = `Math.max(4, Math.ceil(capacity * 0.35))`
- **移动速率系数**：
  - `export type BellyOverload = 0 | 1 | 2`（`0` 正常，`1` 满格贪吃微撑警告，`2` 撑翻翻肚皮休眠）
  - `getBellyMovementFactor(bellyFillRatio, bellyOverload)`：
    - `bellyOverload === 2` → `0.25`
    - `bellyOverload === 1` → `0.45`
    - `bellyFillRatio <= 0.55` → `1`
    - `bellyFillRatio > 0.55` → `1 - ((clamp(ratio, 0, 1) - 0.55) / 0.45) * 0.32`（满肚平滑降至 `0.68`）
- **时间格式化工具**：
  - `formatDuration(seconds: number)`：`total = Math.max(0, Math.ceil(seconds))`，小于 60 秒返回 `${total} 秒`，整分钟返回 `${m} 分钟`，其余返回 `${m} 分 ${r} 秒`。
- **惰性肚子状态计算 `getBellyState(rawBellyLoad, rawStuffedFull, bellyUpdatedAt, level, appetite, nowMs)`**：
  - 若 `rawStuffedFull === true`：
    - `elapsed < comaMs`：仍在翻肚皮休眠中，`bellyUsed = bellyCapacity`，`bellyFillRatio = 1`，`bellyOverload = 2`，`isStuffedFull = true`，`digestionRemainingSec = Math.ceil((comaMs - elapsed) / 1000)`，`currentLoad = bellyCapacity + 2`，`nextAnchorMs = bellyUpdatedAt`。
    - `elapsed >= comaMs`：休眠结束，肚子清空，`bellyUsed = 0`，`bellyFillRatio = 0`，`bellyOverload = 0`，`isStuffedFull = false`，`digestionRemainingSec = 0`，`currentLoad = 0`，`nextAnchorMs = nowMs`。
  - 若 `rawStuffedFull === false`：
    - `normalized = Math.max(0, Math.floor(rawBellyLoad))`
    - `digested = normalized > 0 ? Math.floor(elapsed / intervalMs) : 0`
    - `currentLoad = Math.max(0, normalized - digested)`
    - `bellyUsed = Math.min(bellyCapacity, currentLoad)`
    - `bellyOverload = currentLoad > bellyCapacity ? 1 : 0`
    - `bellyFillRatio = Math.min(1, bellyUsed / bellyCapacity)`
    - `digestionRemainingSec = currentLoad > 0 ? Math.ceil((intervalMs - (elapsed % intervalMs)) / 1000) : 0`
    - `nextAnchorMs = currentLoad > 0 ? bellyUpdatedAt + digested * intervalMs : nowMs`（保留未满一格的消化进度）。
- **进食结算 `feedFish(state, nowMs)` 与 `applyGoldenFeast(state, nowMs)`**：
  - `export type FeedOutcome = 'grew' | 'leveled_up' | 'fed' | 'stuffed' | 'stuffed_full'`
  - `export interface FeedingState { experience: number; appetite: number; rawBellyLoad: number; rawStuffedFull: boolean; bellyUpdatedAt: number }`
  - `feedFish`：
    - `belly.isStuffedFull` 时返回 `null`。
    - `belly.currentLoad < belly.bellyCapacity` 时（正常吃进肚子）：
      - 未满级则 `experience + 1`；满级则经验不变但照常干饭，返回 `outcome = 'fed'`；升级返回 `outcome = 'leveled_up'`；未升级未满级返回 `'grew'`。
      - `rawBellyLoad = belly.currentLoad + 1`，`rawStuffedFull = false`。
      - **防升级跳表细节**：当 `belly.currentLoad > 0` 时，用 `nextIntervalMs = getDigestIntervalMs(nextLevel, state.appetite)` 计算 `partial = Math.min(nowMs - belly.nextAnchorMs, nextIntervalMs - 1)`，令 `bellyUpdatedAt = nowMs - partial`，既保留已消化进度又避免升级缩间隔后瞬间多消 1 格；当 `belly.currentLoad === 0` 时 `bellyUpdatedAt = nowMs`。
    - `belly.currentLoad >= belly.bellyCapacity` 时（满格贪吃）：
      - `belly.bellyOverload === 0`（第 1 口硬塞）：`rawBellyLoad = belly.bellyCapacity + 1`，`rawStuffedFull = false`，`bellyUpdatedAt = belly.nextAnchorMs`，`outcome = 'stuffed'`，`levelDelta = 0`。
      - `belly.bellyOverload >= 1`（第 2 口硬塞）：`rawBellyLoad = belly.bellyCapacity + 2`，`rawStuffedFull = true`，`bellyUpdatedAt = nowMs`，`outcome = 'stuffed_full'`，`levelDelta = 0`。
  - `applyGoldenFeast`：
    - `belly.isStuffedFull` 时返回 `null`。
    - 未翻肚皮即可强吞：`experience = Math.min(MAX_EXPERIENCE, state.experience + GOLDEN_FEAST_BONUS_XP)`，计算 `nextLevel`、`levelDelta`、`nextCapacity`。
    - `totalLoad = belly.currentLoad + getGoldenFeastBellyCost(belly.bellyCapacity)`。
    - 若 `totalLoad >= nextCapacity + 2`：直接触发撑翻休眠（`rawBellyLoad = nextCapacity + 2`，`rawStuffedFull = true`，`bellyUpdatedAt = nowMs`，`outcome = 'stuffed_full'`，同时保留 `experience` 增长与 `levelDelta`！）。
    - 否则：`rawBellyLoad = Math.min(totalLoad, nextCapacity + 1)`，`rawStuffedFull = false`，同样用 `nextIntervalMs - 1` 钳制保留的进度；`outcome = levelDelta ? 'leveled_up' : experience > state.experience ? 'grew' : totalLoad > nextCapacity ? 'stuffed' : 'fed'`。

---

## 二、各模块改造明细

### 1. 共享契约（`shared/contracts.ts`）
- `Fish` 接口移除 `dailyFedCount`、`dailyFedDate`、`rawStuffedStacks`、`stuffedStacks`、`stuffedUpdatedAt`，替换为：
  ```ts
  rawBellyLoad: number
  rawStuffedFull: boolean
  bellyUpdatedAt: number
  bellyUsed: number
  bellyCapacity: number
  bellyFillRatio: number
  bellyOverload: BellyOverload
  isStuffedFull: boolean
  digestionRemainingSec: number
  digestIntervalSec: number
  ```
- 保留 `dailyEatsCount`、`totalKnockouts`、`serverNow` 等其余字段。

### 2. 服务端存储与接口（`server/storage.ts`, `server/app.ts`）
- `server/storage.ts`：
  - `fish` 表新增列（并通过 `PRAGMA table_info(fish)` 自动 `ALTER TABLE` 迁移旧库，保留历史 `daily_fed_* / stuffed_*` 列不做破坏性删除）：
    - `appetite INTEGER NOT NULL DEFAULT 0`
    - `belly_load INTEGER NOT NULL DEFAULT 0`
    - `belly_full INTEGER NOT NULL DEFAULT 0`
    - `belly_updated_at INTEGER NOT NULL DEFAULT 0`
  - 当旧库首次补迁 `belly_full` 列时，将旧表中 `stuffed_stacks >= 3` 的鱼同步置为 `belly_full = 1, belly_updated_at = stuffed_updated_at`。
  - `presentFish(row, nowMs)` 返回 6 维 `stats` 与 `getBellyState(...)` 计算后的全部肚子字段。
- `server/app.ts`：
  - `settleFish` 接入新的 `FeedingState`，更新 `experience, belly_load, belly_full, belly_updated_at, updated_at, daily_eats_count, daily_eats_date`。
  - `ensureTankCanEat` 使用 `getBellyState(...).isStuffedFull` 判定是否全缸撑翻。
  - `POST /api/fish/:id/stats`：支持保存 `appetite`；若 `appetite` 变化，先按旧 `appetite` 结算当前 `belly`，对未翻肚皮的鱼将 `belly_load` 与 `belly_updated_at` 规范化（`partial` 钳制在新 `nextIntervalMs - 1` 内），避免加点瞬间产生跳表消化。
  - `POST /api/fish/:id/stats/reset`：6 维全部归零；若未处于翻肚皮休眠，将当前 `belly_load` 钳制至 `Math.min(belly.currentLoad, getBellyCapacity(level, 0) + 1)`，防止洗点缩胃导致状态异常。
  - `POST /api/golden-feast/:id/claim`：当 `result.outcome === 'stuffed_full'` 时，走马灯文案改为 `` `👑 ${result.fish.name} 一口吞下黄金大餐，直接撑翻了！` ``，否则保持 `` `👑 ${result.fish.name} 抢走了天降黄金大餐！` ``。

### 3. 物理与渲染（`src/tank/physics.ts`, `src/tank/meshRenderer.ts`, `src/tank/TankCanvas.tsx`, `src/tank/FishPreview.tsx`）
- `src/tank/physics.ts`：
  - `Body` 将 `stuffedStacks` 替换为 `bellyFillRatio: number; bellyOverload: BellyOverload`。
  - `cruiseSpeed` 与 `stepTank` 的移动/转向系数改为 `getBellyMovementFactor(body.bellyFillRatio, body.bellyOverload)`；体重因子按满级尺寸范围 `(body.size - 40) / 235` 平滑计算。
  - 翻肚皮休眠判断统一改为 `body.bellyOverload === 2`（敲玻璃跳过、不追食、不可触碰吃食）。
- `src/tank/meshRenderer.ts`：
  - `MeshPose` 将 `stuffedStacks` 替换为 `bellyFillRatio?: number`、`bellyOverload?: BellyOverload`，并新增 `isEmperor?: boolean`。
  - **中段动态鼓肚皮**：16 切片渲染时，对每片按位置 `u = strip / (SLICES - 1)` 计算肚皮权重 `Math.exp(-(((u - 0.38) / 0.24) ** 2))`，按 `bulge = fill * 0.24 + (overload === 1 ? 0.14 : overload === 2 ? 0.22 : 0)` 仅撑大鱼身中段并略向下偏移（让鼓胀集中在腹部而非背鳍），头尾保持利落不变形；游动频率与摆幅随饱腹度与过载平滑放缓，`bellyOverload === 2` 时翻转肚皮朝天（`scaleY = -1`）并闭眼打盹。
  - **鱼皇水中专属小皇冠 (`isEmperor`)**：在鱼头上方（约 `u = 0.22` 处）绘制一顶精致小金冠（三尖皇冠轮廓、金色渐变填充、深金描边与三颗亮色小宝石），随游动相位轻柔起伏；翻肚皮休眠时皇冠正向微微歪斜漂浮在一旁，不倒插。
- `src/tank/TankCanvas.tsx`：
  - 每帧基于 `getBellyState(...)` 实时同步 `visual.swimmer.body` 的 `bellyFillRatio` 与 `bellyOverload`，传入 `drawFishMesh`（含 `isEmperor: fish.stage === 'emperor'`）。
  - 飘字文案更新：
    - `grew`: `'+1 成长'`
    - `leveled_up`: `'✨ Lv.Up! 胃口变大了'`
    - `fed`: `'😋 干饭 +1'`
    - `stuffed`: `'🫧 嗝~ 肚子塞满啦'`
    - `stuffed_full`: `'💤 撑翻啦'`
  - 黄金大餐飘字：若 `effect.outcome === 'stuffed_full'` 显示 `` `👑 黄金大餐！${effect.xpGained ? `+${effect.xpGained} 成长 · ` : ''}直接撑翻！` ``。
  - 翻肚皮状态标签显示精确到秒的倒计时：`` `撑不动了 · ${formatDuration(belly.digestionRemainingSec)}` ``；`bellyOverload === 1` 时高频冒 `嗝~`，`bellyFillRatio >= 0.75` 时偶尔冒 `嗝~`。
- `src/tank/FishPreview.tsx`：
  - 接收 `bellyFillRatio: number; bellyOverload: BellyOverload`，传给 `drawFishMesh`（含 `isEmperor: fish.stage === 'emperor'`），档案预览同步展示鼓肚皮与鱼皇小皇冠。

### 4. 前端 UI 与晒图海报（`src/App.tsx`, `src/tank/FishProfileModal.tsx`, `src/tank/poster.ts`, `src/styles.css`）
- `src/App.tsx`：
  - `canFeedView` 改为使用 `getBellyState(...)` 检查是否存在 `!isStuffedFull` 的鱼。
  - 进食音效映射：`leveled_up → 'level'`，`grew | fed → 'eat'`，`stuffed | stuffed_full → 'burp'`。
- `src/tank/poster.ts`：
  - `statNames` 新增 `appetite: '胃口'`，海报雷达图自动升级为六边形；`drawFishMesh` 传入 `isEmperor: fish.stage === 'emperor'`，让鱼皇海报也佩戴小皇冠。
- `src/tank/FishProfileModal.tsx`：
  - `stageNames` 新增 `emperor: '鱼皇'`；`outcomeNames` 新增 `fed: '干饭'`。
  - 用 **鱼肚子面板（`.profile-belly`）** 替换原来的「今日有效饱食 + 吃撑层数」：
    - 展示实时 `bellyUsed / bellyCapacity`（当用户暂存 `appetite` 加点时，同步预览加点后的新容量与新消化速率）；
    - 带状态色彩的进度条（正常水绿 / `>= 70%` 暖黄微饱 / 过载橙色微撑 / 翻肚皮紫蓝休眠）；
    - 按秒实时跳动的消化信息（`每 XX 消化 1 格 · 下一格剩余 YY` 或 `翻身剩余 YY` 或 `肚子空空 · 每 XX 消化 1 格`）。
  - 属性区标题改为 `六维属性`（`aria-label="六维属性"`），并在胃口一行或标题下提供简洁说明（每点 `+2` 肚子容量，消化提速 `8%`）。
- `src/styles.css`：
  - `.ration-dots` 适配 20 颗额度为 `10×2` 紧凑点阵（`grid-template-columns: repeat(10, 5px); gap: 4px;`），桌面与移动端均不挤压。
  - 新增 `.profile-belly` 及各状态进度条样式，保持深海玻璃风视觉统一。

---

## 三、允许修改的文件范围

只允许修改以下业务与测试文件：
- `shared/domain.ts`
- `shared/contracts.ts`
- `server/storage.ts`
- `server/app.ts`
- `src/App.tsx`
- `src/styles.css`
- `src/tank/physics.ts`
- `src/tank/meshRenderer.ts`
- `src/tank/TankCanvas.tsx`
- `src/tank/FishPreview.tsx`
- `src/tank/FishProfileModal.tsx`
- `src/tank/poster.ts`
- `tests/domain.test.ts`
- `tests/physics.test.ts`
- `tests/api.test.ts`

---

## 四、严禁做的事（红线）

1. **严禁执行 `git commit`、`git push`、`git reset`、`git checkout` 或任何修改 `.git/` 的操作**。
2. **严禁修改** `GLOSSARY.md`、`docs/adr/*`、`Dockerfile`、`docker-compose.yml`、`Caddyfile`、`.codex-tasks/*` 与 `package.json`。
3. **严禁调用任何 `t3-code` MCP 工具**。
4. **严禁破坏已有 SQLite 数据的平滑迁移或删除历史列**。
5. **严禁留下未关闭的后台进程或临时测试文件**。

---

## 五、自测与验收标准

请补充完整自动化测试并真实运行全部校验：
1. `tests/domain.test.ts`：
   - 覆盖 `DAILY_RATION_LIMIT === 20`、`MAX_LEVEL === 18`、`MAX_EXPERIENCE === 33`、五阶段边界（含 `emperor`）、尺寸增长至 `275px`；
   - 覆盖六维属性校验（含 `appetite`）、17 点分配上限、单维/双修/满级均衡（`六边形战神`）流派称号；
   - 覆盖 `getBellyCapacity`（Lv.1=2 到 Lv.18+6胃口=50）、`getDigestIntervalMs`（120s 到 9s）、`getStuffedComaMs`（240s 到 36s）、`getBellyMovementFactor`、`formatDuration`；
   - 覆盖 `feedFish`（正常成长、升级扩胃且保留消化进度不跳表、满级鱼皇 `fed` 正常干饭、满格贪吃 1 口 `stuffed`、2 口 `stuffed_full` 翻肚皮及休眠到期清零恢复）；
   - 覆盖 `applyGoldenFeast`（+3 经验跨多级、强吞超载原地撑翻且保留经验和升级、满级吃黄金大餐、撑翻状态拒绝）；
   - **`shared/domain.ts` 保持 100% 语句/分支/函数/行覆盖率**。
2. `tests/physics.test.ts`：
   - 覆盖 55% 以下满速、55%~100% 饱腹渐重、`bellyOverload === 1` 微撑减速、`bellyOverload === 2` 翻肚皮漂浮无法追食/吃食且敲玻璃跳过。
3. `tests/api.test.ts`：
   - 覆盖每日 20 颗投喂配额、旧库自动补迁 `appetite / belly_load / belly_full / belly_updated_at`（含旧 `stuffed_stacks >= 3` 迁移至 `belly_full = 1`）；
   - 覆盖六维加点与洗点（17 点上限、加胃口扩容、洗点缩胃安全钳制）；
   - 覆盖鱼肚子吃满 → 贪吃微撑 → 撑翻禁食 → 休眠到期恢复；
   - 覆盖黄金大餐一口吞象触发撑翻时的走马灯播报；
   - 覆盖 `experience > 33` 的老鱼平滑映射为 Lv.18 鱼皇。
4. 真实执行并全部通过：
   - `pnpm run typecheck`
   - `pnpm test`
   - `pnpm run build`

完成后请简明汇报实际修改的文件清单与测试输出。
