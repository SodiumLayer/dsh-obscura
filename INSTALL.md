# 安装与使用（dsh-obscura-plugin）

这个插件会在 DeepSeek Harness 的设置页新增一个 **Obscura** 选项页，并负责在 DSH 启动时把 obscura 的 MCP 服务拉起来。

---

## 1. 安装

```powershell
dsh plugin --profile web add github:SodiumLayer/dsh-obscura
```
或在 DeepSeek Harness 的侧边栏选择 **插件** 再点击右侧的 **添加插件** 再输入 github:SodiumLayer/dsh-obscura 

## 2. 确认 obscura 可用

启动 DSH 后进入 **设置页 → Obscura**
当 **当前状态** 显示为已由本插件启动即代表服务可用
插件会自动查找的可执行文件顺序为
1. **自定义路径** （最高优先级，便于用户自行指定需要的Obscura）
2. **系统 PATH** （推荐的配置，全局可用）
3. 插件文件夹下的 **`bin\` 目录** （便于统一管理并当用户卸载插件时可执行文件也会一同被删除，适用于强迫症用户）

---

## 3. 如何放置 obscura 可执行文件

1. 在 Obscura 页点击 **「打开文件夹」**，会打开插件的 `bin\` 目录
2. 从下载页解压后，把 `obscura.exe`和`obscura-worker.exe`，一并放入进去
3. 回到面板点击 **「重启服务」**，状态应变为「运行中」，并显示工具数量

> 前文提到了插件的调用顺序为：**自定义路径 → 系统 PATH → 插件 `bin\` 目录**。
所以你也可以下载完Obscura本体后将其可执行文件所在的文件夹的路径复制到本插件的自定义可执行文件路径中，此时插件会优先调用自定义文件路径下的可执行文件，或假如你使用过Obscura并已经配置好系统环境变量此时插件可以直接识别并不需要额外设置
> 
---

## 4. 接入 MCP（让 Agent 真正能用上）

打开 **设置页 → Obscura → MCP 接入** 中的 “在 DSH 中配置 obscura MCP 服务” 开关即可自动配置
你可以点击 “测试接入” 按钮测试你的DeepSeek Harness是否已经完成挂载
通常在初次启动服务或重启服务后可能需要 **重启一次 DSH** 才能完成挂载

---

## 5 自定义启动参数

可自定义启动Obscura时传入的参数如 “--http” “--stealth” “--port”

---

## 6. 卸载

```powershell
dsh plugin --profile web remove dsh-obscura-plugin
```

- 若你曾打开过 MCP 配置开关，先在面板里把它**关掉**（或在 `cordis.patch.yml` 里手工删除 `mcp-obscura` 行）。
- 插件自身的设置与日志留在 `<DSH_HOME>\dsh-obscura\`，可安全删除：
  - `settings.json`（自动启动、启动参数、自定义路径等）
  - `obscura.log`
