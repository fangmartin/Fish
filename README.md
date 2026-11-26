# 潮汐鱼缸

打开网页即可观赏公共鱼缸。设置养鱼人昵称后，可在三栏画板手绘鱼或导入图片涂鸦、放生下水，并用鱼食观察鱼群抢食。通行码用于跨设备找回身份和图鉴。

## 本地运行

需要 Node.js 24 和 pnpm。第一次启动时鱼缸为空。

```sh
pnpm install
pnpm dev
```

开发地址默认是 `http://localhost:5173`。Vite 把 `/api` 转发到 Node 服务。

```sh
pnpm run typecheck
pnpm test
pnpm run build
pnpm start
```

生产地址默认是 `http://localhost:3000`。同一个 Node 进程提供前端静态资源、API 和 SSE。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Node 监听地址 |
| `PORT` | `3000` | Node 监听端口，开发代理使用相同端口 |
| `DATA_DIR` | `./data` | SQLite 与鱼画作存储目录 |
| `DB_PATH` | `$DATA_DIR/tank.sqlite` | SQLite 文件路径 |
| `REGISTER_IP_DAILY_LIMIT` | `8` | 单 IP 每个上海自然日的身份创建上限 |
| `DROP_IP_MINUTE_LIMIT` | `30` | 单 IP 每分钟的撒食请求上限 |
| `ADMIN_SECRET` | 未设置 | 管理员清理接口的 `X-Admin-Secret` 请求头值 |

SQLite 使用 WAL，贴图保存在 `$DATA_DIR/fish/`。关闭服务后可备份整个数据目录。若单独覆盖了 `DB_PATH`，备份时一并保留数据库文件。IP 频控依据服务端连接的来源地址。

## 运行机制

鱼食罐上限为 20 颗，投放即扣除。登录并保持页面打开时每分钟恢复 1 颗，离线后暂停计时。浏览器在当前水域切片演算游动、下沉和鱼嘴碰撞。投放者提交进食候选，服务端原子结算有效经验、属性点与吃撑状态。下水、进食、属性变化、归档和隐藏事件通过 SSE 同步给所有连接。

画板使用透明 Canvas，可导入 PNG、JPEG 或 WebP。画笔、橡皮、填充、吸管和直线快捷键分别为 `B`、`E`、`G`、`I`、`L`。用 `Ctrl/Cmd+Z` 撤销，按住 `Shift` 重做。下水时自动裁切并压缩为最长边 512 像素、体积不超过 256 KB 的透明 PNG，同时永久锁定画作与鱼名。
