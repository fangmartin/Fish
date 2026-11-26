# 返工单 002（第 1 轮）：冲撞判定修复、空缸/全撑瘫拦截与 10 颗不返还配额调整

请先完整阅读本返工单，并在现有代码基础上完成精准修改与全量自测。

---

## 一、明确修改目标

### 1. 修复大鱼追食冲撞判定半径被上限裁剪的问题（`src/tank/physics.ts`）
- 现状：`src/tank/physics.ts` 第 180 行写了 `const size = displayedSize(attacker.body.size + peer.body.size, water)`，当两条满级大鱼（`260px + 260px`）相撞时，先相加再传给 `displayedSize` 会触发单鱼显示上限裁剪，导致大鱼之间的冲撞判定半径偏小。
- 要求：改为分别计算两鱼实际显示尺寸之和：
  `const size = displayedSize(attacker.body.size, water) + displayedSize(peer.body.size, water)`。
- 补充物理单元测试：在 `960x600` 水域中，验证两条 `260px` 鱼在距离介于 `288 * 0.49` 与 `(260 + 260) * 0.49` 之间（如相距 `200px`）追食冲刺时，确实能触发冲撞挤推与打断。

### 2. 空缸或全缸鱼均处于 3 层撑瘫态时，直接拦截投喂并提示
- **前端拦截（`src/App.tsx`）**：
  - 无论是在点击底部“鱼食罐”尝试进入投喂模式时，还是已处于投喂模式点击水面调用 `drop(x, y)` 之前，都要检查当前水域切片 `fish` 中是否存在至少一条实时 `stuffedStacks < 3` 的可进食鱼（用 `getDigestionState` 按当前时间实时判断，不能只看静态快照）。
  - 若当前水域为空（`fish.length === 0`）：阻止进入投喂态 / 阻止发起 `POST /api/pellets/drop`，弹出明确提示（如 `鱼缸里还没有鱼，先画一条下水吧`）。
  - 若当前水域虽有鱼但全部处于 3 层撑瘫态：阻止进入投喂态 / 阻止发起 `POST /api/pellets/drop`，弹出明确提示（如 `这片水域的鱼都撑不动了，换片水域或稍后再喂吧`）。
- **后端兜底（`server/app.ts` `POST /api/pellets/drop`）**：
  - 在落库投放鱼食前，于同一事务内检查公共鱼缸中是否存在至少一条 `status = 'active' AND is_hidden = 0` 且当前实时 `stuffedStacks < 3` 的可进食鱼；若全缸为空或全员撑瘫，直接返回 `409`（带清晰中文提示）且不创建 pellet、不扣减配额。

### 3. 每日投喂配额改为 10 颗，且投放后鱼食不再返还
- **配额上限调整（`shared/domain.ts`）**：
  - 将 `DAILY_RATION_LIMIT` 从 `3` 修改为 `10`。
  - 调整 `remainingRations` 为基于“当日已投放次数”计算（投放即扣减，不再区分 consumed/pending 退还逻辑；可简化为 `remainingRations(droppedCount: number)` 或保持清晰命名，确保 `shared/domain.ts` 继续维持 100% 覆盖率）。
- **投放即永久扣除、不返还（`server/storage.ts` & `server/app.ts`）**：
  - `pellets` 表新增 `dropped_date TEXT` 字段记录投放所属的上海自然日（`shanghaiDate(time)`），并建立相应索引。
  - **必须兼容已有 SQLite 数据库文件**（例如现有 `data/tank.sqlite`）：启动打开数据库时，若 `pellets` 表尚无 `dropped_date` 列，自动执行 `ALTER TABLE pellets ADD COLUMN dropped_date TEXT`，对旧记录查询时兼容使用 `COALESCE(dropped_date, consumed_date)`，避免升级重启报错。
  - `POST /api/pellets/drop` 写入 `dropped_date = shanghaiDate(time)`，且 `rations(keeperId, time)` 统计该养鱼人当日所有已投放记录（`COUNT(*) WHERE keeper_id = ? AND COALESCE(dropped_date, consumed_date) = ?`），无论其状态是 `pending`、`consumed`、`cancelled` 还是 `expired`，**均计入当日已用配额，绝不返还**。
  - `POST /api/pellets/:pelletId/cancel` 仍允许将尚未结算的 `pending` 鱼食置为 `cancelled`（使其不能再被 `claim`），但**不返还配额**，返回的 `remainingRations` 不增加。
  - 超时变为 `expired` 的鱼食同样不可再 `claim`，且**不返还配额**。
  - 跨上海自然日 `00:00` 后，新的一天重新获得完整的 10 颗配额；昨天 `23:59` 投放但在今日 `00:00` 被吃掉的鱼食，其配额归属在投放日（昨天），不占用今天的新 10 颗配额。
- **前端界面适配（`src/App.tsx` & `src/styles.css`）**：
  - 鱼食罐正确显示 `剩余 x/10`，`ration-dots` 视觉排布美观适配 10 颗（例如紧凑排列或 2 行 × 5 颗微光圆点，不撑变形）。
  - `drop()` 成功后立即将 `item.remainingRations` 反映到 UI 状态上（同时仍可后台刷新 keeper 状态）。

---

## 二、允许修改的文件范围

只允许修改以下业务与测试文件：
- `shared/domain.ts`
- `server/storage.ts`
- `server/app.ts`
- `src/App.tsx`
- `src/styles.css`
- `src/tank/physics.ts`
- `tests/domain.test.ts`
- `tests/api.test.ts`
- `tests/physics.test.ts`

（如上述文件有强关联的类型定义文件 `shared/contracts.ts` 或 `src/api.ts` 需配合微调，也允许一并同步。）

---

## 三、严禁做的事（红线）

1. **严禁执行 `git commit`、`git push` 或任何修改 `.git/` 的操作**。
2. **严禁修改** `GLOSSARY.md`、`docs/adr/*` 与 `.codex-tasks/*`。
3. **严禁调用任何 `t3-code` MCP 工具**（如 `t3_thread_read`）。
4. **严禁在测试或代码中留下临时脏数据或未关闭的后台服务进程**。

---

## 四、自测与验收标准

请更新并补充自动化测试，然后真实执行以下命令：
1. `tests/domain.test.ts`：覆盖 `DAILY_RATION_LIMIT === 10` 及不返还配额计算，`shared/domain.ts` 保持 **100%** 语句/分支/函数/行覆盖率。
2. `tests/physics.test.ts`：覆盖两条 `260px` 大鱼按分别裁剪后的显示尺寸之和正常触发追食冲撞。
3. `tests/api.test.ts`：
   - 验证每日配额为 10 颗，第 11 颗返回 `409`；
   - 验证 `cancel` 取消与 `90s` 超时 `expired` 后均**不返还配额**且不能再 `claim`；
   - 验证空缸与全缸鱼均处于 3 层撑瘫态时，`POST /api/pellets/drop` 返回 `409` 且不扣减配额；
   - 验证旧版无 `dropped_date` 列的 SQLite 库打开后可平滑自动迁移不报错；
   - 验证 `23:59` 投放、`00:00` 结算时配额计在投放日，次日仍保有完整 10 颗配额。
4. 真实执行并通过：
   - `pnpm run typecheck`
   - `pnpm test`
   - `pnpm run build`

完成后请简明汇报实际修改的文件清单及上述命令的执行结果。
