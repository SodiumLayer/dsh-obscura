把 obscura 的可执行文件放在这个文件夹里。

如何使用
--------
1. 下载 obscura 的最新发行版：
   https://github.com/h4ckf0r0day/obscura/releases/latest
   注意：GitHub 源在国内可能难以访问，请自备代理。
2. 解压后把 obscura.exe（若发行版里还有 obscura-worker.exe，请一并放入）复制到本文件夹。
   最终应形如：
     <本插件目录>\bin\obscura.exe
3. 回到 DeepSeek Harness 的设置页 -> Obscura -> 看「版本」一栏是否显示出 obscura 的版本号，
   然后点「重启服务」即可生效。

说明
----
- 插件解析可执行文件的优先级：设置页里填写的「自定义路径」 -> 系统 PATH -> 本文件夹。
- 若系统 PATH 中已有 obscura，本文件夹可以为空，插件会优先使用 PATH 里的那个。
- 本插件不会自动下载任何二进制文件。
- 仓库里不含这两个 .exe（`/bin/*.exe` 已被 .gitignore 忽略）其属于 obscura 上游项目，
  请按上面第 1、2 步自行放置。
- 本插件会写这两处文件，都在本文件夹之外，且只在你操作面板时写：
  - `<DSH_HOME>\dsh-obscura\settings.json`：面板上的开关、启动参数、自定义路径；
  - 当前 profile 的 `cordis.patch.yml`：只在你打开「在 DSH 中配置 obscura MCP 服务」开关时增删其中一行 `mcp-obscura`。
