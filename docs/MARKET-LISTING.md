# 进 DSH 插件市场：收录规则与投稿包

> 依据：市场主仓库 `awesome-dsh-plugin/awesome-dsh-plugin`（约 15.9k 星）的 `README.md` 与 `contributing.md`（2026-09-16 抓取正文核对），以及市场自己的数据文件 `https://awesome-dsh-plugin.com/plugins.json`（3722 条、1877 条带 npm 分数）。
> 结论先说：**收录不需要 npm。** 但市场官方"推荐"两条改善安装体验的路，而这两条恰好能解决我们仓库"源码装不上"的问题。

## 1. 硬性收录条件

| 条件 | 我们的状态 |
|---|---|
| `package.json` 声明 `dsh.bundle` manifest | **已有**（`dsh.bundle.patch` 指向仓库根的 `cordis.patch.yml`）。注意：只声明 `dsh.client` 是市场**最常见的被拒原因**，只带前端 UI 的包不算可安装 |
| 仓库有真实可用代码 | 已有（约 2100 行源码 + 83 项测试） |
| 仓库**创建满 1 天** | 待办：建库后**次日**才能投稿（CI 自动校验；这是为了挡掉"投稿前几分钟才建的仓库"） |
| 仓库带 `dsh-plugin` topic | 待办 |
| 描述属实、无营销词 | 投稿的描述会被维护者逐句对着代码核；夸大是"本来不错的插件被打回"的主因 |
| 项目处于活跃维护 | 需长期保持；仓库消失、归档或长期停更会被定期扫描并移除 |
| 分类贴合实际功能 | 见下一节 |

## 2. 分类选择

可选值：`agi` `ui` `usage` `theme` `model` `identity` `session` `memory` `tools` `wsl` `browser` `vision` `voice` `docs` `skill` `workflow` `git` `notify` `dev` `security` `remote` `market` `fun`。

**本插件应选 `workflow`（Workflow & Automation）。** 次选 `session` 或 `tools`。官方明确说：分类选得不够准由维护者直接改，**不会因此被打回**，所以不必纠结。

## 3. 投稿形态：一个文件就是全部

投稿 = 向市场主仓库提一个 PR，**只新增一个文件**：`data/plugins/<owner>__<repo>.yml`。

不要手改 README——两份 README（中/英）由 `data/plugins/*.yml` 生成，合并后自动重建。这也正是"一插件一文件"的原因：以前所有人往同一位置追加，合并一个就撞掉下一个。

### 我们准备提交的内容

文件名：`data/plugins/Tungpeng__dsh-offpeak-inbox.yml`

```yaml
url: https://github.com/Tungpeng/dsh-offpeak-inbox
name: Tungpeng/dsh-offpeak-inbox
category: workflow
description:
  en: 'Off-peak inbox for DeepSeek Harness: capture thoughts and todos whenever they occur, and the host launches each one as a real session only while the DeepSeek API bills at its off-peak rate.'
  zh: DSH 错峰收件箱：随时记下想法与待办，只在 DeepSeek API 平价时段由 Host 自动新建会话执行。
tarball: https://github.com/Tungpeng/dsh-offpeak-inbox/releases/latest/download/dsh-offpeak-inbox.tgz
```

两处细节要照做，否则会被 CI 或维护者打回：

- **`en` 里有 `: `（冒号加空格）必须加引号**，否则 YAML 会把它读成嵌套键而解析失败；中文全角冒号无此问题。
- `zh` 是**可选**的：官方明确说写不了就留空，维护者会补，"缺翻译是我们的活，不该成为打回的理由"。
- **不要手写 `npm:` 键**——会被校验直接拒绝，npm 与仓库的关联由 registry 自动采集。

## 4. 安装形态：市场推荐的两条路（关键）

市场官方对"更好的安装体验"给了两条建议，并且说明了原因：

| 路线 | 效果 | 市场怎么说 |
|---|---|---|
| **发布到 npm** | 用户装到的是预构建代码，**跳过 `allowBuilds` 构建授权** | "推荐：预构建安装免构建授权" |
| **不发 npm**：把预构建 tarball 挂到 GitHub Release，用 `tarball:` 字段指向它 | 市场会**优先展示这个链接**，而不是"从源码构建"的命令 | "**如果你的仓库根本无法从源码安装，这一项是必需的**" |

现状判断：`tarball:` 这一项对我们不是"可选优化"，而是**必需项**——它保证用户装到的是预构建产物，不必授权任何包在安装期执行代码。仓库现已自包含（构建用本仓库自己的依赖、`prepare` 也自包含），但源码直装仍然要求用户在自己的 profile 里授权 `allowBuilds`，所以 tarball / npm 才是推荐入口。

### tarball 链接的时效陷阱（官方专门警告）

`latest/download/` 只在请求时解析 `latest`，**文件名是照字面取的**：

- 资产名里带版本号（`dsh-offpeak-inbox-0.2.0.tgz`）→ 投稿当天有效，**下一次发版立刻 404**，而且没人会发现；
- 正确做法二选一：
  - 资产名**不带版本**：`https://github.com/<owner>/<repo>/releases/latest/download/dsh-offpeak-inbox.tgz`（本文档采用这条）；
  - 或**钉住 tag**：`.../releases/download/v0.2.0/dsh-offpeak-inbox-0.2.0.tgz`（这里带版本号反而是正常写法）。

另：必须是 **GitHub 自家托管的 https `.tgz`**，第三方图床/网盘链接不被接受。

## 5. npm 这条路的现状（已拍板：发）

| 项 | 状态 |
|---|---|
| 去掉 `private: true` | ✅ 已去掉。⚠️ 证据等级：本机 `npm publish --dry-run` 实测**不拦** private 包（exit 0），所以别指望 dry-run 提前发现；真实发布时才以 `EPRIVATE` 拒绝——这条来自 npm 报错文案与社区问答，未在本机复现（缺账号） |
| 补 `repository` 字段 | ✅ 已补，指向 `github.com/Tungpeng/dsh-offpeak-inbox`。市场明文要求包内 `repository` 指回被收录的那个仓库，否则两者不会关联 |
| 补 `keywords` / `author` | ✅ 已补（npm 页面可检索性） |
| 构建时机 | ✅ `prepublishOnly` = 构建 → 类型检查 → 测试；`prepare` 供 GitHub 源码直装 |
| 产物内容 | ✅ 实测 16 个文件 / 约 51 kB；不含 `src/client.js` 与源码地图 |
| 版本不可覆盖 | ⚠️ 纪律：同一版本号不能重发；撤回受官方政策约束（**72 小时内**、且需满足无其他包依赖等条件——[npm Unpublish Policy](https://docs.npmjs.com/policies/unpublish/)） |
| 官方包声明方式 | ⚠️ 规则：若将来声明 `@deepseek-ai/*`，必须用 `peerDependencies` **且范围要带显式预发布分支**（`>=0.0.1-rc.1 <0.1.0 \|\| >=0.1.0-rc.1 <0.2.0-0`），否则会静默排除 harness 的所有预发布构建、用户会遇到 `ERESOLVE`。当前 `@deepseek-ai/cordis` 只是 devDependency（给运行时测试用），发布产物里没有任何运行时依赖 |

### npm 带来的额外收益（与本机既有标准相关）

市场的下载量数字**只对 npm 包显示**。没有 npm 包，条目照常工作，但**没有下载量数字、也不能按下载量排序**——而下载量正是我们判断插件真实采用度的主要指标之一（星数会被父仓库共用、被依赖数才能反映真实使用）。若希望这个插件将来能被"按采用度"评估，npm 是唯一的度量入口。

## 6. 截图（可选，推荐）

市场详情页支持 App Store 式截图。声明方式：**在我们自己仓库的 `package.json` 旁边放 `screenshots.json`**，列 1–8 张图片路径（相对该文件，不能跳出插件目录、不能以 `/` 开头）：

```jsonc
["assets/screenshot-1.png", "assets/screenshot-2.png"]
```

- 放在自己仓库的好处：换图只需推自己的仓库，次日构建自动生效，不必来提 PR；
- 不声明也有兜底：市场会从 README 自动抽取图片（已发布的 773 张里有 41 张就是这样烂成 404 的，所以能自己声明就自己声明）；
- 待办：面板截图还没做。

## 7. 投稿检查清单

- [ ] GitHub 仓库已建、公开、带 `dsh-plugin` topic
- [ ] 仓库创建已满 **1 天**
- [ ] `package.json` 的 `dsh.bundle` 仍在（市场 CI 会实时抓取核对）
- [ ] Release 已挂**不带版本号的** tgz 资产，`tarball:` 链接实测可下载
- [ ] 描述与代码逐条对齐（"只在平价时段执行"这类断言必须站得住）
- [ ] 未手写 `npm:` 键；未改动其他条目
- [ ] （可选）`screenshots.json` 已放好
- [ ] PR 只新增 1 个 YAML 文件

## 8. 相关事实与证据来源

- 收录规则与安装建议：市场主仓库 `contributing.md`（正文已抓取核对）
- 市场数据与 npm 联动：`https://awesome-dsh-plugin.com/plugins.json`（顶层 `source` 指向市场主仓库；本轮实测 1877/3722 条带 npm 分数、242 条带 `tarball` 字段）
- 市场里已有"纯 GitHub + Release tarball"的先例：`dsh-product-preview`（`npm: null`，安装命令直接指向 Release 的 tgz）
- 从 GitHub 源码安装的构建授权机制：DeepSeek Harness 仓库 `docs/user/develop/basic/publish.zh.md`
