# 自绘养鱼应用 (Draw & Raise Fish)

一个多人共享的网页端赛博养鱼空间，玩家在画板中通过自由绘制或导入图片二次涂鸦创造专属的鱼，并在每日有限的撒食争抢互动中见证它们从小鱼苗成长为鱼王。

## Language

### 空间与身份

**公共鱼缸 (Shared Tank)**:
全服所有在养 **鱼 (Fish)** 共同归属的共享水域，供所有玩家观赏与投喂。
_Avoid_: 个人鱼缸 (Private Tank), 游戏大厅 (Lobby), 画廊 (Gallery)

**水域切片 (Tank View)**:
从 **公共鱼缸 (Shared Tank)** 中按同屏舒适上限动态抽样呈现的一组 **鱼 (Fish)** 集合（必含当前 **养鱼人 (Keeper)** 自己的在缸鱼），支持随时换水刷新或搜索直达。
_Avoid_: 房间号 (Room), 服务器分线 (Shard)

**养鱼人 (Keeper)**:
拥有独立身份与昵称的参与者，在 **公共鱼缸 (Shared Tank)** 中最多同时持有固定槽位数量的在缸 **鱼 (Fish)**，并持有 **每日投喂配额 (Daily Ration)**。
_Avoid_: 注册用户 (Registered User), 游客 (Guest), 账号 (Account)

**通行码 (Passcode)**:
系统为每位 **养鱼人 (Keeper)** 生成的唯一恢复口令，用于在更换设备或浏览器时找回身份与名下的 **鱼 (Fish)**。
_Avoid_: 密码 (Password), 激活码 (Activation Key), 邀请码 (Invite Code)

### 鱼与创作

**鱼 (Fish)**:
由 **养鱼人 (Keeper)** 在画板中自由绘制或导入图片二次涂鸦并经 **下水 (Release)** 诞生的个体，外观图案与名字自诞生起永久锁定，仅通过争抢吃掉 **鱼食 (Pellet)** 增长体型直至封顶，不会因断喂而萎缩或死亡。
_Avoid_: 电子宠物 (Pet), 皮肤 (Skin), 贴纸 (Sticker)

**鱼形模板 (Stencil)**:
画板中默认开放的鱼类剪影轮廓，供创作者垫底参考或按需开启轮廓内涂色限制，但不强制约束 **鱼 (Fish)** 的外形边界。
_Avoid_: 预设外观 (Preset), 强制蒙版 (Strict Mask)

**下水 (Release)**:
将画板中定稿的图案与名字正式转化为一条初生 **鱼 (Fish)** 并投入 **公共鱼缸 (Shared Tank)** 的不可逆操作。
_Avoid_: 发布 (Publish), 保存 (Save), 孵化 (Hatch)

**深海归档 (Deep-Sea Archive)**:
将某条在缸 **鱼 (Fish)** 移出 **公共鱼缸 (Shared Tank)** 活跃池、永久收入 **养鱼人 (Keeper)** 个人图鉴以腾出在养槽位的操作。
_Avoid_: 删除 (Delete), 献祭 (Sacrifice), 出售 (Sell)

### 投喂与成长

**每日投喂配额 (Daily Ration)**:
每位 **养鱼人 (Keeper)** 在单个自然日内可投放 **鱼食 (Pellet)** 的固定次数上限，每日零点重置且未使用的次数不跨天累加。
_Avoid_: 体力值 (Stamina), 鱼币 (Coins), 经验包 (XP Pack)

**鱼食 (Pellet)**:
消耗一次 **每日投喂配额 (Daily Ration)** 在水体指定位置投下的食物颗粒，会缓慢下沉并停留在缸底直至被吃掉；除已撑到吃不动的个体外，所有 **鱼 (Fish)** 均会参与争抢。
_Avoid_: 定向投喂 (Direct Feed), 点赞 (Like)

**每日饱食上限 (Daily Satiety Cap)**:
单条 **鱼 (Fish)** 在单个自然日内最多可转化为有效升级经验的 **鱼食 (Pellet)** 数量上限，每日零点重置。
_Avoid_: 冷却时间 (Cooldown), 疲劳值 (Fatigue)

**成长阶段 (Growth Stage)**:
**鱼 (Fish)** 从初生到满级体型封顶过程中随 **等级 (Level)** 晋升依次跨越的四个外观尺寸称号：**鱼苗 (Fry)**、**幼鱼 (Juvenile)**、**成鱼 (Adult)** 与 **鱼王 (Leviathan)**。
_Avoid_: 星级 (Star Tier), 进化形态 (Evolution)

**等级 (Level)**:
**鱼 (Fish)** 通过累计有效进食、按阶梯递增经验门槛提升的养成阶梯，每次升级产出可自由分配的 **属性点 (Attribute Point)** 直至满级封顶。
_Avoid_: 段位 (Rank), 转生 (Rebirth)

**属性点 (Attribute Point)**:
由所属 **养鱼人 (Keeper)** 在 **鱼 (Fish)** 的五个水中对抗维度（爆发力、耐力、感知力、灵巧度、冲撞力）间自由分配的强化点数；五维单项设上限且满级总点数仅占总容量的三分之一，迫使每条鱼形成差异化的抢食流派。
_Avoid_: 技能点 (Skill Point), 装备词条 (Gear Stat)

**吃撑状态 (Stuffed State)**:
已达 **每日饱食上限 (Daily Satiety Cap)** 或已满级的 **鱼 (Fish)** 继续抢食 **鱼食 (Pellet)** 时逐层叠加的短期饱腹负反馈；前两层大幅降低移速与转向，第三层进入彻底“吃不动”的停抢状态，经过约一小时消化期后恢复如初。
_Avoid_: 饥饿惩罚 (Starvation), 死亡淘汰 (Death)
