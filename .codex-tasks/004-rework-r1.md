# 返工单 004-R1：修复验收发现的 4 项细节问题

首轮主体实现与测试覆盖率（`domain.ts` 100%）质量很好，但验收对比 `git diff` 发现以下 4 项回归与体验缺口，请一并修复：

### 1. 【功能回归】恢复敲玻璃时翻肚皮鱼的原地轻微晃动（`src/tank/TankCanvas.tsx`）
- 问题：重构 `TankCanvas.tsx` 时误删了 `KNOCK_RADIUS` 导入与原有的 `rocked` 逻辑（任务单 003 要求：敲玻璃时处于撑翻休眠态的鱼不逃跑，但在敲击半径内应有轻微原地晃动）。
- 要求：恢复 `KNOCK_RADIUS` 与 `rocked` 倾斜晃动：
  ```ts
  const rocked = sleeping && knock && knockAge >= 0 && knockAge < 0.45 &&
    (x - knock.x) ** 2 + (y - knock.y) ** 2 <= KNOCK_RADIUS ** 2
  const tilt = pitch(swimmer) + (rocked ? Math.sin(knockAge * 34) * (0.45 - knockAge) * 0.18 : 0)
  ```
  并将 `tilt` 传入 `drawFishMesh`。

### 2. 【文案体验】满级鱼吃黄金大餐未翻肚皮时的飘字补充（`src/tank/TankCanvas.tsx`）
- 问题：当前黄金大餐飘字当满级鱼吃到黄金大餐且 `xpGained === 0`、未翻肚皮（`outcome === 'fed'` 或 `'stuffed'`）时，只显示 `👑 黄金大餐！`，缺少结果反馈。
- 要求：
  - `effect.outcome === 'stuffed_full'`：`` `👑 黄金大餐！${growth ? `${growth} · ` : ''}直接撑翻！` ``
  - `effect.outcome === 'stuffed'`：`` `👑 黄金大餐！${growth ? `${growth} · ` : ''}吃撑啦` ``
  - 其余情况：`` `👑 黄金大餐！${growth || '美味！'}` ``

### 3. 【UI 可读性】鱼肚子面板显式标出「微撑 / 翻肚皮休眠」状态文案（`src/tank/FishProfileModal.tsx`）
- 问题：当前 `.profile-belly` 头部仅显示 `bellyUsed / bellyCapacity`，当处于 `bellyOverload === 1`（满格贪吃微撑警告，再吃 1 口就翻肚皮）或 `isStuffedFull`（翻肚皮休眠）时，用户仅靠进度条变色较难第一时间察觉状态差异。
- 要求：
  - 头部状态值明确区分：
    - `isStuffedFull`：`翻肚皮休眠`（或 `${bellyUsed} / ${bellyCapacity} · 撑翻`）
    - `bellyOverload === 1`：`${bellyUsed} / ${bellyCapacity} · 微撑`
    - 其余正常态：`${bellyUsed} / ${bellyCapacity}`
  - 当 `bellyOverload === 1` 时，底部提示明确提醒：`已微撑，再吃 1 口会翻肚皮 · 下一格消化剩余 ${formatDuration(digestionRemainingSec)}`（并保留当前消化速率信息）。

### 4. 【预览一致性】翻肚皮休眠时暂存「胃口」加点同步预览缩短后的休眠倒计时（`src/tank/FishProfileModal.tsx`）
- 问题：当鱼处于 `isStuffedFull` 且用户点击 `+` 暂存 `appetite` 点数时，当前逻辑只更新了 `bellyCapacity`，未同步用新 `appetite` 重算 `getBellyState(...)` 的 `digestionRemainingSec`，与提交后服务端 `presentFish` 按新胃口缩短休眠时长的行为不一致。
- 要求：当 `increments.appetite > 0` 且 `belly.isStuffedFull` 时，直接以新 `appetite` 调用 `getBellyState(fish.rawBellyLoad, true, fish.bellyUpdatedAt, fish.level, appetite, now)` 预览真实结果。

---

## 允许修改范围与红线
- 仅允许修改：`src/tank/TankCanvas.tsx`、`src/tank/FishProfileModal.tsx`（以及如有必要的 `src/styles.css`）。
- 严禁 `git commit`、`git push`、`git reset` 或修改禁止文件。
- 修改完成后请真实执行 `pnpm run typecheck`、`pnpm test` 与 `pnpm run build` 确认全部通过后汇报。
