# Video Server

一个 Flask 视频流媒体服务器，提供现代化的 Web 界面来浏览、搜索和播放视频。

## 功能特性

- 🎬 **视频播放**: HTML5 视频播放器，支持调速 (0.5x - 5x)
- 🖼️ **缩略图**: 自动生成视频缩略图
- 📁 **按文件夹分类**: 自动识别文件夹作为视频类别
- 🔍 **模糊搜索**: 支持视频名称和类别的搜索
- 📜 **日志功能**: 便于排查问题
- 🗂️ **重复检测**: 自动检测同名视频，相同文件只显示一次
- ♿ **键盘快捷键**: 空格播放/暂停, ←/→ 快进快退, F 全屏

## 项目结构

```
video/
├── video_server.py      # 主服务器入口
├── config.json          # 配置文件
├── static/
│   ├── style.css        # 界面样式
│   └── app.js           # 前端逻辑
├── templates/
│   └── index.html       # 页面模板
├── thumbnails/          # 自动生成的缩略图缓存
├── logs/                # 日志文件
└── my_video/            # 示例视频目录
```

## 安装依赖

```bash
pip install -r requirements.txt
```

同时需要安装 `ffmpeg` 用于生成视频缩略图：

```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt install ffmpeg

# Windows
# 从 https://ffmpeg.org/download.html 下载并添加到 PATH
```

## 配置文件

服务器支持通过 `config.json` 进行配置。首次启动时会自动生成默认配置文件。

```json
{
    "server": {
        "host": "0.0.0.0",
        "port": 8000,
        "video_dir": "."
    },
    "playback": {
        "speeds": [0.5, 1, 1.25, 1.5, 2, 3, 5]
    },
    "logging": {
        "level": "INFO",
        "max_bytes": 104857600,
        "backup_count": 10,
        "format": "%(asctime)s [%(levelname)s] %(message)s"
    }
}
```

### 配置项说明

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `server.host` | 服务器监听地址 | `0.0.0.0` |
| `server.port` | 服务器端口 | `8000` |
| `server.video_dir` | 视频根目录 | `.` |
| `playback.speeds` | 播放速度选项 | `[0.5, 1, 1.25, 1.5, 2, 3, 5]` |
| `logging.level` | 日志级别 (DEBUG/INFO/WARNING/ERROR) | `INFO` |
| `logging.max_bytes` | 单个日志文件最大字节数 | `104857600` (100 MB) |
| `logging.backup_count` | 保留的备份日志数量 | `10` |

## 使用方法

### 启动服务器

```bash
# 基本用法（当前目录，端口 8000）
python video_server.py

# 指定视频目录
python video_server.py /path/to/videos

# 指定端口
python video_server.py /path/to/videos 8080
```

### 访问界面

打开浏览器访问 `http://localhost:8000`

### 视频目录结构

服务器会递归扫描视频目录，按顶层文件夹自动分类：

```
videos/
├── class1/              # 类别: class1
│   ├── dir1/
│   │   └── video1.mp4
│   └── dir2/
│       └── video2.mp4
├── class2/              # 类别: class2
│   └── video3.mp4
└── movie.mkv            # 类别: Uncategorized (根目录)
```

## API 接口

| 接口 | 方法 | 描述 |
|------|------|------|
| `/` | GET | 主页面 |
| `/api/config` | GET | 获取前端配置（倍速等） |
| `/api/videos` | GET | 获取所有视频列表和类别信息 |
| `/api/search?q=keyword` | GET | 搜索视频 |
| `/api/categories` | GET | 获取按类别分组的视频 |
| `/api/logs` | GET | 获取服务器日志 |
| `/api/refresh` | POST | 刷新所有缩略图 |
| `/video/<path>` | GET | 视频流（支持 range 请求） |
| `/thumbnail/<path>` | GET | 获取视频缩略图 |

## 键盘快捷键

| 按键 | 功能 |
|------|------|
| `Space` / `K` | 播放/暂停 |
| `←` | 后退 10 秒 |
| `→` | 前进 10 秒 |
| `↑` | 增加音量 |
| `↓` | 降低音量 |
| `F` | 全屏切换 |
| `1` | 播放速度 1x |
| `2` | 播放速度 2x |
| `3` | 播放速度 3x |
| `5` | 播放速度 5x |

## 播放器功能

- **完全自定义控制栏**: 屏蔽浏览器原生控制栏，使用统一风格的自定义 UI
- **悬停显示**: 鼠标悬停时显示播放控制按钮、进度条、倍速菜单
- **倍速选择**: 点击"倍速"按钮弹出速度选择菜单（0.5x - 5x）
- **画中画 (PIP)**: 支持小窗口播放，可边浏览边观看
- **下载按钮**: 一键下载当前播放的视频
- **进度条拖拽**: 支持点击和拖拽跳转
- **大播放按钮**: 暂停时显示中央大播放按钮
| `Esc` | 退出播放器/全屏 |

## 支持的格式

- MP4
- WebM
- MKV
- AVI
- MOV
- FLV
- WMV
- M4V

## 日志

日志文件保存在 `logs/` 目录下，支持自动滚动切割：
- `server.log` - 当前日志文件
- `server.log.1` - 最近的备份
- `server.log.2` ~ `server.log.10` - 较早的备份

默认配置：
- 单个日志文件最大 **100 MB**
- 最多保留 **11** 个文件（当前 + 10 个备份）

也可通过 Web 界面或 API (`/api/logs`) 查看。

## 注意事项

- 首次启动时会自动生成缩略图，可能需要一些时间
- 缩略图缓存保存在 `thumbnails/` 目录
- 相同文件名且相同内容的视频会自动去重，并在日志中记录警告
- 命令行参数会覆盖配置文件中的设置
