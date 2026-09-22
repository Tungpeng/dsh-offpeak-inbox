# 开源化与发布清单（当前状态）

> 本文件描述**此刻的真实状态**，不是计划。每条结论都有可复现的证据；做过的事标 ✅ 并写清证据，没做的写清卡在哪里。
> 审计历史：第一轮独立审计推翻了「本机路径已清零」与两处文档失实，均已处理。第二轮独立审计（2026-09-22，公开前）推翻了「无隐私残留」——测试夹具里写着仓库主人的真实站点名与片源编号，已在公开前替换并把旧历史整体重做，见「1」；该轮同时点出两处文档失实（提交数、测试项数），下文已按实测更正。

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
| 测试全绿 | `npm test`（含 `pretest` 构建）：5 个文件、**111 项通过**（本地 vitest 3.2.7）。更早一次同环境读数为 4 个文件 83 项；差额来自其后新增的客户端与投递测试，不是失败项。2026-09-22 替换夹具后复测仍为 5 文件 111 项 |
| 构建自包含且输出正确 | `npm run build` 产出 `lib/index.mjs`（57169 字节）+ `lib/client.js`（55847 字节）。**读日志时注意**：构建链打印的 `54849 bytes` 是 JS 字符串长度，落盘的是 UTF-8 字节数，两者相差中文字符数×2，不是「产物与源码不同步」。已修两处旧隐患：`tsdown` 未指定输出目录会落到 `dist/`、构建脚本用管道捕获子进程输出会在受限沙箱下 EPERM |
| 新克隆可直接跑测试 | 新增 `pretest`，`npm test` 会先构建（运行时测试打的是构建产物） |
| npm 发布元数据 | `private` 已移除；`repository`/`homepage`/`bugs`/`author`/`keywords` 齐备；`prepare`（源码直装）与 `prepublishOnly`（构建→类型检查→测试）就位 |
| 包内容干净 | `npm pack` 实测 **17 个文件 / 88327 字节**：含 `lib/index.mjs`、`lib/client.js`、`cordis.patch.yml`、`src/*.ts`、`LICENSE`、`README.md`、`README.zh.md`、`package.json`；**不含** `src/client.js` 与 `lib/*.map`。已去掉 `--sourcemap`，避免产物里留悬空的 map 引用 |
| 许可证与忽略规则 | `LICENSE`（MIT，Tungpeng）；`.gitignore` 覆盖 `node_modules/`、`lib/`、`dist/`、`src/client.js`、`.client-strip/`；`.gitattributes` 统一换行 |
| 夹具不含真实素材 | 2026-09-22 公开前审计发现 `test/client.test.ts` 的搜索夹具直接使用仓库主人的真实站点名与片源编号。已换成中性样例（`整理旧清单与归档脚本`、`样例站点`、`SampleFeed`、`核对样例条目并更新索引`），并按 `matchesQuery` 的真实语义（**整串子串匹配，不切词**）同步改写查询串与断言 |
| Git 历史干净 | 历史被重做为**单一提交** `Release 0.1.0: off-peak inbox for DeepSeek Harness`，工作区干净；公开内容无产物、无依赖、无个人路径。逐文件比对：本地 `git ls-tree -r HEAD` 的 36 个 blob 与远端 `git/trees/<HEAD>?recursive=1` 的 36 个 blob **逐个 SHA 相同**；`git grep -iE "mteam\|bitporn\|养号\|ipvr\|桃谷"` 在公开树上零命中 |
| GitHub 仓库已建并公开 | `https://github.com/Tungpeng/dsh-offpeak-inbox`：`private=false`、默认分支 `main`、topics = `dsh-plugin` 等 7 个 |
| CI 双平台通过 | run #2（提交 `fc7422a`）`check (ubuntu-latest, 22)` 与 `check (windows-latest, 22)` 均 success：`https://github.com/Tungpeng/dsh-offpeak-inbox/actions/runs/35724478683` |
| Release 与预构建 tarball | Release `v0.1.0`，资产名**不带版本号** `dsh-offpeak-inbox.tgz`（88327 字节，`release id=393693969`）；市场要用的 `releases/latest/download/dsh-offpeak-inbox.tgz` 实测 HTTP 200 且 `Content-Length` 相符 |
| npm 自动发布已设闸门 | `publish.yml` 的 job 加 `if: vars.NPM_TRUSTED_PUBLISHING == 'true'`。实测推 `v0.1.0` tag 后该 workflow 结论为 **skipped（灰）而非失败**，不给新仓库留红色记录；npm 侧配置完成后把仓库变量设为 `true` 即恢复自动发布 |
| CI 工作流 | `.github/workflows/ci.yml`：pnpm 10 + `--frozen-lockfile`，`typecheck → build → test`（顺序保证构建产物先于测试），矩阵 Linux + Windows，Node 22；`pnpm-lock.yaml` 已入库 |
| 双语文档 | `README.md`（英文）+ `README.zh.md`（中文），安装段给出三条可用路径（预构建 tarball / `github:` 源码 / npm）并标明 npm 尚未发布；配置表按代码实际键名更正为 `launchIntervalSeconds`（默认 10，地板 2，旧名 `tickSeconds` 仍兼容） |
| 市场投稿内容 | `docs/MARKET-LISTING.md` 内含可直接提交的 YAML，已按市场全部硬规则逐条核对通过（文件名、分类、描述引号、不手写 `npm:` 键、tarball 资产名不带版本） |

## 2. 剩余 —— 需要你本人操作

| # | 事项 | 为什么只能你来 |
|---|---|---|
| U1 | **npm 登录**：`npm login`（当前 `npm whoami` 报 `ENEEDAUTH`） | 需要你的账号与密码/双因素，不应经过我 |
| U3 | **发布 npm**：`npm publish`（仓库地址已按 `Tungpeng/dsh-offpeak-inbox` 填好） | 同上，且发布不可撤销 |
| U5 | **投稿市场**：仓库创建满 **1 天**后，向市场主仓库提 PR 新增 `data/plugins/Tungpeng__dsh-offpeak-inbox.yml` | PR 用你的账号提交 |
| U6 | **（可选）彻底删除旧对象**：改历史前的提交仍可按 SHA 直接取到，见「5. 已知风险」 | 需要 `delete_repo` 权限，见「5」 |

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

# 2) 发布 npm（先补 U1）
npm publish

# 3) 产出 Release 资产 —— ✅ 已完成（v0.1.0，资产名 dsh-offpeak-inbox.tgz）
npm pack
# 把生成的 dsh-offpeak-inbox-<版本>.tgz 重命名为 dsh-offpeak-inbox.tgz 后上传到 Release

# 4) 验证市场里的 tarball 链接确实可下载 —— ✅ 已完成（HTTP 200），再提投稿 PR
```

## 5. 已知风险与边界

- **改历史前的提交仍可按 SHA 取到**：重做历史用的是强制推送，GitHub 不会立即回收不可达对象。实测旧提交（`3f175bd…`）的 `raw.githubusercontent.com` 路径此刻仍返回 200，即那份带真实素材的夹具**仍可被知道 SHA 的人取到**——但它已不在任何分支、不参与浏览与搜索、也不会被 clone 下来。彻底清除需要删除并重建仓库，而本机存有的 GitHub 凭据只有 `gist, repo, workflow` 三个 scope，**没有 `delete_repo`**（实测 `DELETE /repos/...` 返回 403）。要清除请你在网页端 Settings → Delete this repository 删掉后告诉我重建，或给一个有 `delete_repo` 的 token。
- **npm 的 `private` 字段**：本机实测 `npm publish --dry-run` **不会**拦它（退出码 0），所以别指望 dry-run 提前发现；真实发布时才会以 `EPRIVATE` 拒绝。证据等级：报错文案与社区问答一致，但未在本机复现（缺账号）。
- **`latest/download/` 的时效陷阱**：该形式只在请求时解析 `latest`，文件名照字面取；资产名带版本号会在你下次发版后静默 404。
- **市场会移除条目**：仓库消失、长期停更、或"存在明显缺陷"的条目会被移除，收录不是永久的。
- **公开前自查**：本目录的文档若含任何用户名或盘符，必须先替换为占位符或移出公开范围（本文件已做前者）。注意**正则扫描挡不住中文业务词**——本轮泄漏的站点名与片源编号不含任何路径或密钥特征，是人工读夹具才发现的。
- **`Asia/Jakarta` 仍是测试里的示例时区**（3 个测试文件共 12 处）。它单独不构成识别信息（UTC+7、无夏令时，是常见的测试时区选择），且改动会连带改掉断言里的时间字符串；如需一并中性化，属于独立一步。
- **面板刷新与构建的旧坑**都记在 `README.md` / `README.zh.md` 的"部署注意"里，避免后人重踩。
- **`link:` 挂载必须先构建，否则整个 `dsh web` 起不来**（2026-09-16 真实事故，约半小时崩溃循环）：`link:` 直指源码目录，而 `lib/` 不入库；`lib/client.js` 一旦缺失，宿主在加载插件阶段直接退出，守护按 5/10/20/40/80/120 秒退避重启，外观上就是"卡死"。已在本机 `restart-dsh-web.ps1` 前置 `ensure-plugin-builds.ps1` 自动补齐（实测：删掉 `lib/client.js` 后守卫会重新构建并报就绪）。对使用者的可见影响已写进两份 README。
- **Windows PowerShell 5.1 的 `.ps1` 编码陷阱**：无 BOM 的 UTF-8 中文会被按 ANSI 读而破坏字符串、导致脚本整体解析失败（本次实测踩到，且编辑工具重写文件会静默丢掉 BOM）。写给 5.1 的脚本要么带 UTF-8 BOM，要么只用 ASCII；读 JSON 时也要显式 `-Encoding UTF8`，否则中文描述会让 `ConvertFrom-Json` 失败并**静默跳过**后续检查。
- **插件装上即拥有创建并驱动真实会话的能力**：HTTP 路由只靠 loopback + same-origin 把关，同机其它本地进程也能 POST `/api/offpeak-inbox/action`；`R3` 的安全说明就是为了把这条讲清楚。
