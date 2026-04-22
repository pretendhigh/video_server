# Video Server

一个基于 Flask 的本地视频服务器，提供缩略图、分类浏览、搜索、收藏、认证和管理员能力。

## 功能特性

- 视频库扫描：递归扫描目录，按顶层文件夹自动分类，首页按“每行一个类型”展示
- 视频列表缓存：页面刷新默认复用服务端缓存，后台按配置周期重新扫描；也支持管理员手动刷新
- 分类导航：顶部类型标签按 ASCII 顺序显示，`Favorites` 和 `Uncategorized` 靠前，支持左右分页切换，到边界时对应按钮会置灰
- 视频播放：自定义播放器，支持播放/暂停、快进快退、拖拽进度、倍速、全屏、画中画、下载
- 收藏功能：登录用户可在卡片和播放器内直接收藏/取消收藏，并按 `Favorites` 分类查看
- 认证与权限：支持 `strict` / `relaxed` 两种认证模式，区分普通用户与管理员
- 管理员界面：支持用户管理、登录日志查看、服务器日志查看、缩略图刷新
- 缩略图生成：基于 `ffmpeg` 自动生成视频封面
- 重复检测：同名且内容相同的视频只显示一次，内容判定支持可配置 hash 算法
- 日志轮转：服务日志自动滚动切分，便于排查问题
- 键盘快捷键：播放器支持常用快捷键操作

## 项目结构

```text
video_server/
├── video_server.py      # Flask 服务入口
├── config.example.json  # 示例配置
├── config.json          # 实际配置（首次启动可自动生成）
├── requirements.txt     # Python 依赖
├── README.md            # 项目说明
├── AGENTS.md            # 代理/协作规则
├── static/
│   ├── app.js           # 前端逻辑
│   └── style.css        # 页面样式
├── templates/
│   └── index.html       # 页面模板
├── instance/
│   └── users.db         # 用户、收藏、登录日志数据库
├── thumbnails/          # 缩略图缓存
└── logs/                # 服务日志
```

## 安装依赖

```bash
pip install -r requirements.txt
```

`requirements.txt` 当前包含：

- `Flask`
- `flask-sqlalchemy`
- `flask-login`

同时需要安装 `ffmpeg` / `ffprobe` 用于生成缩略图和获取视频时长：

```bash
# macOS
brew install ffmpeg

# Ubuntu / Debian
sudo apt install ffmpeg
```

## 快速开始

```bash
# 使用当前目录作为视频目录，端口 8000
python video_server.py

# 指定视频目录
python video_server.py /path/to/videos

# 指定视频目录和端口
python video_server.py /path/to/videos 8080
```

启动后访问：

```text
http://localhost:8000
```

## 配置

项目支持通过 `config.json` 配置。若文件不存在，首次启动时会自动生成默认配置。建议从 `config.example.json` 复制后修改。

示例：

```json
{
  "server": {
    "host": "0.0.0.0",
    "port": 8000,
    "video_dir": "."
  },
  "playback": {
    "speeds": [0.5, 1, 1.25, 1.5, 2, 3, 5],
    "skip_duration": 10
  },
  "scan": {
    "interval_seconds": 300,
    "content_hash_algorithms": ["sha1"]
  },
  "ui": {
    "controls_hide_delay": 3000
  },
  "logging": {
    "level": "INFO",
    "max_bytes": 104857600,
    "backup_count": 10,
    "format": "%(asctime)s [%(levelname)s] %(message)s"
  },
  "auth": {
    "enabled": false,
    "mode": "relaxed",
    "session_days": 7,
    "users": [
      { "username": "admin", "password": "changeme", "role": "admin" }
    ]
  }
}
```

### 关键配置项

| 配置项 | 说明 | 默认值 |
| --- | --- | --- |
| `server.host` | 监听地址 | `0.0.0.0` |
| `server.port` | 服务端口 | `8000` |
| `server.video_dir` | 视频根目录 | `.` |
| `playback.speeds` | 可选倍速列表 | `[0.5, 1, 1.25, 1.5, 2, 3, 5]` |
| `playback.skip_duration` | 快进/快退秒数 | `10` |
| `scan.interval_seconds` | 服务端视频列表缓存的后台重扫周期，单位秒；设为 `0` 时禁用自动重扫，仅在管理员执行 `Refresh` 时重新扫描 | `300` |
| `scan.content_hash_algorithms` | 扫描去重时使用的内容 hash 算法列表，支持 `md5`、`sha1`、`sha256` 及 `*sum` 别名；配置多个时需全部匹配才视为同内容 | `["sha1"]` |
| `ui.controls_hide_delay` | 全屏时控制栏自动隐藏延迟（毫秒） | `3000` |
| `logging.level` | 日志级别 | `INFO` |
| `logging.max_bytes` | 单个日志文件最大大小 | `104857600` |
| `logging.backup_count` | 日志备份数量 | `10` |
| `auth.enabled` | 是否启用认证 | `false` |
| `auth.mode` | 认证模式：`strict` / `relaxed` | `relaxed` |
| `auth.session_days` | 会话有效期（天） | `7` |
| `auth.users` | 首次初始化用户列表 | `admin/changeme` |

## 视频目录分类规则

服务会递归扫描视频目录，并按顶层文件夹自动分类：

```text
videos/
├── class1/
│   ├── dir1/
│   │   └── video1.mp4
│   └── dir2/
│       └── video2.mp4
├── class2/
│   └── video3.mp4
└── movie.mkv            # Uncategorized
```

- `class1/dir1/video1.mp4` 归类到 `class1`
- 根目录下的视频归类到 `Uncategorized`
- 首页总览模式下，每个分类单独占一行，分类内视频自动换行
- 页面刷新只会重新读取服务端缓存，不会强制重新扫描磁盘
- 扫描到同名文件时，会用 `scan.content_hash_algorithms` 逐个计算实际内容 hash；只有全部配置算法的结果都一致，才会判定为同内容重复文件

## 认证与权限

### 认证关闭

- 所有人都可以浏览、播放、刷新缩略图、查看日志
- 不显示登录限制，也不会要求用户数据库

### `relaxed` 模式

- 匿名用户可以浏览视频和播放视频
- 搜索、收藏需要登录
- 日志、用户管理、缩略图刷新仅管理员可用

### `strict` 模式

- 未登录用户无法访问首页和 API
- 登录后按角色获得对应权限

### 角色说明

- `user`：可浏览、搜索、收藏、播放
- `admin`：额外可查看服务日志、查看登录日志、管理用户、刷新缩略图

用户数据、收藏记录和登录日志保存在 `instance/users.db`。

## Web 界面说明

### 首页

- 搜索框：支持搜索视频名
- 分类标签：支持大量分类的左右翻页切换
- `Favorites`：登录后显示，展示当前用户已收藏视频
- 右上角头像菜单：显示当前用户、角色，以及 `Refresh` / `Admin` / `Logs` / `Logout`

### 播放器

- 自定义控制栏
- 中央大播放按钮
- 倍速菜单
- 画中画
- 下载当前视频
- 收藏当前视频
- 全屏模式下控制栏自动隐藏

## API 接口

### 公开 / 基础接口

| 接口 | 方法 | 说明 |
| --- | --- | --- |
| `/` | GET | 主页面 |
| `/api/me` | GET | 当前用户与认证状态 |
| `/api/config` | GET | 前端配置 |
| `/api/videos` | GET | 视频列表和分类 |
| `/api/search?q=keyword` | GET | 搜索视频 |
| `/api/categories` | GET | 分类分组数据 |
| `/video/<path>` | GET | 视频流，支持 Range |
| `/thumbnail/<path>` | GET | 视频缩略图 |

### 认证相关接口

| 接口 | 方法 | 说明 |
| --- | --- | --- |
| `/login` | GET / POST | 登录 |
| `/logout` | POST | 登出 |
| `/api/favorites` | GET | 获取当前用户收藏列表 |
| `/api/favorites/<video_id>` | POST | 添加收藏 |
| `/api/favorites/<video_id>` | DELETE | 取消收藏 |

### 管理员接口

| 接口 | 方法 | 说明 |
| --- | --- | --- |
| `/api/logs` | GET | 最近服务日志 |
| `/api/refresh` | POST | 重新生成缩略图 |
| `/api/admin/users` | GET | 获取用户列表 |
| `/api/admin/users` | POST | 创建用户 |
| `/api/admin/users/<user_id>` | DELETE | 删除用户 |
| `/api/admin/login-logs` | GET | 获取登录日志 |

## 播放器快捷键

| 按键 | 功能 |
| --- | --- |
| `Space` / `K` | 播放 / 暂停 |
| `←` | 后退 10 秒 |
| `→` | 前进 10 秒 |
| `↑` | 增加音量 |
| `↓` | 降低音量 |
| `F` | 切换全屏 |
| `Esc` | 退出播放器 / 全屏 / 关闭倍速菜单 |
| `1` | 1x |
| `2` | 2x |
| `3` | 3x |
| `5` | 5x |

## 支持格式

- MP4
- WebM
- MKV
- AVI
- MOV
- FLV
- WMV
- M4V

## 日志

日志位于 `logs/` 目录，默认使用轮转文件：

- `server.log`
- `server.log.1`
- `server.log.2` ... `server.log.10`

默认策略：

- 单文件最大 `100 MB`
- 最多保留 `10` 个备份

启用认证时，Web 日志查看仅管理员可见。

## 注意事项

- 首次启动时会生成缩略图，耗时取决于视频数量和时长
- 缩略图缓存位于 `thumbnails/`
- 同名且内容相同的视频会自动去重
- 命令行参数会覆盖 `config.json` 中的 `video_dir` 和 `port`
- 默认密码仅适用于初始化，请尽快修改
