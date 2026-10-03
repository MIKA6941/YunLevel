# YunLevel 云端优化改动清单

> 版本：**v2**（2026-09-26，新增 P1-6「教师看板降流量」）
> 适用工程：`<项目目录>`
> 说明：本清单只记录"要改什么、改哪里、怎么验收"，**尚未执行**。
> 行号基于 2026-09-26 的工程快照，改动前请重新核对。
> 关联：云服务器选型见同目录《YunLevel-ECS选型方案与注意事项.md》

---

## 现状实测备忘（后面所有结论的依据）

### A. 代码事实

| 事实 | 出处 |
| --- | --- |
| 教师云端导出**只导"云端方案 1"**（槽位写死为 1） | `server\server.js:964` `getProject(classInfo.id, student.studentId, 1)` |
| 导出 zip 每生只含 4 样：`params.json` + 3 张 PNG + 导出状态.txt | `server\server.js:996-1000` |
| **`state.bin`（546 KB）不进导出包**，只落在服务器磁盘 | `server\snapshot-store-v2.js:209-222` |
| 导出 zip **全内存构建**后一次性发送 | `server\server.js:1051` `buildZip(entries)` → `res.end(buffer)` |
| 曲线图片画布 1200×520，无 DPR 放大 | `public\app.js:1911-1912` |
| 单生导出体积 ≈ 100~200 KB；**60 人整班 ≈ 6~12 MB** | 由以上三条推算 + 工程内 267 张真实 PNG 实测 |
| 首屏 1.19 MB，其中 `xlsx.full.min.js` 占 930 KB（78%） | `public\index.html:7,712,713` |
| xlsx 是同步 `<script>` 加载，但只在导出/导入 Excel 时才用 | `public\index.html:712` vs `public\app.js:1762,3551` |
| 服务端**已禁止学生导出工程包** | `server\server.js:1189`、`server\server.js:1223`（学生 403） |
| 静态资源**无 gzip/br 压缩** | `server\server.js` 静态响应只有 `Cache-Control` |
| 教师看板**每秒全量重发全班摘要** | `server\server.js:371` `emitOverviewNow()` + `server\server.js:340` `overview()` |

### B. 本机实测数据（编译 `native\engine.cpp` 跑 36000 tick）

| 指标 | 实测值 |
| --- | --- |
| 每生每秒下行 payload | **1343 B**（无回路）/ **1957 B**（4 回路） |
| 每生每秒 CPU | **0.0043 ms** |
| 每生进程内存 RSS | **4.43 MB** |
| Node 每生历史内存 | 约 230 KB（1800 点 × 16 字段 × 8 B） |
| 教师看板每秒下行（65 人） | **约 130 KB/s**（推算，见 P1-6） |
| 65 人 + 1 教师合计每秒下行 | 约 257 KB/s ≈ 2.1 Mbps |
| 65 人每小时 / 每月（10h×6天） | 约 925 MB/h / 约 243 GB/月 |

### C. 优先级总览

| 编号 | 事项 | 优先级 | 预计工作量 |
| --- | --- | --- | --- |
| 1 | 开启 gzip/br 压缩 | P0 | 半小时 |
| 2 | xlsx 改为懒加载 | P0 | 半小时 |
| 3 | 学生端禁止导出 | P0 | 半小时 |
| 4 | 导出增加"曲线数据 CSV" | P1 | 1~2 小时 |
| 5 | 导出增加"仅数据/仅图片/全量"选项 | P1 | 1~2 小时 |
| 6 | **教师看板降流量** | **P1** | **2~4 小时** |
| 7 | zip 改流式输出 | P2（暂缓） | 2~3 小时 |
| 8 | 运维项（随部署） | P0 | 1 小时 |

---

## P0 · 上线前必做

### 1. 开启 gzip/br 压缩

- **位置**：`server\server.js` 静态文件响应分支（约 `server\server.js:1568` 起）
- **改法**：对 `.html/.js/.css/.json/.svg` 判断 `Accept-Encoding`，命中则 gzip，响应头加 `Content-Encoding: gzip` 与 `Vary: Accept-Encoding`
- **收益**：首屏 1.19 MB → 约 350 KB；65 人集中登录 114 s → **33 s**
- **验收**：`curl -I -H "Accept-Encoding: gzip" http://IP:8080/app.js` 返回 `Content-Encoding: gzip`，`Content-Length` 明显缩小
- **注意**：gzip 结果建议启动时算一次并缓存，不要每请求重压缩

### 2. xlsx 改为懒加载

- **位置**：`public\index.html:712` 删除 `<script src="/vendor/xlsx.full.min.js"></script>`；`public\app.js:1762`、`public\app.js:3551` 使用前改为动态 `import()` / 动态插 script 后 await
- **收益**：首屏 1.19 MB → 285 KB；配合第 1 项后 65 人登录 33 s → **8 s**
- **验收**：学生端登录后 Network 面板中**没有** `xlsx.full.min.js`；点击导出 Excel 时才出现
- **顺手**：学生端已不需要 xlsx，可只给教师端加载

### 3. 学生端禁止导出

- **服务端已就绪**（`server\server.js:1189,1223`），**无需改动**
- **前端改 3 处**：
  - `public\index.html:95` `#exportParamsCsvBtn`
  - `public\index.html:96` `#exportParamsExcelBtn`
  - `public\index.html:428` `#curveExportBtn`
  - 绑定处 `public\app.js:3958`、`public\app.js:3960`、`public\app.js:2611` 加 `role === 'student'` 判断
- **验收**：学生账号登录后 3 个按钮不可见、点击无反应
- **必须知道的局限**：**前端隐藏挡不住 F12**。曲线数据必须下发到浏览器才能绘制，从控制台/抓包仍可拿到。这一步只是"不给顺手出口"，不是安全边界。要真防须改成服务器只下发渲染好的图片——另一个量级的改造，不建议为教学场景做。

---

## P1 · 数据统计与成本优化

### 4. 导出增加"曲线数据 CSV"

- **背景**：现在教师拿到的是**参数表 + 3 张曲线图片**，**没有原始时序数据**（`history.json` 不在导出里）。要做数值分析是不够的——光有图没数。
- **位置**：`server\server.js:996` 附近 `entries.push`，每生新增一份时序 CSV
- **数据来源**：槽位目录下的 `state.bin`（含历史数组）或 `history.json`，取 `t/h1/h2/h3/mv/qin/qout` 等列
- **验收**：导出 zip 里每生多一个 `曲线数据.csv`，Excel/pandas 可直接读，行数与仿真时长对得上

### 5. 导出增加"仅数据 / 仅图片 / 全量"选项

- **位置**：`server\server.js:1051` `buildTeacherCloudExport()` + 前端 `public\index.html:598` `#exportCloudZipBtn` 旁加选项
- **改法**：按选项过滤 `entries`；"仅数据"= 汇总 CSV + 每生参数/曲线 CSV（几十 KB~几 MB），"仅图片"= 只打 3 张 PNG
- **验收**：三种选项各导出一次，zip 内文件构成符合预期

### 6. 教师看板降流量 ★ v2 新增

- **问题**：`server\server.js:371` `emitOverviewNow()` **每秒把全班每个学生的完整 `summary` 全量重发**一次，每个开着的教师连接各收一份。
- **实测规模**（65 人）：每生 `summary` 约 1.5~2.5 KB → **约 130 KB/s**
  **这一项和全部 65 个学生自己的流量（127 KB/s）几乎一样多。** 重载档下教师看板一项就占月流量的 50%（约 122 GB/月）。
- **来源**：`server\engine-session.js:63` 的 `get summary()`，字段含：
  - 16 个位号 `tags` + 21 个状态量（`mode/h1/h2/h3/simTime/pump/pumpCmd/fv101~104/fv101cmd~104cmd/sp1~3` 等）
  - `loopParams`：每条回路 11 个字段（`pv/mv/enabled/manual/action/sp/kp/ti/td/out/manualOut/pvValue`），最多 4 条
  - `cascadeParams`：每条串级 18 个字段，最多 2 条
  - 评分细分（`scoreTotal/control/safety/benefit/operation` 等）

**改法（分两步，先做第一步）**

**第一步：删冗余字段（低风险，不动协议）**
- **顶层与 `tags` 明显重复**：`h1,h2,h3,sp1,sp2,sp3,pump,fv101~104` 这 12 个数字在 `tags` 里已有一份 → 删顶层那批（约 200 B/生）
- **`loopParams` 里看板用不到的**：`manualOut`、`pvValue`、`action` → 删（11 个里删 3 个）
- **`cascadeParams` 里的 `innerPvValue`、`outerPvValue`、`outerManual`、`innerManual`** → 如看板未使用则删
- **预估**：砍掉 **50~65%**，130 KB/s → 约 45~65 KB/s

**第二步：改增量推送（收益更大，需前端配合）**
- 服务端只发**有变化的行**，外加每秒一个心跳；前端按 `studentId` 做 merge
- 或把看板频率从 1 Hz 降到 0.5 Hz（看板是给人看的，2 秒一次足够）
- **预估**：再砍一半以上，最终 **15~40 KB/s**

**验收**
- 服务端加临时打点，统计 `emitOverviewNow()` 每次 `payload` 的字节数与每秒次数
- 或用 Chrome DevTools → Network → 该 SSE 连接，观察每秒接收字节数
- 目标：65 人场景下 **≤ 40 KB/s**

**注意**
- 改字段前先确认教师端前端到底渲染了哪些列，避免删掉正在用的字段
- 若教师端有"逐秒同步曲线"之类依赖 1 Hz 的功能，降频前要一并评估
- 前端 merge 逻辑需要新增，是这项改动的主要工作量

**收益（重载档 10h/天 × 6 天/周）**

| | 现在 | 第一步后 | 第二步后 |
| --- | --- | --- | --- |
| 看板每秒 | 130 KB/s | 约 55 KB/s | 约 25 KB/s |
| 月流量合计 | 约 243 GB | 约 163 GB | 约 130 GB |
| 按流量方案年费 | 约 ¥2557 | 约 ¥1800 | 约 ¥1500 |

→ **做完后"按流量"在重载档也能用**，不必被迫选固定带宽。

---

## P2 · 暂不做，触发条件到了再动

### 7. zip 改流式输出

- **现状**：`server\server.js:1051` 全内存构建 + `res.end(buffer)`
- **触发条件**：**单次导出超过 100 MB 时再做**。当前实测整班只有 6~12 MB，不构成问题，现在改是过度工程
- **改法**：边打包边写响应流（PNG 已是压缩格式，用 store 模式，deflate 白费 CPU）

### 8. 运维项（不属于代码改动）

- 数据盘挂载到 `/opt/YunLevel/data`，**选"不随实例释放"**
- 自动快照：每周 1 次，保留 4~8 份
- 服务器加 2~4 GB swap
- 流量告警：**50 GB/月** 与 **200 GB/月** 两档
- 安全组：SSH 22 限管理员 IP；只用 8080 对外；**不要开 3389**

---

## 附：实测产物（可复核）

| 内容 | 位置 |
| --- | --- |
| 编译好的引擎 | `work\yunengine-measure\yunengine.exe` |
| 3600 tick 输出（无回路） | `work\yunengine-measure\outA.txt` |
| 36000 tick 输出（4 回路） | `work\yunengine-measure\outC.txt` |
| 选型方案与注意事项 | `outputs\YunLevel-ECS选型方案与注意事项.md` |

**一句话总结**
**P0 三项（gzip / xlsx 懒加载 / 学生禁导出）是上线前必做，把首课登录从 114 秒压到 8 秒；P1-6（教师看板降流量）是省钱项，做完重载档也能走按流量方案。**