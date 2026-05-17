# 声声课堂自动挂课助手

> 声声课堂 (shengshengketang.com) 自动挂课 Tampermonkey 脚本

## 功能

- **可调倍速播放** — 1x / 1.5x / 3x / 4x / 5x / 7.5x，面板一键切换
- **自动答题** — 拦截 API 获取正确答案，随堂测验弹出后自动作答并关闭
- **自动下一节** — 当前视频播完自动切换到下一个视频
- **自动下一门课** — 一门课全部完成后，自动跳转到同分类下一门未完成的课程
- **浮窗控制面板** — 实时显示状态、进度、日志，可拖拽、可最小化
- **自动静音** — 挂课不打扰

## 安装

### 1. 安装 Tampermonkey 扩展

| 浏览器 | 链接 |
|--------|------|
| Chrome | [Chrome Web Store](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) |
| Edge | [Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd) |
| Firefox | [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/tampermonkey/) |

### 2. 安装脚本

点击下方链接，Tampermonkey 会自动弹出安装提示：

**[点击安装脚本](https://raw.githubusercontent.com/zqs1qiwan/shengshengketang-auto/main/shengsheng-autoplay.user.js)**

或者手动安装：Tampermonkey 管理面板 → 创建新脚本 → 粘贴 `shengsheng-autoplay.user.js` 内容 → 保存

## 使用

1. 打开声声课堂的课程视频页面
2. 右上角出现控制面板
3. 选择倍速（默认 3x）
4. 点击 **「开始挂课」**
5. 挂课期间可随时切换倍速或停止

## 倍速说明

| 倍速 | 24 分钟视频耗时 | 说明 |
|------|----------------|------|
| 1x | 24 分钟 | 原速 |
| 1.5x | 16 分钟 | 网页端官方最高倍速 |
| 3x | 8 分钟 | 默认，稳定 |
| 5x | ~5 分钟 | 快速 |
| 7.5x | ~3 分钟 | 极速，实测可用上限 |

> 8x 及以上会触发播放器「请勿快进」提示，7.5x 是实测安全上限。

## 注意事项

- 需要保持浏览器标签页打开（可以最小化窗口但不要关闭标签）
- macOS 防止休眠：终端运行 `caffeinate -d`
- 脚本通过浏览器内播放器运行，进度由网站自身上报，安全性较高
- 首次观看的视频不能拖动进度条快进，但可以用高倍速播放

## License

[MIT](LICENSE)
