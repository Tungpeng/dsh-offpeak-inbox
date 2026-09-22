# 开源化与发布清单（当前状态）

> 本文件描述**此刻的真实状态**，不是计划。每条结论都有可复现的证据；做过的事标 ✅ 并写清证据，没做的写清卡在哪里。
> 审计历史：第一轮独立审计推翻了「本机路径已清零」与两处文档失实，均已处理。第二轮独立审计（2026-09-22，公开前）推翻了「无隐私残留」——测试夹具里写着仓库主人的真实站点名与片源编号，已在公开前替换并把旧历史整体重做，见「1」；该轮同时点出两处文档失实（提交数、测试项数），下文已按实测更正。
> 第三轮（2026-09-22 晚，用户在真机上打开设置页时报障）：报错 `registration.schema.toJSON is not a function`。根因不在设置页而在本插件——0.1.0 注册给设置系统的 schema 是个没有 `toJSON` 的普通函数，而宿主序列化**每一个**已注册 schema 时中间没有兜底，于是整条 `settings/describe` 抛错（同部署下**所有**插件的设置卡片一起失效，不只是本插件）。修复见「1」，带缺陷的 0.1.0 Release 与 tag 已删除，见「5」。

## 0. 已拍板

| 决策 | 结论 |
|---|---|
| 基座 | 以现有 `dsh-offpeak-inbox` 为基座清理，不重写 |
| 分发渠道 | **发 npm + GitHub Release 附预构建 tarball**；市场收录不要求 npm，但 npm 决定市场是否显示下载量 |
| 收录目标 | **必须进 DSH 插件市场**（规则与投稿内容见 `docs/MARKET-LISTING.md`） |
| 首个公开版范围 | 0.1.0 先把仓库与分发做干净；P0 三项（取消执行、逐条选执行身份、并发上限可配）作为 0.2.0 |
| 署名与许可 | MIT，版权人 `Tungpeng` |

## 1. 已完成 ✅

| 项 | 证据 |
|---|---|
| 本机绝对路径清零 | `tsconfig.json` 已无 `paths`/`typeRoots`；`scripts/strip-client-types.mjs` 用 `import.meta.dirname` 推根目录、tsc 取本地依赖；本机部署诊断脚本（4 个，含硬编码日志路径与 profile 路径者）已移出仓库 |
| 仓库自包含 | 本仓库自带 `node_modules`（pnpm），`@deepseek-ai/cordis` 锁 4.0.2；独立审计做过反向验证：把本地 cordis 改名后 `test/runtime.test.ts` 立刻报找不到包——**不存在回退到别处检出的路径** |
| 类型检查两处干净 | `npm run typecheck` = `tsc --noEmit && tsc -p tsconfig.client.json --noEmit`，退出码 0 |
| 测试全绿 | `npm test`（含 `pretest` 构建）：5 个文件、**117 项通过**（本地 vitest 3.2.7）。更早一次同环境读数为 4 个文件 83 项；差额来自其后新增的客户端与投递测试，不是失败项。2026-09-22 替换夹具后复测 111 项；修设置页缺陷时新增 6 项（序列化结构 1 + 字段描述 1 + 下限一致 1 + 引用完整性 1 + 信封不可变 1 + 运行时读取 1），复测 5 文件 117 项 |
| 构建自包含且输出正确 | `npm run build` 产出 `lib/index.mjs`（0.1.1 起 **59485 字节**，0.1.0 时 57169）+ `lib/client.js`（**55847 字节**，未改动）。**读日志时注意**：构建链打印的 `59.48 kB` / `54849 bytes` 是 JS 字符串长度，落盘的是 UTF-8 字节数，两者相差中文字符数×2，不是「产物与源码不同步」。已修两处旧隐患：`tsdown` 未指定输出目录会落到 `dist/`、构建脚本用管道捕获子进程输出会在受限沙箱下 EPERM |
| 新克隆可直接跑测试 | 新增 `pretest`，`npm test` 会先构建（运行时测试打的是构建产物） |
| npm 发布元数据 | `private` 已移除；`repository`/`homepage`/`bugs`/`author`/`keywords` 齐备；`prepare`（源码直装）与 `prepublishOnly`（构建→类型检查→测试）就位 |
| 包内容干净 | `npm pack` 实测 **17 个文件 / 90320 字节**（0.1.1；0.1.0 时 88327，差额来自 index.mjs 与文档）：含 `lib/index.mjs`、`lib/client.js`、`cordis.patch.yml`、`src/*.ts`、`LICENSE`、`README.md`、`README.zh.md`、`package.json`；**不含** `src/client.js` 与 `lib/*.map`。已去掉 `--sourcemap`，避免产物里留悬空的 map 引用 |
| 设置页缺陷已修（0.1.1） | 复现：用本机真机在跑的 `@deepseek-ai/dsh-settings` + 真实 schemastery 3.18.2 建一个内存 provider，注册 0.1.0 的 `lib/index.mjs` 后调 `describe()` → `TypeError: registration.schema.toJSON is not a function`（探针放在工作区 `.probe/offpeak-settings-probe.mjs`，不进仓库；修复前 8 项里 1 项 FAIL、退出码 1）。修复后同一探针 8 项全 PASS，含 `new Schema(json)` 反序列化、六个配置键、默认值与真实取值的 schema 校验。回归防线双保险：`test/service.test.ts` 逐条解析 `refs` 引用并核对字段类型/默认值/下限；`test/runtime.test.ts` 的假宿主改成与真宿主一样在读 schema 时调 `toJSON()`——实测把构建产物里的 `toJSON` 摘掉后该测试即变红。**这条防线是半循环的，别当成宿主契约**：那句 TypeError 文本是假宿主自己抛的（`test/runtime.test.ts` 内），它守得住「产物丢了 `toJSON`」，守不住「宿主以后换了调用方式」；真宿主契约由仓库外的探针持有，**宿主升级后必须重跑探针**。另：`package.json` 版本 0.1.0 → 0.1.1，两份 README 的「部署注意」补了这条坑 |
| 许可证与忽略规则 | `LICENSE`（MIT，Tungpeng）；`.gitignore` 覆盖 `node_modules/`、`lib/`、`dist/`、`src/client.js`、`.client-strip/`；`.gitattributes` 统一换行 |
| 夹具不含真实素材 | 2026-09-22 公开前审计发现 `test/client.test.ts` 的搜索夹具直接使用仓库主人的真实站点名与片源编号。已换成中性样例（`整理旧清单与归档脚本`、`样例站点`、`SampleFeed`、`核对样例条目并更新索引`），并按 `matchesQuery` 的真实语义（**整串子串匹配，不切词**）同步改写查询串与断言 |
| Git 历史干净 | 全新历史，撰写时为 **5 个提交**（发布提交 `fc7422a` + 3 条文档提交 + 0.1.1 的修复提交 `dd8e85e`）；提交数会随后续提交变化，以 `git log --oneline` 为准。公开内容无产物、无依赖、无个人路径：此前逐 blob 比对与「被替换素材词表」检索的结论未变；本轮复核的是**本地与远端同树**——`git fetch origin` 后本地 `HEAD` 与 `origin/main` 同为 `dd8e85e`（提交 SHA 相同即同一棵树），树内 36 个 blob。**词表本身不写进本文件**——把待清除的词抄进说明里，等于换个位置又公开一次（本行初稿就这么错过一次） |
| GitHub 仓库已建并公开 | `https://github.com/Tungpeng/dsh-offpeak-inbox`：`private=false`、默认分支 `main`、topics = `dsh-plugin` 等 7 个。**2026-09-22 12:10 UTC 删库重建过一次**（为彻底清除改历史前的旧对象，缘由见「5」），因此市场投稿要求的「仓库创建满 1 天」从该时刻重新起算，而不是首次建库的时间 |
| CI 双平台通过 | 最新 run #3（提交 `dd8e85e`，0.1.1）：`check (ubuntu-latest, 22)` 与 `check (windows-latest, 22)` 均 **success**。更早的 run #1（`4017a1e`）与 run #2（`6ea01b6`）同样双平台 success |
| Release 与预构建 tarball | 当前**只有 `v0.1.1`** 一个 Release（tag `v0.1.1` → 提交 `dd8e85e`），资产名**不带版本号** `dsh-offpeak-inbox.tgz`，因此市场要用的 `releases/latest/download/dsh-offpeak-inbox.tgz` 永远指向最新一版。带设置页缺陷的 `v0.1.0` Release 与 tag 已于 2026-09-22 **删除**（`DELETE /releases/<id>` 与 `DELETE /git/refs/tags/v0.1.0` 均返回 **204**），本地 tag 一并删除；删前它的资产是 88327 字节 |
| 0.1.1 资产已发布（2026-09-22） | 提交 `dd8e85e`、tag `v0.1.1`、Release `v0.1.1`。资产：**90320 字节**，SHA256 `32C5C67DD4895DEBEE1AFC5D43156387330CAFD93A3BE823C2E094A545E7E8DB`。发布前**独立重打一次包**（`npm test` 重建 → `npm pack`），与另一会话预构建的那份**逐字节相同（同 SHA256）**；解包后 `lib/index.mjs` 59485 字节、SHA256 `C18E5AEF5593719592CA7659A7CDC1ED73C4D23220E8FCBCAB79012D980E807F` 与现场构建产物**逐字节相同**（防「验 A 传 B」陷阱）；`package.json` = `0.1.1`。**终局验证**：从市场要用的 `releases/latest/download/dsh-offpeak-inbox.tgz` 真下载回来——90320 字节、SHA256 相符、包内版本 0.1.1、内含 `toJSON` 修复 |
| 旧对象已彻底清除 | 删库重建后实测：`GET /repos/Tungpeng/dsh-offpeak-inbox` 复原为 201 前先返回 **404**，`GET /repos/.../commits/<改历史前的提交>` 返回 **404**，其 `raw.githubusercontent.com` 路径同样 **404**。即那份带真实素材的旧夹具在 GitHub 上不再可达——这是强制推送做不到、只有删库才能做到的一步 |
| npm 自动发布已设闸门 | `publish.yml` 的 job 加 `if: vars.NPM_TRUSTED_PUBLISHING == 'true'`。实测推 `v0.1.0` 与 `v0.1.1` 两次 tag 后，该 workflow 结论均为 **skipped（灰）而非失败**，不给新仓库留红色记录；npm 侧配置完成后把仓库变量设为 `true` 即恢复自动发布 |
| CI 工作流 | `.github/workflows/ci.yml`：pnpm 10 + `--frozen-lockfile`，`typecheck → build → test`（顺序保证构建产物先于测试），矩阵 Linux + Windows，Node 22；`pnpm-lock.yaml` 已入库 |
| 双语文档 | `README.md`（英文）+ `README.zh.md`（中文），安装段给出三条可用路径（预构建 tarball / `github:` 源码 / npm）并标明 npm 尚未发布；配置表按代码实际键名更正为 `launchIntervalSeconds`（默认 10，地板 2，旧名 `tickSeconds` 仍兼容） |
| 市场投稿内容 | `docs/MARKET-LISTING.md` 内含可直接提交的 YAML，已按市场全部硬规则逐条核对通过（文件名、分类、描述引号、不手写 `npm:` 键、tarball 资产名不带版本） |

## 2. 剩余 —— 需要你本人操作

| # | 事项 | 为什么只能你来 |
|---|---|---|
| U1 | **npm 登录**：`npm login`（当前 `npm whoami` 报 `ENEEDAUTH`） | 需要你的账号与密码/双因素，不应经过我 |
| U3 | **发布 npm**：`npm publish`（仓库地址已按 `Tungpeng/dsh-offpeak-inbox` 填好；现在会发 **0.1.1**，不是带缺陷的 0.1.0） | 同上，且发布不可撤销 |
| U5 | **投稿市场**：仓库创建满 **1 天**后（重建时刻 2026-09-22 12:10 UTC 起算，即 2026-09-23 12:10 UTC 之后），向市场主仓库提 PR 新增 `data/plugins/Tungpeng__dsh-offpeak-inbox.yml` | PR 用你的账号提交 |

> 「彻底删除旧对象」原本列在这里作为可选项，已由仓库主人于 2026-09-22 删库完成，见「1」与「5」。U2「提交并发布 0.1.1」也原列在这里，已于同日完成（提交 `dd8e85e`、tag `v0.1.1`、Release 已上传并从市场链接下载复验），见「1」。`latest/download` 现在指向修好的 0.1.1，投稿 PR 不再被它阻塞。

## 3. 剩余 —— 我可以继续做

| # | 事项 | 说明 |
|---|---|---|
| R1 | P0 三项（0.2.0） | 取消执行中的条目、逐条指定执行身份（模型/推理强度）、并发上限可配。当前"每轮最多启动一条"仍写死在调度器里；`launchIntervalSeconds` 只控制排空速度 |
| R2 | `screenshots.json` + 面板截图 | 市场详情页截图，放仓库根、列 1–8 张相对路径；不声明则市场从 README 兜底抽取 |
| R3 | `CONTRIBUTING.md` / `SECURITY.md` | 接口能创建真实会话，建议有安全说明 |
| R4 | 面板文案本地化 | 目前面板文案是硬编码中文；走向国际用户需走字典 |
| R5 | 面板「删除」加二次确认 | 面板删除无确认、账本 `splice` 硬删且无撤销，数据只能手工翻 JSON 找回 |

## 4. 发布流程（当前进度）

```sh
# 1) 建远程并推送 —— ✅ 已完成（origin 已指向 https://github.com/Tungpeng/dsh-offpeak-inbox.git）
git remote add origin https://github.com/Tungpeng/dsh-offpeak-inbox.git
git push -u origin main

# 2) 发布 npm（先补 U1）—— 待做，发的是 0.1.1
npm publish

# 3) 产出 Release 资产 —— ✅ 已完成（v0.1.1，资产名 dsh-offpeak-inbox.tgz，90320 字节）
npm pack
# 把生成的 dsh-offpeak-inbox-<版本>.tgz 重命名为 dsh-offpeak-inbox.tgz 后上传到 Release
# ⚠️ 时序：npm test / npm pack 都会重写 lib/。必须在**最后一次构建之后**打包，并解包比对
#    lib/index.mjs 的 SHA256 与现场构建产物一致，不相等就作废重打（缘由见「5」）。

# 4) 验证市场里的 tarball 链接确实可下载 —— ✅ 已完成并解包复验（90320 字节、版本 0.1.1、含 toJSON 修复）
```

## 5. 已知风险与边界

- **v0.1.0 的 Release 资产带设置页缺陷（2026-09-22 用户真机报障）**：`registration.schema.toJSON is not a function`。这条不是本插件自己坏掉那么轻——宿主的 `SettingsProvider.describe()` 会遍历**所有**已注册命名空间并调 `schema.toJSON()`，一个不合格的 schema 会让整条 `settings/describe` 抛错，于是同一部署里**别的插件**的设置卡片也一起打不开。已修在 0.1.1（见「1」）。**那份带缺陷的构建已随 `v0.1.0` Release 与 tag 于 2026-09-22 删除**，`releases/latest/download/...` 现在指向修好的 0.1.1，市场投稿不再被这一步阻塞。
- **「验的是 A、传的是 B」的打包时序陷阱（2026-09-22 实测踩到半步）**：本次 tarball 生成于 19:17:17，而最后一次 `npm run build`（`npm test` 的 `pretest`）在 19:18:52 —— 打包早于最后一次构建。这次两边字节相同（`lib/index.mjs` 的 SHA256 均为 `C18E5AEF5593719592CA7659A7CDC1ED73C4D23220E8FCBCAB79012D980E807F`）所以没出事，但顺序本身不可依赖：`npm test` 与 `npm pack` 都会重写 `lib/`。规则：**最后一次构建之后才打包，打包后解包比对 `lib/index.mjs` 的 SHA256**（0.1.1 的资产已按这条规则重打并比对，见「1」）。
- **强制推送清不掉旧对象，删库才行（2026-09-22 已解决）**：重做历史用的是强制推送，而 GitHub 不会立即回收不可达对象——实测旧提交在强推之后仍能按 SHA 取到。因此改由仓库主人在网页端删库，随后重建、重推、重挂 Release。重建后实测：仓库建成前为 404、旧提交在 API 与 `raw.githubusercontent.com` 两条路径上均为 **404**，那份带真实素材的夹具已不可达。代价是仓库创建时间、star/issue 计数与旧 Actions 记录一并重置，市场投稿的「满 1 天」重新起算。本机存有的 GitHub 凭据只有 `gist, repo, workflow` 三个 scope，**没有 `delete_repo`**（实测 `DELETE /repos/...` 返回 403），所以删库这一步只能由仓库主人做。
- **仓库是与另一个会话共用的工作区**：2026-09-22 发布 0.1.1 期间实测到另一会话正在同目录改文件。教训：**不要用 `git add -A`**——一次差点把别人未完成的三处改动（`src/config.ts` 与两个测试文件）当成自己的提交推上去（推送恰因 DNS 失败未发出，随后已 `git reset` 撤回并改为逐个文件显式 add，对方工作全程保留）。以后在本仓库提交一律显式列路径。
- **npm 的 `private` 字段**：本机实测 `npm publish --dry-run` **不会**拦它（退出码 0），所以别指望 dry-run 提前发现；真实发布时才会以 `EPRIVATE` 拒绝。证据等级：报错文案与社区问答一致，但未在本机复现（缺账号）。
- **`latest/download/` 的时效陷阱**：该形式只在请求时解析 `latest`，文件名照字面取；资产名带版本号会在你下次发版后静默 404。
- **市场会移除条目**：仓库消失、长期停更、或"存在明显缺陷"的条目会被移除，收录不是永久的。
- **公开前自查**：本目录的文档若含任何用户名或盘符，必须先替换为占位符或移出公开范围（本文件已做前者）。注意**正则扫描挡不住中文业务词**——本轮泄漏的站点名与片源编号不含任何路径或密钥特征，是人工读夹具才发现的。
- **`Asia/Jakarta` 仍是测试里的示例时区**（3 个测试文件共 12 处）。它单独不构成识别信息（UTC+7、无夏令时，是常见的测试时区选择），且改动会连带改掉断言里的时间字符串；如需一并中性化，属于独立一步。
- **面板刷新与构建的旧坑**都记在 `README.md` / `README.zh.md` 的"部署注意"里，避免后人重踩。
- **`link:` 挂载必须先构建，否则整个 `dsh web` 起不来**（2026-09-16 真实事故，约半小时崩溃循环）：`link:` 直指源码目录，而 `lib/` 不入库；`lib/client.js` 一旦缺失，宿主在加载插件阶段直接退出，守护按 5/10/20/40/80/120 秒退避重启，外观上就是"卡死"。已在本机 `restart-dsh-web.ps1` 前置 `ensure-plugin-builds.ps1` 自动补齐（实测：删掉 `lib/client.js` 后守卫会重新构建并报就绪）。对使用者的可见影响已写进两份 README。
- **Windows PowerShell 5.1 的 `.ps1` 编码陷阱**：无 BOM 的 UTF-8 中文会被按 ANSI 读而破坏字符串、导致脚本整体解析失败（本次实测踩到，且编辑工具重写文件会静默丢掉 BOM）。写给 5.1 的脚本要么带 UTF-8 BOM，要么只用 ASCII；读 JSON 时也要显式 `-Encoding UTF8`，否则中文描述会让 `ConvertFrom-Json` 失败并**静默跳过**后续检查。
- **插件装上即拥有创建并驱动真实会话的能力**：HTTP 路由只靠 loopback + same-origin 把关，同机其它本地进程也能 POST `/api/offpeak-inbox/action`；`R3` 的安全说明就是为了把这条讲清楚。
