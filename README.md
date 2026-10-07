# dsh-obscura-plugin

DeepSeek Harness 的 **Obscura** 设置页插件：集中配置 [obscura](https://github.com/h4ckf0r0day/obscura) 无头浏览器的 MCP 服务。

安装与使用见 **[INSTALL.md](./INSTALL.md)**。

```bash
git clone https://github.com/SodiumLayer/dsh-obscura.git
dsh plugin --profile web add ./dsh-obscura
# 重启 DSH；obscura 本体请自行下载后放进 dsh-obscura/bin/（见 INSTALL.md 第 4 步）
```

> 仓库里**不含** obscura 的二进制：`bin/*.exe` 被 `.gitignore` 忽略（每个约 80 MB，且属于上游项目）。
> `lib/` 与 `client.js` 是构建产物，但**已提交**——所以 clone 下来即可用，不必先跑构建。

---

## 它做什么

| 需求 | 实现 |
|---|---|
| DSH 启动时自动启动 obscura 的 MCP 服务 | 宿主半在启动序列里解析可执行文件并 `spawn obscura mcp --http --port <port>`，轮询 MCP 握手确认真的可用，随 DSH 退出停止（只停自己启动的进程） |
| 报告 obscura 是否可用 + 不可用时的下载入口 | 面板只显示一条 **版本** 信息：真实执行 `obscura --version` 得到的 `obscura 0.2.3`；拿不到版本就显示「不可用」，并给出下载按钮与「GitHub 源可能难以访问，请自备代理」提示。不显示 `where` 结果，也不显示搜索过程 |
| 插件目录内放置可执行文件 + 一键跳转 | 包内 `bin\` 目录 + 面板「打开文件夹」按钮；解析优先级：自定义路径 → 系统 PATH → 插件 `bin\`（含解压出的子目录）。**自定义路径既接受可执行文件，也接受它所在的文件夹** |
| 一键测试 harness 是否已接入 obscura MCP | 「测试接入」分两段：**服务段**直接请求面板上那个 MCP 接入地址做 `initialize` + `tools/list`；**接入段**读 loader 条目与 `mcp__obscura__*` 工具数 —— 分开才能区分「服务没跑」与「服务在跑但没接入」 |
| MCP 配置开关 + 接入地址 | 开关：**开** = 在 profile 的 `cordis.patch.yml` 写入/复用它的一行 `mcp-obscura`；**关** = 移除该行。旁边的**接入地址**文本框留空则随 `--port` 自动生成 `http://localhost:<端口>/mcp`，填写则用你的地址；端口/地址变化时配置行**自动跟随**，手工改歪了会被明确提示不一致 |
| 服务控制 | **启动服务 / 重启服务 / 停止服务** 三个按钮，外加一个**自定义启动参数**文本框：插件只固定子命令 `mcp`，host、port、stealth、proxy 等全部由这个框决定（默认 `--http --host 127.0.0.1 --port 3000`） |
| 其余界面取舍 | 不显示 `where` 结果/候选列表/verdict；不显示端口输入框与 stealth 复选框（改为启动参数）；不显示 MCP 管理器入口 |

---

## 设计要点（为什么这样写）

- **零运行时依赖**：宿主半只用 node 内置模块。面板不依赖任何前端库（只用宿主注入的 `react`）。
- **patch 文件逐行编辑**：`cordis.patch.yml` 是你拥有的文件。本插件只替换/删除/追加 `mcp-obscura` 那一行，文件头注释、其他插件行、以及它无法解释的 `!!js` 表达式**逐字节保留**（有往返不变性单测）。
- **绝不假装成功**：文件存在 ≠ 能运行（要真执行 `--version`）；进程在跑 ≠ 服务健康（要真发 MCP 请求）；写入配置 ≠ 已生效（挂载发生在启动时，面板会说要重启）。
- **不越界**：不结束别人的进程（端口被占就报冲突）、不接管外部实例的生命周期、不联网下载二进制、`open-folder` 只允许打开自己的 `bin`。
- **所有权由子进程句柄决定，不由一个布尔标志决定**：只要本实例持有子进程句柄，那个进程就是「我们的」，停止服务一定杀得掉。曾经额外依赖一个 `owned` 标志，导致重复点「启动服务」时把自己刚拉起的监听误判成外部实例、清掉标志，从此停止服务也杀不掉它 —— 这是已修复的真实缺陷。
- **参数框是唯一控制面**：插件只固定 `mcp` 子命令与「按参数里的 `--port` 连接」这件事，主机/端口/stealth/proxy 全部来自参数框；`--port` 决定健康检查与 harness 接入地址，因此改端口会跟着改，缺 `--http` 会明确报错而不是静默跑 stdio。
- **配置行是设置的投影，不是第二个真源**：`cordis.patch.yml` 里那一行由 `effectiveMcpUrl()` 生成并随设置自动重写。曾经两者各自演化，导致面板测的是新端口、harness 指着旧端口 —— 面板现在还会在两者不一致时明确报警，而不是把旧值当「服务段」显示出来。
- **状态只有一个真源**：MCP 开关反映的是 `cordis.patch.yml` 里那一行是否存在，而不是「是否已挂载」；挂载与否由「测试接入」的接入段报告。两者不混为一谈。
- **一个开关只留一处**：`stealth` 曾是独立设置项，现在被折算进启动参数（旧的 `stealth: true` 会自动迁移），面板上每个能改变行为的项都看得见、改得动。
- **不阻断 DSH**：obscura 的任何失败都收敛为面板上的一个状态与一行原因，而不是启动异常。
- **采用宿主事实**：profile 的 `dir` / `patchPath` 取自主机的 `profileContext`，不靠猜 —— 否则自定义 profile 会改错文件。

---

## 开发

```bash
npm run build     # src/ -> lib/ 与 client.js
npm run check     # 构建 + 语法/清单/client 形态 + 产物与源码逐字一致（防漏同步）
npm test          # 单元测试 + 面板文案契约（167 条）
```

实机验证脚本（需要真实 obscura 与可写的 DSH_HOME）：

```bash
node test/live-obscura.mjs <obscura.exe> [port]   # 起真服务并列出 MCP 工具
node test/isolated-profile.mjs [--binary <obscura.exe>]   # 一次性 profile 端到端验收 + 现状哈希回归
node test/client-smoke-server.mjs 8766            # 然后浏览器打开 /test/client-smoke.html
```

> `npm test` 用 `--test-isolation=none`：沙箱禁止子进程管道，node 测试运行器的默认隔离会触发 `spawn EPERM`。
>
> 浏览器冒烟页从 CDN 取 React（宿主是在运行时注入的，本包不打包含 React）。**离线且无本地 React 副本时它会显式报告
> `SKIPPED`**，不会伪装成通过或失败 —— 因此面板文案的回归由 `test/client-contract.test.mjs` 离线守住，
> 渲染类断言只在 React 可用时执行。

## 目录

```
src/          宿主半源码（9 个模块，每个一个职责）
src/client/   设置页面板源码
lib/          宿主半产物（= src/ 逐字复制，已提交）
client.js     面板产物（= src/client/index.js 逐字复制，已提交）
test/         单元测试 + live-obscura.mjs + isolated-profile.mjs + 浏览器冒烟页
scripts/      build / verify-artifacts / check
bin/          用户自备的 obscura.exe 放这里（二进制不入库，见 bin/README.txt）
.github/      CI（Ubuntu + Windows，Node 22）
```

## 许可

[MIT](./LICENSE)

---

## 非官方声明

本项目是第三方插件，与 **DeepSeek**（DeepSeek Harness 的宿主）及 **[obscura](https://github.com/h4ckf0r0day/obscura)** 上游均无隶属关系，亦未获其背书；相关名称与商标归各自所有者。

本仓库**不包含、也不分发** obscura 的任何二进制或源码：`bin/*.exe` 请自行从上游获取，并自行遵循其许可条款（obscura 上游为 Apache-2.0）。

