# dsh-offpeak-inbox — DSH 错峰收件箱

[English](README.md) | **中文**

平时把想法、待办或"待会儿要聊的事"记进收件箱；只在 **DeepSeek API 平价（错峰）时段**自动把它们推送给 DSH，各开一个新会话执行。

目的很直接：**贵的时候不烧钱，便宜的时候再干活。**

## 它做什么

- 侧边栏多一个「错峰收件箱」入口，点开就能记一条（标题可选 + 正文）。
- 每条记录都会算好"最早可执行时刻"：
  - 在**平价窗口内**记下的 → 立刻进入当前窗口，很快执行；
  - 在**高峰时段**或两段高峰之间记下的 → 等下一个平价窗口开始。
- 到点后 Host 自动新建一个 DSH 会话，把条目原文下发执行；结果留在那个会话里，随时点开看。
- 状态一眼可见：`等待错峰 / 执行中 / 已完成 / 失败`，并支持**立即执行**、**删除**、失败后**重试**。

## 攒多了怎么翻：折叠的历史 + 搜索

收件箱用久了，面板里的旧条目会越堆越长。列表因此分成两段：

- **还在动的**（等待错峰 / 执行中 / 失败）一直留在列表里。失败的那条尤其不能藏——它还在等你重试或者删掉。
- **已经落地的**（已完成 / 已取消）收进一条「历史记录（N 条）」横条，**默认折起来**；点一下展开，一次画最近 20 条，再往下按「再看更早的 N 条」。折叠状态记在浏览器里（`localStorage` 的 `dsh.offpeak.historyOpen`），下次打开还是上次那样。

折叠只是**显示上**的收起来，一条都没删：数据仍旧完整躺在 `$DSH_HOME/offpeak-inbox/inbox.json` 里。要翻旧账就用历史横条上面的**搜索框**：

- 搜索范围是**整条记录**，不只是屏幕上那几行：标题、正文、报错文本、会话 id、状态、捕获日期、以及等待中的条目才会印出来的「计划 … 起可执行」那个时间点都能命中；
- **被折叠起来的历史一样搜得到**——搜到就列出来，不受折叠状态影响；命中很多时同样一页 20 条，按「再看更多匹配」往下翻；
- 搜索框清空即回到「常驻条目 + 折叠历史」的视图。

## 已有会话也能错峰

不想另开新会话，而是"这句话我现在写好，等便宜了再发给我正在聊的这个会话"，用输入框旁边的「错峰」按钮：

- 在**高峰时段**点它 → 内容攒起来，等下一个平价窗口开始后自动发进**当前这个会话**；高峰时段不会提前发。
- 在**平价窗口内**点它 → 钱已经便宜了，直接发（面板/提示会说明这一点）。
- 内容取自输入框里已经写好的字；**点了才会攒**，不会自动拦截你正常发送的消息。
- 发出去之后，条目在收件箱里显示「已发到已有会话 <会话 id>」并结算为**已完成**——投递的凭据是宿主的接受回执，不是"那个会话还在不在跑"（它之后还会跑你自己的轮次）。
- 条目上的**「立即执行」对定向条目同样有效**：它会立刻投递到你指定的那个会话，不会新建会话（不然就与这一行写的目的地自相矛盾了）。
- 面板的记录区还能用「发到」下拉直接选**任意已有会话**（子代理会话不在列表里），适合给别的会话攒一条。存进面板的定向条目，在收件箱里点「立即执行」也是走同一个目的会话。

按钮只认得**浏览器自己记住的当前会话**（`localStorage` 里的 `dsh.sessions.current`）。要是刚打开页面还没有会话，或那个值读不到，它会明确说"没认出当前会话"，而不是猜一个错的发出去。

## 平价时段怎么算

按 DeepSeek 官方定价页的口径（高峰 = 平价价的 2 倍）：

| | 时段（UTC） |
|---|---|
| 高峰（贵） | 周一至周五 01:00–04:00、06:00–10:00 |
| 平价（半价） | 其余全部时间，周末全天 |

面板顶部会直接显示"现在是高峰还是平价"、当前窗口的起止，以及下一个平价窗口何时开始，不用自己换算时区。

## 重要边界

- **Host 必须在运行。** 插件活在 `dsh web` 进程里，进程停了就不跑了。
- **错过的窗口不补跑。** 但每条记录的"最早可执行时刻"在**记录当下就已经算好**，所以你半夜记的东西不会因为当时没开窗口就丢失——等下一个窗口就是了。
- **不唤醒睡眠的机器。** 电脑睡着了，到点也不会自己醒过来干活。
- **执行要花 API 额度**，跟普通会话一样。省的是差价（平价约为高峰的五折），不是免费。

## 安装

下面几条都会往 profile 里写一行，而 profile 只在启动时读取一次——装完请重启 `dsh web`。

**装预构建的 tarball。** 安装期不执行本包的任何代码，所以不需要构建、也不需要授权构建脚本：

```sh
dsh plugin --profile web add https://github.com/Tungpeng/dsh-offpeak-inbox/releases/latest/download/dsh-offpeak-inbox.tgz
```

**直接从本仓库装。** 这条路拉的是源码，pnpm 会执行本包的 `prepare` 构建；而 pnpm 10 在得到显式允许前拒绝运行 git 依赖的构建脚本。第一次 `dsh plugin add` 会失败，并打印要填进该 profile `pnpm-workspace.yaml` 的确切键名——填在 `allowBuilds` 下面，键是包名、值是 `true`。补上后重跑一次即可。请把这项授权理解为「允许本包的代码在安装时于你的机器上执行」；想锁住实际运行的内容，就钉住 commit（`github:Tungpeng/dsh-offpeak-inbox#<sha>`）。

```sh
dsh plugin --profile web add github:Tungpeng/dsh-offpeak-inbox
```

**从 npm 装**（包尚未发布，现在请先用上面两条）：

```sh
dsh plugin --profile web add dsh-offpeak-inbox
```

开发时也可以用本地目录直接挂载，改完重建即生效：

```sh
dsh plugin --profile web add link:<本仓库目录>
```

**挂载之前先构建。** `link:` 直接指向源码目录，而 `lib/` 是构建产物、故意不入库。如果宿主启动时 `lib/client.js` 不存在，`dsh web` 会在**加载插件阶段**直接退出；守护脚本随后按退避反复重启，所以外面看起来像"卡死"而不是一条明确的报错。挂载前先跑一次 `npm install`（会经 `prepare` 自动构建）或 `npm run build` 即可避免。

## 配置

`cordis.patch.yml` 里的配置项：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关。关掉后只收不跑。 |
| `timeZone` | `UTC` | 高峰时段按哪个时区解释；默认 UTC 即官方口径。 |
| `ranges` | 01:00–04:00、06:00–10:00 | 工作日高峰区间，可改成自己的口径。 |
| `announceToAgent` | `true` | 是否向 agent 声明本插件的存在与用法。 |
| `launchIntervalSeconds` | `10` | 两次启动尝试之间的间隔，下限 2 秒。每轮最多启动一条会话，所以这个值决定的是**积压排空的速度**（越小 = 同时在跑的越多），而不是每轮跑几条。旧名 `tickSeconds` 仍被接受。 |
| `executionTimeoutSeconds` | `14400` | 单次执行超时上限，超过则标记失败并提示查看会话。 |

## 数据位置

`$DSH_HOME/offpeak-inbox/inbox.json`（`$DSH_HOME` 未设置时取 `~/.dsh`）。

条目字段：`title` / `prompt` / `createdAt` / `runAfter` / `status`。另有三种互斥的归属信息：`targetSessionId`（用户指定的已有会话，投递被接受后写入 `deliveredAt`）、`sessionId` + `startedAt`（插件新建的会话，正在执行）、以及 `settledAt` / `error`（终态与原因）。

写入是原子的（临时文件 + rename）。文件若无法解析，会被改名到 `inbox.json.corrupt-<时间戳>` 保留现场，调度器以空账本启动并在控制台报错——绝不静默丢数据。

## 开发者速览

```
src/calendar.ts   错峰日历：isPeak / currentWindow / nextWindowStartMs（纯函数，含测试）
src/ledger.ts     持久化与条目状态机
src/runner.ts     启动真实 DSH 会话（gateway create/rename/prompt）+ 投递到已有会话
src/service.ts    调度循环、启动决策、执行结果回收
src/routes.ts     同源 HTTP 接口（state / sessions / action / events）
src/index.ts      Cordis 插件入口（装配 + 设置 + 系统提示声明）
src/client.ts     浏览器半区源码（vanilla TS，Shadow DOM 面板 + 输入框旁的「错峰」按钮，零依赖）
lib/index.mjs     构建产物：Host 半区
lib/client.js     构建产物：浏览器半区，必须是 __ModuleLoader__.load 包装体
```

设计上的几个要点：

- **Host 半区运行时依赖为零。** 所有 harness 服务都通过 Cordis 注入，会话 RPC 走注入的 gateway；配置校验直接用 Standard Schema 手写实现，因此不需要 schemastery 之类的 schema 库。
- **投递统一走 `session/prompt`，不直接往运行中的 agent 里塞消息。** harness 收件箱里的一条消息是完整的 `UserMessage`（身份、角色、`content`、`source`）；自行拼装而缺 `source` 会让下一轮直接以 `Cannot read properties of undefined (reading 'kind')` 失败。交给 gateway 组装可让插件不碰内部消息字段，运行中的 agent 句柄只用于读取执行状态。发往已有会话的条目走的是同一个方法，只是目的会话在捕获时就写在 `targetSessionId` 上。
- **定向条目不占用 `sessionId` 字段。** `sessionId` 的语义是"插件建出来的那个会话，用来盯它跑完没有"；用户指定的目的会话写在 `targetSessionId` 上，投递被接受即结算，避免把用户之后的轮次误当成这次执行。
- **当前会话来自浏览器自己的持久化值。** 按钮读 `localStorage` 的 `dsh.sessions.current`（宿主 `sessions` 服务把选中项持久化在这），不解析 URL、不猜标题；读不到就明确报错。
- **宿主上报的执行错误会把条目标成失败。** 回收逻辑只能看到会话是否还在运行，因此中途失败的轮次会被误判为已完成；`api-session/error` 提供失败原因。
- **可选服务一律走 `ctx.get`。** Cordis 的属性代理对**未在 `inject` 里声明**的服务名是**抛异常**而不是返回 `undefined`（一个可选时钟服务曾因此让整个插件无法启动）。插件只硬声明必需的四个服务，其余通过 `ctx.get` 读取。
- **测试用的时钟注入：** 若宿主提供了一个名为 `now` 的服务（返回毫秒时间戳的函数），调度器就用它取时；没有则用 `Date.now`。这是给测试做确定性时间用的，生产环境无需提供。
- **验收口径在 calendar.ts。** 边界判定对"未对齐 15 分钟网格的时刻"做过修正（03:10 曾会算成 01:10），相关回归测试保留在 `test/calendar.test.ts`。
- **`test/runtime.test.ts` 针对构建产物**（`lib/index.mjs`）跑真实 Cordis 运行时；`test/client.test.ts` 把 `lib/client.js` 当作浏览器模块加载器会加载的那种经典脚本求值，再调用它导出的纯判定函数——所以「构建把 `internals` 丢了」「包装器不再导出」这类问题会先在测试里炸，而不是在浏览器里。`npm test` 前会自动先构建（`pretest`）。

```sh
npm install          # 安装开发依赖
npm run build        # 构建 Host 半区 + 产出 lib/client.js
npm run typecheck    # Host 与浏览器半区两套类型检查
npm test             # 自动构建后跑：单元测试 + 针对构建产物的运行时测试
```

## 部署注意（踩过的坑）

- **改完浏览器半区，怎么让它生效。** 客户端模块注册表在启动时会把产物字节读进内存，所以「只刷新页面」本身换不掉旧代码。标准 web 组合里另有一行常驻的 `@deepseek-ai/dsh-client-hmr`（`packages/bundle/web-app/cordis.patch.yml` 注明 always mounted）：它按 `pollIntervalMs`（默认 500ms）比对每个客户端产物，内容变了就重新组合该 row，并通过 `/plugins/events` 的 SSE 让浏览器重载对应插件。因此重建 `lib/client.js` 后**一般不需要重启 Host**；面板没变化时先刷新页面，仍然没变化再重启 `dsh web`。
- **重建后哪一半需要重启。** `lib/client.js` 由 `dsh-client-hmr` 行在数百毫秒内重新组合并推给浏览器（见上一条），所以**只改浏览器半区不用重启 Host**；但 `lib/index.mjs`（Host 半区：路由、调度、账本）是进程启动时装配进 Cordis 的，改完必须重启 `dsh web` 才生效，`npm run build` 只负责把新字节写到磁盘。
- **面板骨架带版本号，挂载带世代号——因为热重载会真的发生。** 面板是「关闭即隐藏」而不是卸载，热重载后页面上会留着**旧半区构建的那棵树**：`PANEL_VERSION` 不匹配就把它整体丢弃重建，否则新代码会去读旧树里不存在的部件（搜索框、计数位）而抛错。侧边栏入口与「错峰」按钮同理，靠 `window.__dshOffpeakEpoch` 仲裁：旧半区的 MutationObserver 发现世代不是自己的就停手，不再把自己那套节点重新插回页面。改这两处时别把它们当装饰。
- **`lib/client.js` 必须是 `__ModuleLoader__.load` 包裹的产物，不能是 `src/client.js` 的原样拷贝。** `package.json` 的 `./client` 指向它，而 `tsdown` 只产出 Host 半区；`scripts/publish-client.mjs` 负责包装、并用 `vm.Script` 校验（解析不过或缺少守卫标记就直接报错）。客户端注册表把各插件的动态半区并进一个合并包、由 `<script>` 当经典脚本加载——里面只要有顶层 `export`，整包 SyntaxError，浏览器报的是 `Failed to load plugins … via __ModuleLoader__.load`，看上去像"所有插件都坏了"。
- **构建脚本不要用管道捕获子进程输出。** 受限沙箱会拒绝打开管道（EPERM），失败会伪装成"tsc 没有产出"；改用继承的文件描述符（`stdio: 'inherit'`）。
- **`tsdown` 不传 `--out-dir` 会输出到 `dist/`**，而包入口指向 `lib/`——构建脚本必须显式指定输出目录。
- **浏览器半区只能用真实 DOM 元素。** React 的内部结构（例如 `props.children` 里的组件函数）会混进 `children` 集合；不做 `instanceof HTMLElement` 断言，注入逻辑会抛 `button.closest is not a function` 并让入口消失。
- **面板刷新必须是增量更新，不能重建子树。** 早期实现每次轮询清空影子树重建，输入框会被换成新节点，**正在输入的文字和光标一起丢**；现在骨架只建一次，刷新只更新可变部分，"关闭"只隐藏不销毁。执行级测试断言 textarea 跨刷新是同一个对象且文字不丢。
- **诊断开关：** 打开面板前，客户端会 POST 一次 `clientLoaded`。`state.view.clientLoads` 为 0 就说明浏览器半区根本没执行——这是一眼区分"脚本没跑"和"插不进 DOM"的最快办法。
- **输入框旁的按钮要插进 `trailing` 组，不能挂在 composer 卡片上。** composer 卡片是 flex 纵向布局，直接挂上去会变成控件行下面**另起一行**；正确锚点是发送按钮本身（`sendButtonOf`），`insertBefore(button, send)`。另外判断"已经放好了"要让下一次 DOM 变更时的检查为假，否则每次变更都重插一次，自己触发自己的 MutationObserver。
- **`[class*="trailing"]` 不止一个。** 斜杠菜单的可下钻行也用这个类名，而且它在**输入覆盖层里、比输入行更靠前**，那一组里没有 `<button>`——按"第一个 trailing 组"取发送键会让按钮在菜单展开时被移除（收起后自愈）。`sendButtonOf` 因此改成"取第一个**含 button** 的 trailing 组"。
- **按钮是否落位要上报给宿主。** 面板有没有按钮都能打开，所以宿主无法区分"浏览器半区没跑"和"跑了但没找到输入框"。`client.ts` 会把落位结果（`placed` / `no-composer` / `no-send-control`）POST 给 `action: buttonState`，`state.view.buttonMounted` / `buttonReason` 一眼可查。
- **`dsh.sessions.current` 是同源唯一的键，多标签页会互相覆盖。** 全 `packages/client` 里没有任何 `storage` 事件监听，所以另一个标签页切换会话后，这个标签页的按钮会读到**别的会话 id**。按钮因此做了两件事：发之前核对这个 id 是否在宿主返回的会话列表里（不在就不发，并说明这个会话不在可选列表里——重新点一次不会变好，因为列表里确实没有它），以及把目的会话标题写进提示文案，让人能一眼看出到底发去了哪。
- **DOM 变更观察会自己触发自己。** 该按钮的观察器与侧边栏入口共用 `queueMicrotask` 合并策略：一轮微任务里只尝试一次，且已经就位时不写 DOM。

## 许可

MIT
