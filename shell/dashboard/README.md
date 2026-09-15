# shell/dashboard —— 空间仪表盘（法医 / 管理员 shell）

> 独立进程、独立端口 4421，与 webui 真并列零共享。定位见 `docs/architecture.md`「stem 空间与 SQLite」。

## 职责

数据源两路：

- **SQLite 只读直查 `db.ts`**：个体层同步 write-through，行即运行态实时镜像（族谱/token 账目/语料/原表）。
- **纯内存标本装配 `inventory.ts`**：`bootStem({ stateStore: false })` 的矩阵装载 + `materialize(根)` 生效可见集 = 资源清单单一真相。

**清理为唯一写通道 `cleanup.ts`**：`--allow-write` 进程姿态 + `confirm=yes` 双确认；孤儿箱 GC / terminated 语料 GC / 定点 purge（active 需 force）/ VACUUM，附 freelist 回收估计。

## 前端（`public/`）

复用 webui `view.js` 纯函数核心（行序/字形），OLED 同语言；`app.js` + `index.html` + `style.css`。

## 文件

| 文件 | 内容 |
|---|---|
| `server.ts` | HTTP 服务（4421）+ 路由 |
| `db.ts` | SQLite 只读直查 |
| `inventory.ts` | 纯内存标本装配（资源清单） |
| `cleanup.ts` | 清理写通道（`--allow-write` + `confirm=yes`） |
| `public/` | 前端（复用 webui view.js） |
| `dashboard.test.ts` | 单测 |
