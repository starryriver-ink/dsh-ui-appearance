# AGENTS.local.md — 本地 fork 说明

> DSH 会把本文件作为 `AGENTS.md` 的**叠加层**自动加载（宿主候选名：`AGENTS.md` → `AGENTS.local.md`）。
> 上游的 `AGENTS.md` 是项目宪法，**不要修改**；"这是我们的 fork、改了什么、怎么装"全部记在这里。
> 维护约定：每加一处改动，在 §2 补一行、在 §5 补动机与证据。

## 1. 这是什么

`C:\code\dsh-ui-appearance` = 上游 `TQSY114514/dsh-ui-appearance` 的**本地 fork**（MIT）。
在 `local/patches` 分支上叠加 8 个提交，本机 DSH 的 `desktop` profile 以 `file:` 本地依赖安装它，
从而**替换掉原先从 npm 安装的版本**。

**历史（为什么要有这个 fork）**：最初是直接在 npm 包（0.1.12）的构建产物 `lib/client.js` 上做字符串补丁 ——
能用，但脆弱、每次插件升级都要重打、且违反上游"`lib/` 是产物不手改"的宪法。
现在改动进了 `src/`，可维护、可上游化。
产物级补丁的完整记录（每处的动机、证据、重打步骤）在另一个工作区：
`C:\Users\suluo\Documents\DSH\dsh-ui-appearance-local-patches.md`

## 2. 本地改动（`local/patches` 相对基点 `base/upstream-0.1.22`）

| 提交 | 内容 | 一句话理由 |
|---|---|---|
| `161c216` | 媒体体积上限 200MB → 2GB | 200MB 挡掉普通 4K 素材 |
| `86e354d` | 模糊为 0 时写 `filter: none`（原恒为 `blur(0px)`） | 非 none 的 filter 让壁纸层走离屏 filter 通道 |
| `799dd2f` | 新增 `backgroundVideoRate`（0.25×–2×） | 慢放既是审美需求，也是最直接的解码降载杠杆 |
| `7964bd5` | 页面不可见时暂停背景视频 | 不看的时候它仍在解码，纯浪费 |
| `d1dfd45` | 浮层（对话框/菜单/tooltip）不再跟随 `surfaceAlpha` | 一个旋钮同时管窗口与浮层，必然两难 |
| `42e9c8a` | 测试对齐上述行为 | 让套件回到上游基线 |
| `c815a42` | 注册为顶级设置分区（原嵌在「通用」里） | 内容早已超出一行的体量 |
| `c268a76` | 仅在启用模糊时才把壁纸层超出视口（原恒为 `-48px`） | 无边距的模糊才需要余量；否则白付约 11% 合成量与一次缩放 |

## 3. 分支与上游同步

- `main` = 上游**纯镜像**，只在 ff 合并时前进，**永远不要在此提交本地改动**
- `local/patches` = 本地工作分支（所有改动都在这里）
- `base/upstream-0.1.22` = 分叉基点标签（= v0.1.22 release 提交 `756e0ad`）
- remotes：`github`（本 fork）/ `upstream`（上游）
  ⚠️ **两个都用 SSH**：这台机器上到 github 的 HTTPS 会 `Recv failure: Connection was reset`，SSH 正常
- 原则是**一提交一关注点**：rebase 时冲突小、上游若自己修了某点可直接丢弃该提交、且每个提交都可能直接提 PR

同步仪式：

```powershell
git fetch upstream
git switch main          ; git merge --ff-only upstream/main ; git push github main
git switch local/patches ; git rebase upstream/main
pnpm install ; pnpm test
```

## 4. 构建 / 安装 / 验证

```powershell
pnpm install
pnpm run bundle      # tsdown → lib/（lib/ 被 .gitignore 忽略，不入库，必须自己 build）
pnpm test
```

安装到本机 `desktop` profile（**pnpm 对 `file:` 本地目录建的是副本、不是链接，所以每次重建后必须重装**）：

```powershell
cd $env:DSH_HOME\profiles\desktop
pnpm install
```

然后**重启 DSH** 才会加载新产物。

回滚到迁移前：把 profile 的 `package.json` 从同目录的 `package.json.bak-pre-fork-<时间戳>` 恢复，
把依赖改回 `"dsh-ui-appearance": "^0.1.12"`，再 `pnpm install`。

**回归判据（重要）**：上游 HEAD **本身就不干净** —— `pnpm exec tsc --noEmit` 有 **8 个错误**，
`pnpm test` 有 **15 个失败**（WIP 状态）。判断"是否引入回归"必须对照这个基线，
不要把这 8 个错误 / 15 个失败当成自己造成的。

## 5. 已实测的关键事实（避免重复踩坑）

- **GPU 占用必须分引擎、分进程看**：壁纸占用集中在**硬件视频解码引擎**
  （Windows GPU Engine 计数器里是 `engtype_video codec 0`），而 `3d`（界面/合成/游戏）**是另一个独立引擎**。
  实测 4K50 素材：`video codec ≈27–31%`、`3d` 仅 ≈5%。所以它的代价是**功耗/发热**，不是界面变慢。
  ⚠ **看任务管理器的总览曲线会把别的进程算进来** —— 本机曾把另一个播放器的 58.8% 误记到壁纸上。
  要按 **pid + engtype** 拆开看（工作区 `gpu-sample3.ps1`）。
- **壁纸的解码开销只由像素率（分辨率 × 帧率）决定**，与编码格式无关：
  - 素材若是浏览器播放流（如 B 站保存的），它已是为在线播放优化过的编码（实测 0.055 bits/像素），
    **砍码率救不了解码**，编码侧没有余量可挖。
  - "解码便宜"的编码（MPEG-2 / MPEG-4 ASP / MJPEG）浏览器不支持、4K 下也无硬解，且码率要涨 2–30 倍；
    AV1 方向相反（省码率、**解码更重**）。H.264 已落在"浏览器必能放 + 硬解最便宜"的甜点上。
  - "无需解码的原始帧"不可行：4K50 的 NV12 是 622 MB/s（≈4.98 Gbps）、91 秒 ≈ 56.7 GB（218×），
    且没有任何浏览器把裸帧当视频播。
  - 结论：能动的只有 **分辨率 / 帧率 / `playbackRate`** 三个
    （`playbackRate` 的线性降载关系是预期，**在 DSH 上尚未单独实测**）。
- **换素材前先验帧率是否注水**：逐帧哈希（`-f framemd5`）会被编码噪声误判 —— 本机那个素材
  4555 帧哈希全唯一，但像素分析证明不了注水。要测**像素内容**差异：
  工作区 `.tools/analyze-motion.mjs`（取 20 帧逐对比平均像素差）。实测该素材在 5s/30s/60s
  三个时间点每帧都有实质变化 → **50fps 是真的**，降帧率会损失流畅度。
- **origin 隔离**：设置存 localStorage、媒体 blob 存 IndexedDB，两者都按 **origin（含端口）** 隔离。
  官方客户端端口**硬编码 19387**（`dsh-desktop-host/lib/index.js` 里 `args: ["--no-open", "--port", "19387"]`）
  → origin 稳定；换客户端或换端口 = 设置与媒体全丢，而且**搬不过来**，只能重新导入素材。
- **上游硬规则（改动时别撞）**：
  - 媒体上限 200MB 写在 `AGENTS.md`（所以本地提到 2GB 是**有意偏离**；要让上游接受，
    应先改成"可配置、默认 200MB"）
  - 背景层必须 `position: fixed; z-index: -1` 沉底；**绝不**给 `#root` 加 `position`/`z-index`
    （会让第三方插件的固定定位弹窗盖住 DSH 设置对话框）
  - `lib/` 是产物，只改 `src/`；组件样式用 `.module.css`
- **宿主 API 依据不是猜的**：`ctx.locale.bind(ns)`、以及
  `settings.section` + `label: () => t(...)` + `children: { '<slot>': { kind: 'list', scope: 'root' } }`
  这套形状，是从官方插件（`dsh-client-ui-settings-plugins` / `-models` / `-account`）的产物里核对出来的。
- **宿主 API 类型是自 stub 的**：插件的 peer（`@deepseek-ai/dsh-client-*`）不安装，
  类型声明由 `types/peers.d.ts` 自行提供（该文件自己要求"保持与 `src/**` 实际消费的成员同步"）。
  新用到宿主 API 时，在那里补声明。

## 6. 上游化的机会

§2 里带 `feat`/`perf`/`fix` 的行为改动大多有上游价值（体积上限那条需先改成可配置）。
上游很活跃（仓库 HEAD 领先 npm 十个版本），且已有 `.github` / 测试 / `.coderabbit.yaml`，是接受贡献的。
把改动逐个提 PR，是让这个 fork 最终消失的正路。
