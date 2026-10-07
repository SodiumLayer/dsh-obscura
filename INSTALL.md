# 安装与使用（dsh-obscura-plugin）

这个插件在 DeepSeek Harness 的设置页新增一个 **Obscura** 选项页，并负责在 DSH 启动时把 obscura 的 MCP 服务拉起来。

> 本说明按「源码 + 构建产物」形态编写：你手上是完整的包目录，安装 = 用一条 `dsh plugin` 命令把它注册进某个 profile。

---

## 1. 前置条件

- DeepSeek Harness 0.2.0-rc 系列（本包在 `0.2.0-rc.2` 上实测）。
- Node.js ≥ 22.19（DSH 自身的要求）。
- **obscura 可执行文件**，二选一：
  - 已经在系统 `PATH` 里（`where obscura` 能命中）；或
  - 稍后按第 4 步放进插件的 `bin\` 目录。
- obscura 下载地址：<https://github.com/h4ckf0r0day/obscura/releases/latest>
  **注意：GitHub 源在国内可能难以访问，请自备代理。**

---

## 2. 安装

把 `<本包目录>` 换成这个插件目录的绝对路径（例如 `C:\plugins\dsh-obscura`）：

```powershell
dsh plugin --profile web add <本包目录>
```

- `--profile web` 是你要装进的 profile；本包与你现有配置无关，装哪个由你决定。
- 这条命令会把它写进该 profile 的 `package.json`（本地 link 形式）与 `dsh.profile.bundles`。
- 安装完成后 **必须重启 DSH**：插件宿主半在启动时才挂载。

重启后打开设置页，左侧应出现一个新的 **Obscura** 页（位置在「浏览器」页下方）。

---

## 3. 确认 obscura 可用

启动 DSH 后进入 **设置页 → Obscura**，看「Obscura 可执行文件」一栏的 **版本** 行：

- 显示形如 `obscura 0.2.3`：插件已真实执行过 `obscura --version`，obscura 存在且可运行。
- 显示 `不可用`：所有位置都没有可用的 obscura。此时面板给出「下载最新发行版」按钮，并提示
  **GitHub 源在国内可能难以访问，请自备代理**。

就这一条信息：不看 `where` 的结果，也不显示搜索过程。

解析顺序（面板自动按此顺序尝试，无需你选择）：

1. **自定义路径**（面板上那一栏）——填**可执行文件本身**或**它所在的文件夹**都可以；
2. **系统 PATH**；
3. 插件的 **`bin\` 目录**（含解压出的子目录，例如 `bin\obscura-x86_64-windows-stealth\`）。

> 只有真实跑通 `--version` 的候选才会被采用；文件存在但无法执行会被跳过，并继续尝试下一个位置。

---

## 4. 放置 obscura 可执行文件

1. 在 Obscura 页点击 **「打开文件夹」**，会打开插件的 `bin\` 目录；
   也可以直接访问面板上显示的路径，形如 `<本包目录>\bin`。
2. 从下载页解压后，把 `obscura.exe`（若发行版里还有 `obscura-worker.exe`，一并放入）复制进去。
3. 回到面板点击 **「重启服务」**，状态应变为「运行中」，并显示工具数量（本机 v0.2.3 为 37 个）。

> 面板解析顺序：**自定义路径 → 系统 PATH → 插件 `bin\` 目录**。
> 「自定义可执行文件路径」既接受 `...\obscura.exe`，也接受 `...\obscura-x86_64-windows-stealth`
> 这样的文件夹（会自动在文件夹内、以及其一层子目录里找 `obscura.exe`）。

---

## 5. 接入 MCP（让 Agent 真正能用上）

1. 打开 **「在 DSH 中配置 obscura MCP 服务」** 开关（在 MCP 接入区顶部）：
   - **开**：在当前 profile 的 `cordis.patch.yml` 中写入（或复用）一行 `mcp-obscura`；
   - **关**：移除该行。
   - 它**只动这一行**，文件头注释、其他插件与 `!!js` 表达式逐字节保留；
   - 已存在但地址不一致时**不会静默改写**，会先弹窗询问你是否覆盖。
2. **「MCP 接入地址」** 文本框决定 harness 被指向哪里：
   - **留空**（默认）= 随启动参数里的 `--port` 自动生成 `http://localhost:<端口>/mcp`；
   - 填写 = 用你给的地址（例如放在反代后面：`http://192.168.1.5:9000/mcp`），清空即恢复自动生成；
   - 改动端口或地址时，**已存在的配置行会自动跟着改**，不会出现「面板测的是新端口、harness 指着旧端口」
     这种不一致；如果配置行被手工改成了别的地址，面板会明确提示不一致。
3. 面板 **「测试接入」** 会分两段给出结论：
   - **服务段**：直接请求上面那个接入地址，回答「服务本身是否健康」；
   - **接入段**：检查 harness 是否已挂上 `mcp__obscura__*` 工具。
4. 通常需要 **重启一次 DSH** 才能完成挂载（挂载发生在启动时）；面板会明确告知是否仍需重启。

---

## 5.1 启动参数

服务控制区的 **「自定义启动参数」** 文本框是 obscura 启动命令的**唯一控制面**。插件只固定子命令 `mcp`，
其后的一切都由这个框决定：

```
默认：  --http --host 127.0.0.1 --port 3000
示例：  --http --host 127.0.0.1 --port 3000 --stealth --proxy http://127.0.0.1:7890 --user-agent "My Agent/1.0"
```

- 按空格分隔；写在引号里的内容（含空格）会作为**一个**参数；
- 可以增删任意一项，包括端口：`--port 4123` 会被插件采纳（面板显示的实际监听端口与 MCP 接入地址都会跟着变）；
- 保存后点 **「重启服务」** 生效（若改动了端口，插件会自行重启一次以免状态与实际不符）；
- **删掉 `--http` 会让 obscura 以 stdio 运行**，而本插件的健康检查与 harness 的接入都是 HTTP 的 ——
  此时点启动会直接给出「启动参数缺少 --http」的提示，而不是假装成功或一直等超时；
- 重复给同一个选项时，**最后一个生效**（与 obscura 自身 CLI 的规则一致）。

> 旧版本中「端口输入框」与「启用 stealth 模式」复选框已移除，两者的能力都并入这个参数框：
> 若 `settings.json` 里还留着 `stealth: true`，插件会自动折算成 `--stealth`；
> 旧文档里缺少 `--http --host --port` 的，插件会在首次读取时把它们补进参数框（只补一次）。

---

## 6. 卸载

```powershell
dsh plugin --profile web remove dsh-obscura-plugin
```

- 若你曾打开过 MCP 配置开关，先在面板里把它**关掉**（或在 `cordis.patch.yml` 里手工删除 `mcp-obscura` 行）。
- 插件自身的设置与日志留在 `<DSH_HOME>\dsh-obscura\`，可安全删除：
  - `settings.json`（自动启动、启动参数、自定义路径等）
  - `obscura.log`（obscura 的 stdout/stderr）

---

## 7. 已知边界

- **面板用浏览器原生 `confirm` / `prompt` / 文件管理器跳转**：Web 版行为正常；桌面端（Electron）对这些原生对话框的实现可能不同，属已知取舍（为了不引入二进制依赖）。
- **只支持 HTTP 模式的 obscura**：本插件的健康检查与 harness 接入都基于 `obscura mcp --http`；若你在参数框里删掉 `--http`，启动会明确失败而不是以 stdio 静默运行。
- **插件只固定 `mcp` 子命令**：其余每个开关（含 host 与 port）都在参数框里，可增删。
- **不自动下载二进制**：本插件不会联网取 obscura。除下面的两份文件外，它不写任何东西：
  `<DSH_HOME>\dsh-obscura\settings.json`（面板设置）与当前 profile 的 `cordis.patch.yml`（只在你打开 MCP 开关时增删那一行）。
- **平台**：在 Windows 上实现并验证；`open-folder` 对 macOS/Linux 有分支实现，但未验证。
- **端口冲突**：端口被非 obscura 进程占用时，面板报「端口冲突」，**不会**结束别人的进程；请换端口。
- **外部实例**：若 `<端口>` 上已有 obscura 在跑，插件会「接管观察」而非重复启动，并且**不会**随 DSH 退出关闭它。
  （判断依据是「这个进程是不是本插件启动的」：本插件已启动的服务再点「启动服务」不会变成外部实例，也仍可被停止。）
- **服务控制只有三个按钮**：启动服务 / 重启服务 / 停止服务；面板其余按钮都会自行刷新状态，没有单独的「重试」。
- **接口只接受本机请求**：面板 API 要求 `Host` 与对端地址都是回环地址（`127.0.0.1` / `[::1]` / `localhost`），
  与 DSH 对自身 API 的限制一致。若 DSH 监听在 `0.0.0.0` 而你从另一台机器访问，插件面板会返回 403 ——
  这是有意的：面板里能填写一个会被执行的程序路径，不能只靠「同源」来判断。
- **配置行必须是「普通的一行」**：插件只改写自己写出的形状（`config:` 下的 `serverName` / `transport` / `url`）。
  若你手工改成 flow 语法（`config: { url: … }`）或 `config: !!js …`，插件不会去猜、也不会写坏它，
  只会在面板上报告「配置行与设置不一致」，请手工改。
- **混合换行符的文件会被统一**：若一个 `cordis.patch.yml` 里既有 CRLF 又有 LF，插件按 CRLF 重写整个文件
  （内容不变，只有行尾被统一）；纯 CRLF 或纯 LF 的文件逐字节保留。

---

## 8. 本包内容

```
package.json           插件清单（dsh.bundle.patch / dsh.client）
cordis.patch.yml       本插件自身的 loader 行
lib/                   宿主半（DSH 实际加载的入口；= src/ 逐字复制，已提交）
client.js              设置页面板（宿主按 dsh.client 提供给浏览器；= src/client/index.js，已提交）
bin/README.txt         放置 obscura.exe 的说明（**仓库不含 .exe**，见 .gitignore）
src/                   源码（与 lib/、client.js 逐字一致）
test/                  单元测试 + 实机验收脚本
scripts/               构建/校验脚本
.github/workflows/     CI（Ubuntu + Windows）
.gitattributes         行尾固定为 LF（`lib/` 与 `src/` 的逐字节一致性依赖它）
LICENSE                MIT
```
