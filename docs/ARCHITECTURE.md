# dsh-offpeak-inbox 组织架构

> 描述**当前真实结构**（v0.1）与开源版的目标结构。

## 1. 仓库目录

```
dsh-offpeak-inbox/
├─ package.json              # 包名/版本/exports/dsh 声明/脚本/发布元数据
├─ pnpm-lock.yaml            # 依赖锁定（CI 用 --frozen-lockfile 消费它）
├─ cordis.patch.yml          # 装进 profile 的那一行插件 + 默认配置
├─ tsconfig.json             # Host 半区类型检查（Node）
├─ tsconfig.client.json      # 浏览器半区类型检查（DOM）
├─ vitest.config.ts          # 测试配置（node 环境、线程池）
├─ README.md / README.zh.md  # 英文为主，中文对照
├─ LICENSE                   # MIT
├─ CHANGELOG.md              # 版本变更
├─ .gitignore / .gitattributes
├─ .github/workflows/ci.yml  # CI：Linux + Windows
├─ docs/                     # 需求、架构、开源清单、市场投稿
├─ src/                      # 源码（Host 半区 + 浏览器半区源码）
│  ├─ index.ts               # Cordis 插件入口：装配、设置、系统提示声明
│  ├─ service.ts             # 调度循环、启动决策、执行结果回收
│  ├─ calendar.ts            # 错峰窗口算术（纯函数）
│  ├─ ledger.ts              # 持久化 + 条目状态机
│  ├─ runner.ts              # 启动真实会话（gateway create/rename/prompt；agent 只读状态）
│  ├─ routes.ts              # 同源 HTTP 接口（state / action / events）
│  ├─ config.ts              # 配置校验（Standard Schema 手写实现）
│  ├─ dsh-home.ts            # 定位 $DSH_HOME
│  ├─ types.ts               # 宿主服务的最小结构声明
│  └─ client.ts              # 浏览器半区（Shadow DOM 面板，零依赖）
├─ scripts/                  # 浏览器半区产物管道
│  ├─ strip-client-types.mjs # 去掉 TS 类型
│  ├─ wrap-client.mjs        # 包装成 __ModuleLoader__.load({id, factory})
│  └─ publish-client.mjs     # 产出 lib/client.js 并用 vm 校验解析
├─ test/
│  ├─ calendar.test.ts       # 窗口算术与边界回归
│  ├─ service.test.ts        # 调度决策与结算
│  ├─ index.test.ts          # 装配、配置、系统提示
│  └─ runtime.test.ts        # 针对构建产物跑真实 Cordis 运行时
└─ lib/                      # 构建产物（index.mjs / client.js）——不提交，发布前生成
```

## 2. 运行时架构

```
                    ┌──────────────────────────────┐
   浏览器 Web GUI   │  lib/client.js（面板）        │
                    └───────────┬──────────────────┘
                       HTTP / SSE│（同源 + 回环校验）
                    ┌───────────▼──────────────────┐
   dsh web 进程     │  lib/index.mjs (apply)        │
   （Cordis Host）  │   ├─ routes.ts  接口层         │
                    │   ├─ service.ts 调度器 ───────┼──▶ runner.ts ──▶ 新建真实 DSH 会话
                    │   ├─ ledger.ts  持久层 ───────┼──▶ $DSH_HOME/offpeak-inbox/inbox.json
                    │   └─ calendar.ts 纯计算        │
                    └──────────────────────────────┘
```

依赖方向单向：`client → routes → service → {calendar, ledger, runner}`；`runner → 宿主注入的 gateway/agents`。反向不存在，`calendar/ledger/config` 不知道 HTTP 与会话的存在。

## 3. 模块职责

| 模块 | 层 | 职责 | 不负责 |
|---|---|---|---|
| `calendar.ts` | 纯计算 | 判定某时刻是否高峰、求当前平价窗口起止、求下一窗口/下一高峰起点 | 不知道条目、不知道时区以外的事 |
| `config.ts` | 边界 | 校验并默认化配置；实现 Standard Schema 接口 | 不做运行时配置热更（由 `index.ts` 的同步器做） |
| `ledger.ts` | 持久层 | 唯一的状态真相：条目的增删改、状态迁移、原子落盘、损坏隔离、变更通知 | 不做调度决策 |
| `runner.ts` | 副作用层 | 创建会话、改名、经 `session/prompt` 投递提示词（消息由宿主组装）；读会话名册与进程内 agent 状态 | 不持有任何持久状态，不自行拼装收件箱消息 |
| `service.ts` | 编排 | 心跳、启动决策、逐个启动、结算与超时 | 不直接碰文件与 HTTP |
| `routes.ts` | 接口层 | 解析动作、校验可信来源、返回快照、SSE 推送 | 不实现业务 |
| `index.ts` | 装配 | Cordis 注入、生命周期、设置注册与轮询同步、系统提示段落 | 不含业务逻辑 |
| `dsh-home.ts` / `types.ts` | 支撑 | 定位宿主目录；声明所消费服务的最小结构 | — |
| `client.ts → lib/client.js` | 浏览器半区 | 捕获表单、列表（常驻条目 + 折叠历史 + 搜索）、状态、操作按钮、诊断自证 | 不自行推算峰谷（一律用 Host 的快照）；折叠与搜索只是显示决策，绝不改数据 |

## 4. 关键机制

### 4.1 计划时刻即捕获时刻（错峰语义的核心）

条目在**被记下的那一刻**就写死了"最早可执行时刻"：

- 记的时候窗口开着 → 计划时刻 = 当前窗口起点，于是它**加入正在进行的窗口**，很快被执行；
- 记的时候是高峰或两段高峰之间的缝 → 计划时刻 = 下一个平价窗口起点。

由此得到一个反直觉但正确的结论：**进程停过也算不上"错过窗口"**。停摆期间开启的窗口，其条目只是继续保持到期状态，Host 一回来就接着跑；而"错过的窗口不补跑"这条边界，是靠每个条目自己的计划时刻实现，不靠调度器的记忆。

### 4.2 调度一轮做一件事

一次心跳最多启动一条，积压按轮次淌出，避免窗口一开就把整个队列同时灌进 API。当前该上限**写死在调度器里**（不是配置项），见需求 FR-15。

### 4.3 结算：完成、失败与未知

判断"这条跑完了没有"有两条独立信号：

1. 进程内 agent 状态（本地读取，最可靠）；
2. 会话名册 RPC（远端，可能被拒绝）。

优先用第一条；第二条读取失败时**返回"未知"而不是"没在跑"**——名册读失败绝不结算任何执行。这条是"条目不能变成假完成"的最后防线。

第三条是失败信号：宿主把会话的轮次失败以 `api-session/error(sessionId, message)` 抛出，插件据此把对应条目结算为**失败**并保留原因。缺这条通道时，中途死掉的轮次会因为"会话已空闲"被判成已完成，用户看到一个什么都没有的"已完成"。

### 4.4 副作用先于记录的顺序

每次启动都先建会话、拿到会话号，再写账本；投递失败时会话号仍然保留并标记失败，这样"出现过会话但没跑起来"不会变成孤儿会话。

投递一律走 `session/prompt`：收件箱里的一条消息是宿主定义的完整 `UserMessage`（身份、角色、`content`、`source`），由宿主组装；插件自行拼装会漏掉 `source`，下一轮任何读取该字段的插件都会抛 `Cannot read properties of undefined (reading 'kind')`，整轮直接失败。运行中的 agent 句柄只用于读运行状态。

### 4.5 持久化

写入为"临时文件 + 改名"；文件不可解析时改名成 `.corrupt-<时间戳>` 保留现场，调度器以空账本启动并在控制台报错。任何情况下不静默丢数据。

### 4.6 安全（能创建真实会话的接口）

接口要求同时满足：套接字来自回环地址、Host 头指向回环名字、浏览器同源标记（`Origin` 与 `Sec-Fetch-Site`）、方法正确、`application/json`、请求体 64 KB 上限。这是纵深防御，不是单点校验。

### 4.7 诊断自证

浏览器半区挂载成功后会回报一次计数。计数为 0 说明"脚本根本没执行"，计数非 0 但面板不见说明"插不进 DOM"——这是排障时区分两类失败最快的办法，务必保留。

## 5. 注入契约

| 服务 | 必需性 | 用途 |
|---|---|---|
| `typertGateway` | 必需 | 会话 RPC（create / rename / prompt / list） |
| `agents` | 必需 | 取进程内 agent 句柄（**只读运行状态**；投递走 gateway） |
| `webServer` | 必需 | 注册三条路由 |
| `systemPrompt` | 必需 | 注入"本插件存在"的段落 |
| `settings` | 可选 | 面板内改配置；缺失时退回组合配置 |
| `now` | 可选 | 测试注入时钟；生产用系统时钟 |

实现约束：Cordis 的属性代理对**未在 `inject` 里声明**的服务名是抛异常而不是返回 `undefined`，所以可选服务一律用 `ctx.get` 读取。这条踩过坑（曾因一个可选时钟让整个插件起不来）。

## 6. 构建与产物

```
src/index.ts ──tsdown──▶ lib/index.mjs        （Host 半区，ESM，node22）
src/client.ts ─strip──▶ wrap ──▶ lib/client.js （浏览器半区，必须是
                                               __ModuleLoader__.load({id,factory}) 包装）
```

- `package.json` 的 `./client` 指向 `lib/client.js`；客户端注册表把各插件的动态半区并进一个合并包，用经典 `<script>` 加载。
- **`lib/client.js` 里只要出现顶层 `export`，整个合并包 SyntaxError，浏览器会报"所有插件都坏了"。** 因此包装脚本用 `vm.Script` 先做解析校验，不通过就拒绝产出。
- 浏览器半区只在 `dsh web` **启动时读取一次**：改完必须重新包装并重启 Host，刷新页面不生效。

## 7. 测试组织

| 文件 | 覆盖 |
|---|---|
| `calendar.test.ts` | 窗口判定、边界时刻（含"未对齐 15 分钟网格"的回归） |
| `service.test.ts` | 启动决策、削峰、结算、超时 |
| `index.test.ts` | 配置校验、装配、声明段落 |
| `runtime.test.ts` | 针对 `lib/index.mjs` 跑真实 Cordis 运行时 |

约束：本机沙箱不允许 vitest 的 fork 子进程，必须用线程池（`--pool=threads`）；`runtime.test.ts` 打的是构建产物，改 Host 代码后先构建再测。

## 8. 失败模式与降级

| 失败 | 行为 |
|---|---|
| 账本文件损坏 | 改名保留 + 空账本启动 + 控制台报错 |
| 会话创建失败 | 条目标记失败并留错误文本，可重试；不产生孤儿会话 |
| 会话已建但提示词投递失败 | 保留会话号 + 标记失败，保证"会话可见" |
| 会话名册 RPC 失败 | 视为未知，不结算 |
| 会话的轮次失败（`api-session/error`） | 条目结算为失败并保留错误原因，可重试 |
| 执行超时 | 标记失败并提示查看会话 |
| `settings` 服务缺失 | 用组合配置，调度器照常工作 |
| 浏览器半区未加载 | 面板不出现，Host 计数为 0（可诊断），调度不受影响 |

## 9. 扩展点（留给 v0.2 及以后）

- **执行身份**（模型/强度/preset）：`runner.ts` 创建会话的参数目前是空请求，扩成可选字段即可，账本加字段、契约加配置。
- **并发上限**：`service.ts` 的单条启动改为按上限取批。
- **窗口策略**：`calendar.ts` 已能求"下一窗口"，`catchUp` 只是改变计划时刻的取值规则。
- **取消执行**：状态机已有 `cancelled`，只缺路由与面板入口。
- **通知**：完成后发事件给通知类插件或 Webhook，必须可降级为无通知。
- **多工作区**：条目携带工作区标识，创建会话时带上。

## 10. GitHub 组织（目标）

| 项 | 方案 |
|---|---|
| 仓库名 | `dsh-offpeak-inbox`（npm 同名，已核对未被占用） |
| 话题标签 | `dsh-plugin`、`deepseek-harness`、`cordis` |
| 主分支 | `main`，受保护；改动走 feature 分支 + PR |
| CI | GitHub Actions：`typecheck` → `build` → `test`（Linux + Windows 矩阵） |
| 发布 | 打 tag `vX.Y.Z` → GitHub Release（附 `npm pack` 产出的 tarball）+ `npm publish` |
| 用户安装 | 首选 npm 一条命令；Release 里的 tarball 作为免构建授权的备用；源码直装 `github:<账号>/<仓库>#<commit>` 需用户授权 `allowBuilds`，且依赖仓库有自包含的 `prepare` |
| 分发前提 | git 安装拉的是源码、不会自动构建，所以 `prepare` 必须自包含（不能引用开发机上的其他检出）——这是把构建从本机搬进仓库的一部分 |
| 市场收录 | 向市场主仓库提 PR，只新增一个 `data/plugins/<owner>__<repo>.yml`（分类 `workflow`，条目里带 `tarball:` 指向 Release）；仓库需满 1 天、带 `dsh-plugin` topic。规则详见 `docs/MARKET-LISTING.md` |
| 文档 | `README.md` 英文为主（npm 与市场页展示用）+ `README.zh.md` 中文对照，两份的配置表与数据位置必须一致 |

## 11. 与同类插件的分工

| 同类 | 它做 | 与本插件的关系 |
|---|---|---|
| 定时发送类（把输入框的消息延后发） | 浏览器本地定时，关页面即失效 | 互补：它管"这一刻的消息"，本插件管"跨进程的待办队列" |
| 高峰拦截类（高峰期拦住请求） | 干预即时请求 | 互补：它管不该发的时候不发，本插件管该发的时候自动发 |
| 余额/计费展示类 | 展示峰谷状态与花费 | 互补：本插件只做事，不记账 |
| **本插件** | **Host 按时钟自动新建真实会话执行攒下的条目** | 唯一在"错峰自动执行"这条线上提供端到端闭环的形态 |
