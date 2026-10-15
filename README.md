# Gemini Web Bridge · 酒馆前端扩展与本机后端

让 SillyTavern / TauriTavern 通过浏览器、Gemini 网页应用窗口或支持 CDP 的桌面客户端生成回复。

从 **1.2.0** 起，项目同时包含可由扩展管理器识别的前端扩展和实际控制浏览器的本机后端：

| 入口 | 加载位置 | 功能 |
| --- | --- | --- |
| `manifest.json` → `index.js` + `style.css` | 酒馆的前端扩展目录 | 设置面板、连接与模型检测、应用 API 配置 |
| `package.json` → `index.mjs` | SillyTavern 的 `plugins/` | 随酒馆启动和退出的 Node 后端 |
| `server.mjs` | 单独运行，适合 TauriTavern | 提供同一套本机桥接 API |

参考插件“游戏王查卡器 v2”使用第一种结构。此前版本只提供后端入口，无法在前端扩展面板按 manifest 加载；现已补齐完整前端。

## 安装前端扩展

前端包为 `gemini-web-bridge-extension-1.2.0.zip`，完整包为 `gemini-web-bridge-1.2.0.zip`。

1. 解压前端包。确认 `gemini-web-bridge` 文件夹内直接包含 `manifest.json`、`index.js`、`settings.html` 和 `style.css`。
2. TauriTavern 使用其本地扩展安装方式或扩展目录；SillyTavern 放到 `data/<用户>/extensions/gemini-web-bridge/`，或全局目录 `public/scripts/extensions/third-party/gemini-web-bridge/`。
3. 刷新酒馆，在扩展设置中找到 **“Gemini 网页桥接”**。支持 ZIP 安装的宿主也可以导入前端包；SillyTavern 原版安装 ZIP 时手动解压，仓库 URL 安装要求仓库根目录有 manifest。
4. 先按下节启动后端，再点击“检测连接与模型”与“应用到 API 连接”。

前端是单文件经典脚本，也能以模块方式加载；静态面板模板已嵌入产物，文件夹或仓库改名后无需修改资源路径。前端本身不需要 Node.js。

详细步骤见 [INSTALL.md](INSTALL.md)，结构符合 [SillyTavern 前端扩展规范](https://docs.sillytavern.app/for-contributors/writing-extensions/)。

## 启动本机后端

要求：**运行后端的 Node.js 为 22+**。SillyTavern 服务端插件使用酒馆的 Node.js；TauriTavern 使用单独的 Node.js 运行后端。浏览器或 Gemini 桌面客户端与后端在同一台机器上。后端运行时没有第三方 npm 依赖。

TauriTavern：将完整包解压到本机可读写位置，运行 `start-gemini.bat` 登录 Gemini，再运行 `start-bridge-gemini.bat`，保持后端窗口开启。前端可继续连接已有的 1.1.0 后端。

SillyTavern 可采用上述方式，也可将后端作为服务端插件自动启动：

1. 将完整包放入酒馆安装目录的 `plugins/gemini-web-bridge/`，目录内应直接包含 `package.json`、`index.mjs`、`config.json`、`lib/` 和 `backends/`。
2. 修改**酒馆根目录**的 `config.yaml`：

   ```yaml
   enableServerPlugins: true
   ```

3. 双击插件目录中的 **`start-gemini.bat`**。默认自动检测 Edge、Chrome、Brave 或 Chromium；首次需在打开的专用会话中登录 Google，确认 Gemini 可以正常对话，并保持窗口开启。旧的 `start-chrome-debug.bat` 也会转到通用启动器，不再强制 Chrome。
4. 启动或重启酒馆。终端应出现：

   ```text
   [gemini-web-bridge] 监听 http://127.0.0.1:8788
   [gemini-web-bridge] 酒馆里填: 自定义地址 = http://127.0.0.1:8788/v1
   ```

后端随酒馆启动，退出时清理连接和请求；前端通过 manifest 单独加载，两个入口可以同时使用。服务端加载方式依照 [SillyTavern 官方文档](https://docs.sillytavern.app/for-contributors/server-plugins/)。同一个端口只运行一个后端实例。

## 选择浏览器或 Gemini 应用

| 使用方式 | 设置或入口 | 范围 |
| --- | --- | --- |
| 普通浏览器 | `start-gemini.bat`，`clientMode: "browser"` | 自动检测 Edge / Chrome / Brave / Chromium；也可用 `browserPath` 指定支持 CDP 的浏览器 |
| Gemini 独立网页应用窗口 | `start-gemini-app.bat`，`clientMode: "app"` | 使用浏览器的 app 窗口显示 Gemini，不需要浏览器标签栏 |
| 已安装的 Gemini PWA | 用调试方式启动承载它的浏览器，再连接其 CDP 端点 | PWA 必须属于开放调试端点的浏览器会话，不能直接接管未开放调试的普通窗口 |
| Windows Gemini 桌面客户端 | 配好 `appPath` 后用 `start-gemini-desktop.bat` | 支持开放 Gemini 渲染页面 CDP 的 Electron / WebView2 客户端；不保证所有第三方客户端兼容 |
| 已有应用调试接口 | `clientMode: "attach"`，设置 `cdpEndpoint` | HTTP 页面发现端点或具体页面的 WebSocket 地址 |

**桌面应用若是纯原生界面，或禁用了远程调试，不能仅凭应用名称连接。手机原生 App 不在支持范围内。Firefox / Safari 也不使用这里的 CDP 适配器，建议选 Edge 或其他受支持的 Chromium 浏览器。**

默认 `autoLaunch: true`：首次模型请求若发现调试端点未启动，会按配置尝试启动客户端。手动启动入口更适合首次登录。专用会话目录会保存登录，但不会自动复制普通浏览器的登录态。

选择特定浏览器时修改 `config.json` 的 `browser` 为 `edge`、`chrome`、`brave`、`chromium` 或 `custom`。非标准安装位置请填写 `browserPath`。Gemini 应用窗口与浏览器模式使用同一浏览器的专用会话目录；已存在可用调试会话时，启动器优先复用它。需要切换窗口形式时，先关闭该专用会话再重新启动。

桌面客户端配置示例，合并进现有 `config.json`：

```json
{
  "clientMode": "desktop",
  "appPath": "C:\\Apps\\Gemini\\Gemini.exe",
  "desktopEngine": "auto",
  "autoLaunch": true,
  "cdpPort": 9222
}
```

`desktopEngine: "auto"` 会同时提供 Electron 调试启动参数和仅对子进程生效的 WebView2 环境变量；也可指定 `electron` 或 `webview2`。客户端需要完全退出后由启动器重开，已经运行的实例可能忽略新调试设置。插件只连接其中的真实 Gemini 网页/WebView，不会把文件形式的应用外壳导航成网页；新会话使用页面内的新对话按钮。

应用自行管理启动参数时，设置 `clientMode: "attach"` 和 `autoLaunch: false`，填写例如 `cdpEndpoint: "http://127.0.0.1:9333"`，也可以填写 `ws://127.0.0.1:9333/devtools/page/实际ID`。只有 browser/app 模式允许自动新建浏览器页面。若端点包含多个 Gemini 页面，可用 `targetId` 精确选择。

原理依据：[Edge 使用兼容 CDP 的接口](https://learn.microsoft.com/en-us/microsoft-edge/test-and-automation/devtools-protocol)、[Electron 调试启动参数](https://www.electronjs.org/docs/latest/api/command-line-switches)、[WebView2 调试配置](https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/debug-visual-studio-code)。Chrome 调试需要[专用用户数据目录](https://developer.chrome.com/blog/remote-debugging-port)。

## 在酒馆中连接

前端面板可保存本机地址、读取模型，并通过“应用到 API 连接”填写下表内容。设置修改在点击应用时生效，加载扩展本身不会切换当前主 API。“读取酒馆后端”用于发现已安装服务端插件的地址；TauriTavern 使用本机地址直接连接即可。缺少兼容宿主接口时会提示手动设置。

打开“API 连接”，选择“聊天补全 → 自定义 / OpenAI 兼容”：

| 字段 | 填写内容 |
| --- | --- |
| 自定义端点 / Base URL | `http://127.0.0.1:8788/v1` |
| API Key | `sk-local`，本机接口不校验此字段 |
| 模型 | `gemini-web` |
| 流式传输 | 支持 SSE，也可以关闭 |

插件在**酒馆进程内**自动监听本机回环端口 8788。该端口供酒馆服务端请求，远程访问酒馆时也填写此本机地址。它与浏览器或应用的 9222 调试端口不同。

不要将 `/api/plugins/gemini-web-bridge` 填为模型端点：酒馆自身路由受登录和 CSRF 保护，普通模型客户端不会携带这些会话凭据。兼容接口使用插件管理的本机监听器，无需更改酒馆的 CSRF 设置。

**Gemini 正文会等网页生成结束并停稳后，通过 SSE 一次返回。** 网页可能改写已经显示的文字，等待稳定可以避免重复和错误拼接；echo 自测后端仍逐段发送。

## 配置

编辑插件目录的 `config.json` 后重启酒馆。也可设置 `GEMINI_BRIDGE_CONFIG` 环境变量指定独立配置文件，便于更新插件时保留个人配置。

| 键 | 默认值 | 作用 |
| --- | --- | --- |
| `host` | `127.0.0.1` | 只支持本机回环地址，也可用 `::1` |
| `port` | `8788` | 插件的本机兼容 API 端口 |
| `backend` | `gemini-cdp` | 真实 Gemini；改为 `echo` 可先自测连接 |
| `modelId` | `gemini-web` | 暴露给客户端的模型名，不切换网页上的实际模型 |
| `contextMode` | `full` | 将酒馆完整 messages 渲染成单条提示词 |
| `nameForAssistant` | `角色` | 提示词中的助手称呼 |
| `cdpPort` | `9222` | 浏览器或桌面应用的调试端口 |
| `newChatEachRequest` | `true` | 每次打开新会话，避免重复追加历史 |
| `maxWaitMs` | `180000` | 单次请求的等待上限，超时返回错误并尝试停止生成 |
| `settleMs` | `1200` | 生成结束后文字需保持稳定的时长 |
| `debug` | `false` | 打印完整提示词，可能包含角色卡和对话内容 |
| `clientMode` | `browser` | `browser` / `app` / `desktop` / `attach` |
| `browser` | `auto` | 自动检测，或指定受支持的浏览器名称 |
| `browserPath` | 空 | 浏览器可执行文件的完整路径 |
| `appPath` | 空 | 桌面 Gemini 客户端的可执行文件路径 |
| `desktopEngine` | `auto` | `auto` / `electron` / `webview2` |
| `autoLaunch` | `true` | 调试端点不可用时尝试启动客户端；attach 模式不启动 |
| `cdpEndpoint` | 空 | 覆盖 `cdpPort`，填写本机 HTTP 或 WebSocket 调试地址 |
| `targetId` | 空 | 精确选择 Gemini 页面或 WebView 的调试目标 |
| `launchTimeoutMs` | `20000` | 启动客户端、等待调试端点和应用 WebView 的时长 |

可选 `profileDir` 指定浏览器专用会话目录；`browserArgs`、`appArgs` 为额外参数字符串数组。例如网页因网络或代理打不开时，可以按浏览器的代理配置方式设置 `browserArgs: ["--proxy-server=http://127.0.0.1:你的代理端口"]`。插件不会修改系统代理。不要在额外参数中覆盖调试端口、应用模式或用户目录，使用上表配置字段。

推荐 `full` + `newChatEachRequest: true`，酒馆掌握完整上下文，重新生成不会重复追加历史。

如果选择 `lastUser`，请同时设置 `newChatEachRequest: false`：仅发送最后一条用户消息，让网页保留上下文。此模式不会同步酒馆中删除、编辑、切换聊天和重新生成对历史的修改，也不适合多个聊天共享同一个网页会话。

桥接按顺序执行请求。停止生成或客户端断开时会取消任务；尚未执行的任务会被跳过，活动任务完成停止清理后再放行下一项。所有使用者共享这一个本机浏览器或应用会话。

只支持文本输入。temperature、top_p、max_tokens 等参数不能直接控制消费级网页，模型和相关选项请在 Gemini 网页中设置。usage 中的 token 数是估算值。

## 状态与排查

- 在已登录的酒馆网页打开 `/api/plugins/gemini-web-bridge/status`，查看插件是否加载及实际模型端点。
- 打开 `http://127.0.0.1:8788/health`，检查本机监听器；这里的 ok 仅表示接口存活，不代表 Google 登录有效。
- 报“端口已占用”：关闭旧的独立桥接服务，或更改插件 `port`，并同步更新酒馆中的 Base URL。
- 无法打开网页：先运行 `node tools/start-client.mjs --check`；它会显示调试端点、实际页面地址和输入框状态。端点不通说明客户端未启动或没有开放调试；页面出现网络错误则需检查该浏览器的网络/代理。
- 调试端点不可用：运行 `start-gemini.bat`，确认窗口仍开启。普通浏览器或应用窗口未必开放调试端口。
- 报登录失效、输入框找不到、超时：先在当前调试浏览器/应用内手动确认 Gemini 可用，再运行 `node tools/inspect-gemini.mjs` 检查选择器。
- 网页改版时，候选选择器集中在 `backends/gemini-cdp.mjs` 的 `SEL` 中。
- 前端使用 `SillyTavern.getContext()` 和扩展设置宿主，已参考提供的 TauriTavern 扩展结构处理；TauriTavern 后端请使用独立服务入口。前端 DOM 与兼容接口测试不等同于所有酒馆版本的现场验证。

## 开发与自测

```powershell
npm install
npm run build
npm test
```

`npm run build` 从 `web/extension.js`、`settings.html` 和包版本生成 `index.js`，同时同步 manifest 版本。请修改源文件后重建，避免直接改生成产物。

开发测试使用 Express、jsdom 和 jQuery 验证后端路由、前端挂载与宿主事件；这些都是 devDependencies，已构建前端和后端运行时无需安装它们。`tools/package-plugin.ps1` 会先构建，再生成完整包和前端包。

保留可选的独立诊断入口：

```powershell
node server.mjs --backend echo --port 8788
node test/smoke.mjs
node test/page-scripts.mjs
```

真实独立诊断使用 `node server.mjs --backend gemini-cdp`。不要与占用相同端口的酒馆插件同时运行。

## 文件

- `manifest.json`：酒馆前端扩展描述与加载入口。
- `index.js`：已构建的前端单文件脚本。
- `web/extension.js`、`settings.html`、`style.css`：前端源文件、面板模板和主题样式。
- `INSTALL.md`：前端扩展安装与后端配套说明。
- `index.mjs`：酒馆插件的 info / init / exit 生命周期。
- `lib/service.mjs`：配置、兼容 API 监听器与关闭清理。
- `lib/bridge.mjs`：OpenAI 兼容接口、校验、SSE、队列与取消。
- `lib/cdp.mjs`：带连接检查、超时和取消的 CDP 客户端。
- `lib/client.mjs`：多浏览器检测、网页应用/桌面客户端启动与调试目标选择。
- `tools/start-client.mjs`：统一启动入口与 `--check` 诊断。
- `backends/gemini-cdp.mjs`：页面等待、新回答识别与生成控制。
- `server.mjs`：可选独立诊断入口。
