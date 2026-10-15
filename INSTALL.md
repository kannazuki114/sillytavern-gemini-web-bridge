# Gemini 网页桥接：前端扩展安装

本目录具有与“游戏王查卡器 v2”同类的前端扩展结构：

```text
gemini-web-bridge/
├── manifest.json
├── index.js
├── settings.html
├── style.css
└── INSTALL.md
```

`manifest.json` 指向 `index.js` 和 `style.css`。`index.js` 是无 import/export 的单文件脚本，设置模板已嵌入其中，适配经典脚本与模块方式加载，不依赖扩展文件夹的固定名称。

## 安装前端

1. 在 TauriTavern 中使用其扩展目录/本地扩展安装方式，安装此目录；在 SillyTavern 中放到 `data/<用户>/extensions/gemini-web-bridge/`，或服务端全局扩展目录 `public/scripts/extensions/third-party/gemini-web-bridge/`。
2. 如果使用支持安装 ZIP 的宿主，导入 `gemini-web-bridge-extension-1.2.0.zip`。SillyTavern 原版通过仓库 URL 安装时，仓库根目录必须有这里的 manifest；本机 ZIP 请手动解压到扩展目录。
3. 刷新酒馆，打开“扩展设置”，应看到“Gemini 网页桥接”。如果扩展列表提供启用开关，请确认已启用。

## 启动桥接后端

**前端扩展负责设置和连接，本身不能运行 Node.js 或接管浏览器。需要配套的完整后端包，已有 1.1.0 后端也可继续使用。**

- TauriTavern：将完整包解压到本机可读写位置，运行 `start-gemini.bat` 登录 Gemini，再运行 `start-bridge-gemini.bat`，保持服务窗口开启。
- SillyTavern：可采用同样的独立服务方式；也可把完整包放入酒馆 `plugins/gemini-web-bridge/`，在酒馆 `config.yaml` 中启用 `enableServerPlugins: true`，让后端随酒馆启动。
- 浏览器、网页应用窗口和独立客户端的选择由完整后端包的 `config.json` 决定。

## 使用面板

1. 桥接地址默认 `http://127.0.0.1:8788/v1`。
2. 点击“检测连接与模型”，确认后端在线并读取模型列表。这个操作不会发送对话，也不验证 Google 登录。
3. 点击“应用到 API 连接”，将主 API 切换为“聊天补全 → 自定义”，填写地址、模型和 SSE 选项。
4. 到 API 页面点击连接，再发送一条消息确认实际生成。后端不需要真实 API Key。

“读取酒馆后端”只用于已加载本项目服务端插件的 SillyTavern；TauriTavern 使用默认地址或自行填写实际端口即可。

如果宿主未提供兼容的 API 设置接口，面板会明确提示手动填写，不会声称配置已经应用。若浏览器提示本机网络访问权限，请按宿主的正常流程处理；若连接失败，确认后端窗口仍在运行。

参考规范：[SillyTavern 前端扩展文档](https://docs.sillytavern.app/for-contributors/writing-extensions/)。
