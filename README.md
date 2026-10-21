# DSH Screenshot

**给 DSH（DeepSeek Harness）的输入框加一个 QQ 式截图按钮。**

点一下 → 拖个框 → 图片直接进草稿框。就这么简单。

> **仅适配 DSH。** 这是一个 Cordis bundle，依赖 DSH 的 Web 输入框插槽 API。  
> 它不能装进 Codex、Claude、千问、豆包、Cursor 等客户端——那些客户端没有开放  
> 往输入框注入控件的接口。

---

## 效果

输入框工具栏左侧多一个相机按钮：

```
[+] [相机] 发消息或创建任务…                        [发送]
```

点开是一个菜单：

```
区域截图
  隐藏本窗口      拖框选择范围，本窗口先收起
  原样            拖框选择范围，保留本窗口
整屏截图
  隐藏本窗口      抓取整块桌面，本窗口先收起
  原样            抓取整块桌面，含本窗口
──────────────
存一份                    [ ○ ]
只进输入框，发完就没了
```

- **区域截图**：屏幕冻结，你拖一个矩形，Esc 取消。拖的时候有实时 `宽 × 高` 读数。
- **整屏截图**：抓所有显示器拼成的整个桌面。
- **隐藏本窗口**：截图前把 Harness 窗口挪到屏幕外，截完精确还原。它不会出现在截图里，  
  也不会在冻结的画面上。
- **存一份**：默认关闭。关着的时候图片只进草稿框，临时文件十几秒后自动删除；  
  开启后额外存一份到 `图片\DSH Screenshots\screenshot-日期-时间.png`，并弹提示告诉你路径。

## 安装

需要 **Windows 10/11**、**DSH**、以及一个可交互的桌面会话。

1. 把这个仓库放进一个工作区目录（不要放进 `$DSH_HOME` 或 profile 目录）。
2. 用 Plugin Manager 安装成本地 bundle：
   ```
   plugin_manager → action: install_bundle → target: <这个目录的绝对路径>
   ```
   或者手动在 profile 的 `cordis.patch.yml` 里加一行：
   ```yaml
   - id: screenshot
     name: '@local/dsh-screenshot'
   ```
3. Host 半边会随 `application: applied` 激活；Client 半边（按钮和菜单）需要  
   **刷新页面**才加载。

刷新后输入框左边就有按钮了。

## 验证

不刷新页面也能确认装好了：

```
cordis_inspect_query
  platform: client
  provider: Slots
  method:   listSubTree
  input:    { "root": "conversation.input.left" }
```

应看到 occupant `id: "dsh-screenshot"`、`active: true`。

再看工具列表里应该有 `screenshot` 这个 agent 工具，调用它：

```
screenshot { "hide": true }
```

然后 `read_image` 它返回的路径——Harness 窗口不应该在画面里。

## 给 agent 用的工具

除了按钮，还注册了一个 `screenshot` 工具，让模型自己能截图：

| 参数      | 说明                      |
| ------- | ----------------------- |
| `hide`  | `true` 时先把 Harness 窗口挪走 |
| `title` | 额外要隐藏的窗口标题（区分大小写的子串匹配）  |
| `keep`  | `true` 时存到图片文件夹         |

返回 `{ path, width, height, hidden, ms, saved? }`。

区域截图只能由按钮触发——它需要人拖框，模型没法代劳。

## 不攒垃圾

这套东西的硬要求。

| 路径                                  | 生命周期                             |
| ----------------------------------- | -------------------------------- |
| `<工作区>\.dsh-screenshots\latest.png` | 只是传输通道。客户端读完就删，约 15 秒后文件连同目录一起消失 |
| `%TEMP%\dsh-screenshot\shot.png`    | 只有 agent 工具会写。固定一个名字，下次覆盖        |
| `图片\DSH Screenshots\*.png`          | **只在开启"存一份"时**才有                 |

草稿删除带代际保护：连着快速截图时，前一次的定时删除不会误删后一次的新图。

## 原理

```
点按钮 → /screenshot 命令 → 常驻 PowerShell worker → GDI 抓屏
                                                    → WinForms 选区
         ← 客户端读 PNG ← 合成 paste 事件塞进草稿框
```

`capture.ps1` 是全部引擎，不依赖 DSH。两个关键设计：

**常驻进程。** 启动 PowerShell 要约 1.5 秒，一次点击付不起。助手上电时启动一次，  
预加载 GDI/WinForms，之后每次截图只走一行 stdin / 一行 stdout。  
实测：整屏 60 ms 左右，区域截图点击后约 100 ms 就能开拖。

**靠挪走而不是最小化来隐藏窗口。** 最小化和隐藏都会触发约 250ms 的 Win11 动画，  
抓屏会抓到缩小一半或半透明的残影。把窗口挪到 `(-32000, -32000)` 没有过渡动画，  
一个合成帧后就干净了，截完再按原坐标放回去。最大化的窗口挪不动（窗口管理器把它  
钉在工作区），这种退回最小化。

## 踩过的坑

这些都是实际调试出来的，不是推测：

- **DPI 缩放。** 缩放显示下，DPI 虚拟化的进程报告的虚拟屏幕比它实际抓到的像素小。  
  选区窗口必须按**冻结位图的尺寸**来定，绝不能再查一次屏幕，否则拖框会映射到错误的像素。
- **先冻结再选。** 如果直接在活动桌面上画选区，东西会在框下面动，你看到的和裁下来的不是一回事。
- **挪走的窗口仍然是"可见"的。** 所以"把窗口放回来"的兜底逻辑不能只判断窗口是否隐藏，  
  还要判断它是否在屏幕外。
- **PowerShell 5.1 的怪癖**：`Add-Type -AssemblyName A, B` 要分两次调用；  
  `Form.DoubleBuffered` 是 protected，得用 `Control.SetStyle` 反射；  
  `New-Object Type($a,$b,$c,$d)` 会绑成 `Object[]`，要用 `[Type]::new(...)`；  
  事件处理器返回值会漏进函数管道，得 `[void]` 掉；`-File` 参数会被重新解析并吃掉 JSON 里的引号，  
  所以请求要用 base64 传。
- **必须 `-STA`。** WinForms 的模态选区窗口需要 STA 线程。

## 卸载

```
plugin_manager → action: remove_bundle → target: @local/dsh-screenshot
```

或者从 profile 的 `cordis.patch.yml` 里删掉那一行。工作区里的 `.dsh-screenshots`  
目录会在插件卸载时清除。

## 许可证

MIT
