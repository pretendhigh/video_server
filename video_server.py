#!/usr/bin/env python3
"""
Video Server - A Flask-based video streaming server with thumbnail support.

Usage:
    python video_server.py [directory] [port]

Example:
    python video_server.py /path/to/videos 8080
"""

import os
import sys
import json
import copy
import hashlib
import subprocess
import mimetypes
import threading
import logging
import logging.handlers
from pathlib import Path
from urllib.parse import quote, unquote
from collections import defaultdict, deque
from datetime import datetime

from flask import Flask, render_template, jsonify, send_file, request, Response, redirect, url_for
from functools import wraps

try:
    from flask_sqlalchemy import SQLAlchemy
    from flask_login import LoginManager, UserMixin, login_user, logout_user, login_required, current_user
    from werkzeug.security import generate_password_hash, check_password_hash
    AUTH_LIBS_AVAILABLE = True
except ImportError:
    AUTH_LIBS_AVAILABLE = False

app = Flask(__name__)

# Auth-related globals (initialized conditionally)
if AUTH_LIBS_AVAILABLE:
    db = SQLAlchemy()
    login_manager = LoginManager()
else:
    db = None
    login_manager = None

# Default configuration - used when config.json is missing or incomplete
DEFAULT_CONFIG = {
    "server": {
        "host": "0.0.0.0",
        "port": 8000,
        "video_dir": "."
    },
    "playback": {
        "speeds": [0.5, 1, 1.25, 1.5, 2, 3, 5],
        "skip_duration": 10  # seconds for fast forward/rewind
    },
    "logging": {
        "level": "INFO",
        "max_bytes": 104857600,  # 100 MB
        "backup_count": 10,
        "format": "%(asctime)s [%(levelname)s] %(message)s"
    },
    "scan": {
        "content_hash_algorithms": ["sha1"],
        "interval_seconds": 300
    },
    "ui": {
        "controls_hide_delay": 3000  # milliseconds
    },
    "auth": {
        "enabled": False,
        "mode": "relaxed",
        "secret_key": None,
        "session_days": 7,
        "users": [
            {"username": "admin", "password": "changeme", "role": "admin"}
        ]
    }
}


def deep_merge(default, override):
    """Deep merge two dictionaries. Override values take precedence."""
    result = default.copy()
    for key, value in override.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    return result

# Global configuration
CONFIG = {}
VIDEO_DIR = Path(".")
THUMBNAIL_DIR = Path("thumbnails")
LOG_DIR = Path("logs")
VIDEO_EXTENSIONS = {'.mp4', '.webm', '.mkv', '.avi', '.mov', '.flv', '.wmv', '.m4v'}
HASH_CHUNK_SIZE = 1024 * 1024
VIDEO_CACHE_LOCK = threading.Lock()
VIDEO_CACHE_DATA = None
VIDEO_CACHE_UPDATED_AT = None
VIDEO_SCAN_THREAD = None
VIDEO_SCAN_STOP_EVENT = threading.Event()

# Global logger
logger = logging.getLogger('video_server')


def ascii_sort_key(value: str):
    """Sort strings using their original code-point order without natural sorting."""
    return value


def category_sort_key(value: str):
    """Keep Uncategorized first, then sort remaining categories by ASCII order."""
    if value == 'Uncategorized':
        return (0, value)
    return (1, value)


def normalize_hash_algorithm(name: str):
    """Normalize configured hash algorithm names, allowing common *sum aliases."""
    if not isinstance(name, str):
        return None

    normalized = name.strip().lower()
    if not normalized:
        return None

    candidates = [normalized]
    if normalized.endswith('sum'):
        candidates.append(normalized[:-3])

    for candidate in candidates:
        if candidate in hashlib.algorithms_guaranteed:
            return candidate

    for candidate in candidates:
        if candidate in hashlib.algorithms_available:
            return candidate

    return None


def get_content_hash_algorithms():
    """Return the configured content-hash algorithms and any invalid values."""
    configured = CONFIG.get('scan', {}).get(
        'content_hash_algorithms',
        DEFAULT_CONFIG['scan']['content_hash_algorithms']
    )

    if isinstance(configured, str):
        configured = [configured]

    algorithms = []
    invalid = []

    for name in configured or []:
        normalized = normalize_hash_algorithm(name)
        if normalized is None:
            invalid.append(str(name))
            continue
        if normalized not in algorithms:
            algorithms.append(normalized)

    if algorithms:
        return algorithms, invalid

    fallback = []
    for name in DEFAULT_CONFIG['scan']['content_hash_algorithms']:
        normalized = normalize_hash_algorithm(name)
        if normalized and normalized not in fallback:
            fallback.append(normalized)

    return fallback, invalid


def get_scan_interval_seconds():
    """Get the configured scan interval in seconds. Zero disables automatic rescans."""
    configured = CONFIG.get('scan', {}).get(
        'interval_seconds',
        DEFAULT_CONFIG['scan']['interval_seconds']
    )

    try:
        interval_seconds = int(configured)
    except (TypeError, ValueError):
        logger.warning(
            "Invalid scan.interval_seconds value %r, falling back to %s",
            configured,
            DEFAULT_CONFIG['scan']['interval_seconds']
        )
        return DEFAULT_CONFIG['scan']['interval_seconds']

    return max(0, interval_seconds)


def load_config():
    """Load configuration from config.json or use defaults."""
    global CONFIG
    config_path = Path(__file__).parent / 'config.json'

    # Start with deep copy of defaults
    CONFIG = copy.deepcopy(DEFAULT_CONFIG)

    if config_path.exists():
        try:
            with open(config_path, 'r', encoding='utf-8') as f:
                user_config = json.load(f)
                # Deep merge user config with defaults
                CONFIG = deep_merge(CONFIG, user_config)
            print(f"Configuration loaded from: {config_path}")
        except Exception as e:
            print(f"Error loading config: {e}, using defaults")
    else:
        # Create default config file
        try:
            with open(config_path, 'w', encoding='utf-8') as f:
                json.dump(DEFAULT_CONFIG, f, indent=4)
            print(f"Default configuration created at: {config_path}")
        except Exception as e:
            print(f"Error creating default config: {e}")

    return CONFIG


def setup_logging():
    """Setup logging configuration with rotation."""
    global logger

    LOG_DIR.mkdir(exist_ok=True)

    log_config = CONFIG.get('logging', DEFAULT_CONFIG['logging'])
    log_level = getattr(logging, log_config.get('level', 'INFO'))
    max_bytes = log_config.get('max_bytes', 104857600)  # 100 MB
    backup_count = log_config.get('backup_count', 10)
    log_format = log_config.get('format', '%(asctime)s [%(levelname)s] %(message)s')

    # Use RotatingFileHandler for log rotation
    log_file = LOG_DIR / "server.log"

    handlers = []

    # Rotating file handler
    file_handler = logging.handlers.RotatingFileHandler(
        log_file,
        maxBytes=max_bytes,
        backupCount=backup_count,
        encoding='utf-8'
    )
    file_handler.setFormatter(logging.Formatter(log_format))
    handlers.append(file_handler)

    # Console handler
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(logging.Formatter(log_format))
    handlers.append(console_handler)

    # Configure root logger
    logging.basicConfig(
        level=log_level,
        handlers=handlers,
        force=True
    )

    logger = logging.getLogger('video_server')

    logger.info("=" * 60)
    logger.info("Video Server Starting...")
    logger.info(f"Log level: {log_config.get('level', 'INFO')}")
    logger.info(f"Max log size: {format_size(max_bytes)}, backups: {backup_count}")
    logger.info("=" * 60)


def get_file_content_signature(file_path: Path, algorithms: list[str]):
    """Generate a content-hash signature for a file using one or more algorithms."""
    hashers = [(algorithm, hashlib.new(algorithm)) for algorithm in algorithms]

    try:
        with open(file_path, 'rb') as handle:
            while True:
                chunk = handle.read(HASH_CHUNK_SIZE)
                if not chunk:
                    break
                for _, hasher in hashers:
                    hasher.update(chunk)
    except OSError as exc:
        logger.error(f"Failed to hash file {file_path}: {exc}")
        return None

    return tuple((algorithm, hasher.hexdigest()) for algorithm, hasher in hashers)


def get_video_hash(video_path: Path) -> str:
    """Generate a unique hash for a video file based on its path and size."""
    stat = video_path.stat()
    content = f"{str(video_path.absolute())}:{stat.st_size}:{stat.st_mtime}"
    return hashlib.md5(content.encode()).hexdigest()


def get_thumbnail_path(video_path: Path) -> Path:
    """Get the thumbnail path for a video file."""
    video_hash = get_video_hash(video_path)
    return THUMBNAIL_DIR / f"{video_hash}.jpg"


def generate_thumbnail(video_path: Path) -> tuple[Path, float]:
    """Generate a thumbnail for a video file using ffmpeg.

    Returns:
        tuple of (thumbnail_path, duration_seconds)
        thumbnail_path is None if generation failed
        duration_seconds is 0 if duration could not be determined
    """
    thumbnail_path = get_thumbnail_path(video_path)
    duration = 0.0

    if thumbnail_path.exists():
        # Still need to get duration even if thumbnail exists
        duration = get_video_duration(video_path)
        return thumbnail_path, duration

    try:
        logger.info(f"Generating thumbnail for: {video_path.name}")

        # Get video duration to extract frame at 10%
        result = subprocess.run(
            ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'default=noprint_wrappers=1:nokey=1', str(video_path)],
            capture_output=True, text=True, timeout=30
        )

        if result.returncode == 0:
            duration = float(result.stdout.strip())
            timestamp = duration * 0.1  # 10% into the video
        else:
            timestamp = 5  # Default to 5 seconds if duration unknown

        # Generate thumbnail using ffmpeg
        cmd = [
            'ffmpeg', '-y', '-ss', str(timestamp), '-i', str(video_path),
            '-vframes', '1', '-q:v', '2', '-vf', 'scale=320:-1',
            str(thumbnail_path)
        ]

        result = subprocess.run(
            cmd, capture_output=True, timeout=60
        )

        if result.returncode == 0 and thumbnail_path.exists():
            logger.info(f"Thumbnail generated: {thumbnail_path.name}")
            return thumbnail_path, duration
        else:
            logger.warning(f"Failed to generate thumbnail for {video_path.name}")

    except subprocess.TimeoutExpired:
        logger.error(f"Timeout generating thumbnail for {video_path.name}")
    except FileNotFoundError:
        logger.error("ffmpeg not found. Please install ffmpeg.")
    except Exception as e:
        logger.error(f"Error generating thumbnail for {video_path.name}: {e}")

    return None, duration


def get_video_duration(video_path: Path) -> float:
    """Get video duration in seconds using ffprobe."""
    try:
        result = subprocess.run(
            ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'default=noprint_wrappers=1:nokey=1', str(video_path)],
            capture_output=True, text=True, timeout=30
        )
        if result.returncode == 0:
            duration = float(result.stdout.strip())
            return duration
    except (subprocess.TimeoutExpired, ValueError, FileNotFoundError):
        pass
    return 0


def format_duration(seconds: float) -> str:
    """Format duration in seconds to MM:SS or HH:MM:SS."""
    if seconds <= 0:
        return ''
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    if hours > 0:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


def get_category(rel_path: Path) -> str:
    """Extract category from relative path (top-level folder name)."""
    parts = rel_path.parts
    if len(parts) > 1:
        return parts[0]
    return "Uncategorized"


def scan_videos(directory: Path) -> dict:
    """
    Scan directory recursively for video files.

    Returns:
        dict with 'videos' list and 'categories' dict
    """
    videos = []
    categories = defaultdict(list)
    seen_names = defaultdict(list)  # name -> list of seen variants for deduplication
    duplicate_count = 0
    hash_algorithms, invalid_hash_algorithms = get_content_hash_algorithms()

    logger.info(f"Scanning directory: {directory}")
    logger.info(f"Duplicate detection content hash algorithms: {', '.join(hash_algorithms)}")
    if invalid_hash_algorithms:
        logger.warning(
            "Ignoring unsupported content hash algorithms: "
            + ", ".join(invalid_hash_algorithms)
        )

    for root, dirs, files in os.walk(directory):
        root_path = Path(root)

        # Skip thumbnail and log directories
        if 'thumbnails' in root_path.parts or 'logs' in root_path.parts:
            continue

        for filename in files:
            file_path = root_path / filename
            ext = file_path.suffix.lower()

            if ext in VIDEO_EXTENSIONS:
                # Get relative path for URL
                try:
                    rel_path = file_path.relative_to(directory)
                except ValueError:
                    continue

                name = file_path.stem
                size = file_path.stat().st_size
                name_variants = seen_names[name]
                current_signature = None
                duplicate_match = None

                # Check for duplicate (same name, same content)
                for seen_variant in name_variants:
                    if seen_variant['size'] != size:
                        continue

                    if current_signature is None:
                        current_signature = get_file_content_signature(file_path, hash_algorithms)
                        if current_signature is None:
                            break

                    if seen_variant['content_signature'] is None:
                        seen_variant['content_signature'] = get_file_content_signature(
                            seen_variant['path'],
                            hash_algorithms
                        )

                    if seen_variant['content_signature'] == current_signature:
                        duplicate_match = seen_variant
                        break

                if duplicate_match is not None:
                    logger.warning(
                        f"Duplicate video skipped: {rel_path} "
                        f"(same as {duplicate_match['rel_path']})"
                    )
                    duplicate_count += 1
                    continue

                if name_variants:
                    logger.warning(
                        f"Same name but different content: {rel_path} "
                        f"(compared with {', '.join(hash_algorithms)})"
                    )

                name_variants.append({
                    'path': file_path,
                    'rel_path': rel_path,
                    'size': size,
                    'content_signature': current_signature
                })

                # Get category
                category = get_category(rel_path)

                # Generate or get thumbnail (returns both thumbnail path and duration)
                thumbnail, duration = generate_thumbnail(file_path)

                # Get file size
                video_info = {
                    'id': get_video_hash(file_path),
                    'name': name,
                    'filename': filename,
                    'path': str(rel_path),
                    'url_path': quote(str(rel_path)),
                    'thumbnail': f"/thumbnail/{quote(str(rel_path))}" if thumbnail else None,
                    'size': size,
                    'size_formatted': format_size(size),
                    'duration': duration,
                    'duration_formatted': format_duration(duration),
                    'ext': ext[1:],
                    'category': category,
                    'subfolder': str(rel_path.parent) if len(rel_path.parts) > 1 else ''
                }

                videos.append(video_info)
                categories[category].append(video_info)

    # Sort videos by name
    videos.sort(key=lambda x: ascii_sort_key(x['name']))

    # Sort categories
    sorted_categories = dict(sorted(categories.items(), key=lambda item: category_sort_key(item[0])))
    for cat in sorted_categories:
        sorted_categories[cat].sort(key=lambda x: ascii_sort_key(x['name']))

    logger.info(f"Scan complete: {len(videos)} videos found, {duplicate_count} duplicates skipped")
    logger.info(f"Categories: {list(sorted_categories.keys())}")

    return {
        'videos': videos,
        'categories': sorted_categories,
        'count': len(videos),
        'duplicate_count': duplicate_count
    }


def clear_thumbnail_cache() -> int:
    """Delete cached thumbnail files and return the number removed."""
    if not THUMBNAIL_DIR.exists():
        return 0

    count = 0
    for thumbnail in THUMBNAIL_DIR.glob('*.jpg'):
        try:
            thumbnail.unlink()
            count += 1
        except OSError as exc:
            logger.warning(f"Failed to remove thumbnail {thumbnail.name}: {exc}")
    return count


def refresh_video_cache(reason='manual refresh', clear_thumbnails=False) -> dict:
    """Rebuild the in-memory video cache and return a deep copy of the new data."""
    global VIDEO_CACHE_DATA, VIDEO_CACHE_UPDATED_AT

    with VIDEO_CACHE_LOCK:
        if clear_thumbnails:
            cleared = clear_thumbnail_cache()
            logger.info(f"Cleared {cleared} thumbnails")

        logger.info(f"Refreshing video cache ({reason})")
        VIDEO_CACHE_DATA = scan_videos(VIDEO_DIR)
        VIDEO_CACHE_UPDATED_AT = datetime.utcnow()
        return copy.deepcopy(VIDEO_CACHE_DATA)


def get_video_cache() -> dict:
    """Return a deep copy of the cached video data, initializing it on first use."""
    global VIDEO_CACHE_DATA, VIDEO_CACHE_UPDATED_AT

    with VIDEO_CACHE_LOCK:
        if VIDEO_CACHE_DATA is None:
            logger.info("Video cache is empty, performing initial scan")
            VIDEO_CACHE_DATA = scan_videos(VIDEO_DIR)
            VIDEO_CACHE_UPDATED_AT = datetime.utcnow()
        return copy.deepcopy(VIDEO_CACHE_DATA)


def periodic_video_scan_worker():
    """Refresh the video cache on the configured interval."""
    interval_seconds = get_scan_interval_seconds()

    while interval_seconds > 0 and not VIDEO_SCAN_STOP_EVENT.wait(interval_seconds):
        try:
            refresh_video_cache(reason=f"scheduled scan every {interval_seconds}s")
        except Exception as exc:
            logger.error(f"Scheduled video scan failed: {exc}")


def start_periodic_video_scan():
    """Start the background scan worker when automatic refresh is enabled."""
    global VIDEO_SCAN_THREAD

    interval_seconds = get_scan_interval_seconds()
    if interval_seconds <= 0:
        logger.info("Automatic video rescans disabled; cache updates on startup and manual refresh")
        return

    if VIDEO_SCAN_THREAD and VIDEO_SCAN_THREAD.is_alive():
        return

    VIDEO_SCAN_STOP_EVENT.clear()
    VIDEO_SCAN_THREAD = threading.Thread(
        target=periodic_video_scan_worker,
        name='video-scan-worker',
        daemon=True
    )
    VIDEO_SCAN_THREAD.start()
    logger.info(f"Automatic video rescans enabled every {interval_seconds} seconds")


def format_size(size: int) -> str:
    """Format file size in human-readable format."""
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if size < 1024:
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} PB"


def serve_file_with_range(file_path: Path, mimetype: str):
    """Serve a file with support for HTTP range requests."""
    file_size = file_path.stat().st_size

    range_header = request.headers.get('Range')

    if range_header:
        # Parse range header
        try:
            byte_range = range_header.replace('bytes=', '').split('-')
            start = int(byte_range[0]) if byte_range[0] else 0
            end = int(byte_range[1]) if byte_range[1] else file_size - 1

            if start >= file_size or end >= file_size:
                return Response(status=416)  # Range not satisfiable

            length = end - start + 1

            with open(file_path, 'rb') as f:
                f.seek(start)
                data = f.read(length)

            response = Response(
                data,
                206,  # Partial content
                mimetype=mimetype,
                direct_passthrough=False
            )
            response.headers.add('Content-Range', f'bytes {start}-{end}/{file_size}')
            response.headers.add('Accept-Ranges', 'bytes')
            response.headers.add('Content-Length', str(length))
            return response

        except (ValueError, IndexError):
            pass

    # No range requested, serve full file
    return send_file(file_path, mimetype=mimetype)


# ===========================
# Auth Models & Helpers
# ===========================

if AUTH_LIBS_AVAILABLE:
    class User(UserMixin, db.Model):
        __tablename__ = 'users'
        id = db.Column(db.Integer, primary_key=True)
        username = db.Column(db.String(80), unique=True, nullable=False, index=True)
        password_hash = db.Column(db.String(256), nullable=False)
        role = db.Column(db.String(20), nullable=False, default='user')
        created_at = db.Column(db.DateTime, default=datetime.utcnow)

        def set_password(self, password):
            self.password_hash = generate_password_hash(password, method='pbkdf2:sha256')

        def check_password(self, password):
            return check_password_hash(self.password_hash, password)

    class Favorite(db.Model):
        __tablename__ = 'favorites'
        id = db.Column(db.Integer, primary_key=True)
        user_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False, index=True)
        video_id = db.Column(db.String(32), nullable=False, index=True)
        created_at = db.Column(db.DateTime, default=datetime.utcnow)
        __table_args__ = (db.UniqueConstraint('user_id', 'video_id', name='uix_user_video'),)

    class LoginLog(db.Model):
        __tablename__ = 'login_logs'
        id = db.Column(db.Integer, primary_key=True)
        user_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False, index=True)
        username = db.Column(db.String(80), nullable=False)
        ip_address = db.Column(db.String(45), nullable=False)
        user_agent = db.Column(db.String(256))
        login_time = db.Column(db.DateTime, default=datetime.utcnow)
        success = db.Column(db.Boolean, default=True)


def is_auth_enabled():
    """Check if authentication is enabled in config."""
    return CONFIG.get('auth', {}).get('enabled', False) and AUTH_LIBS_AVAILABLE


def get_auth_mode():
    """Get current auth mode from config."""
    return CONFIG.get('auth', {}).get('mode', 'relaxed')


def get_or_create_secret_key():
    """Get secret key from config or generate and persist one."""
    key = CONFIG.get('auth', {}).get('secret_key')
    if key:
        return key
    key_file = Path(__file__).parent / '.secret_key'
    if key_file.exists():
        return key_file.read_text().strip()
    import secrets
    key = secrets.token_hex(32)
    key_file.write_text(key)
    return key


def init_auth(app):
    """Initialize authentication components if enabled."""
    if not is_auth_enabled():
        return

    app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///users.db'
    app.config['SECRET_KEY'] = get_or_create_secret_key()
    from datetime import timedelta
    app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(days=CONFIG.get('auth', {}).get('session_days', 7))

    db.init_app(app)
    login_manager.init_app(app)
    login_manager.login_view = 'login'

    @login_manager.user_loader
    def load_user(user_id):
        return db.session.get(User, int(user_id))

    with app.app_context():
        db.create_all()
        bootstrap_users()


def bootstrap_users():
    """Create initial users from config if they don't exist."""
    users_config = CONFIG.get('auth', {}).get('users', [])
    for user_cfg in users_config:
        username = user_cfg.get('username')
        if not username or User.query.filter_by(username=username).first():
            continue
        user = User(username=username, role=user_cfg.get('role', 'user'))
        user.set_password(user_cfg.get('password', 'changeme'))
        db.session.add(user)
        logger.info(f"Created user: {username} (role: {user.role})")
    db.session.commit()


# ===========================
# Auth Decorators
# ===========================

def require_auth(func):
    """Require authentication based on auth mode."""
    @wraps(func)
    def wrapper(*args, **kwargs):
        if not is_auth_enabled():
            return func(*args, **kwargs)
        if get_auth_mode() == 'strict' and not current_user.is_authenticated:
            if request.is_json or request.path.startswith('/api/'):
                return jsonify({'error': 'Login required'}), 401
            return redirect(url_for('login'))
        return func(*args, **kwargs)
    return wrapper


def require_role(role):
    """Require a specific role."""
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            if not is_auth_enabled():
                return func(*args, **kwargs)
            if not current_user.is_authenticated:
                return jsonify({'error': 'Login required'}), 401
            if current_user.role != role:
                return jsonify({'error': f'{role} access required'}), 403
            return func(*args, **kwargs)
        return wrapper
    return decorator


def require_login_for_feature(func):
    """Require login for specific features in relaxed mode."""
    @wraps(func)
    def wrapper(*args, **kwargs):
        if not is_auth_enabled():
            return func(*args, **kwargs)
        if not current_user.is_authenticated:
            return jsonify({'error': 'Login required'}), 401
        return func(*args, **kwargs)
    return wrapper


# ===========================
# Routes
# ===========================

@app.route('/')
@require_auth
def index():
    """Render the main gallery page."""
    return render_template('index.html', show_login=False)


@app.route('/login', methods=['GET', 'POST'])
def login():
    """Login page and authentication handler."""
    if not is_auth_enabled():
        return redirect(url_for('index'))

    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        password = request.form.get('password', '')

        if not username or not password:
            if request.is_json:
                return jsonify({'error': 'Username and password required'}), 400
            return render_template('index.html', show_login=True, login_error='Username and password required')

        user = User.query.filter_by(username=username).first()
        if user and user.check_password(password):
            login_user(user, remember=True)
            # Record login log
            log = LoginLog(
                user_id=user.id,
                username=user.username,
                ip_address=request.remote_addr or 'unknown',
                user_agent=request.headers.get('User-Agent', '')[:256],
                success=True
            )
            db.session.add(log)
            db.session.commit()
            logger.info(f"User logged in: {username}")
            next_page = request.args.get('next')
            if next_page:
                return redirect(next_page)
            return redirect(url_for('index'))

        # Record failed login
        if user:
            log = LoginLog(
                user_id=user.id,
                username=username,
                ip_address=request.remote_addr or 'unknown',
                user_agent=request.headers.get('User-Agent', '')[:256],
                success=False
            )
            db.session.add(log)
            db.session.commit()

        if request.is_json:
            return jsonify({'error': 'Invalid username or password'}), 401
        return render_template('index.html', show_login=True, login_error='Invalid username or password')

    return render_template('index.html', show_login=not current_user.is_authenticated)


@app.route('/logout', methods=['POST'])
def logout():
    """Logout handler."""
    if is_auth_enabled() and current_user.is_authenticated:
        logger.info(f"User logged out: {current_user.username}")
        logout_user()
    return jsonify({'success': True})


@app.route('/api/me')
def api_me():
    """Get current user info and auth configuration."""
    auth_config = CONFIG.get('auth', DEFAULT_CONFIG['auth'])
    result = {
        'auth_enabled': is_auth_enabled(),
        'auth_mode': auth_config.get('mode', 'relaxed')
    }
    if is_auth_enabled() and current_user.is_authenticated:
        result['user'] = {
            'id': current_user.id,
            'username': current_user.username,
            'role': current_user.role
        }
        result['is_authenticated'] = True
    else:
        result['is_authenticated'] = False
    return jsonify(result)


@app.route('/api/config')
@require_auth
def api_config():
    """Get frontend configuration (playback speeds, UI settings, etc)."""
    auth_config = CONFIG.get('auth', DEFAULT_CONFIG['auth'])
    return jsonify({
        'playback': CONFIG.get('playback', DEFAULT_CONFIG['playback']),
        'ui': CONFIG.get('ui', DEFAULT_CONFIG['ui']),
        'auth': {
            'enabled': is_auth_enabled(),
            'mode': auth_config.get('mode', 'relaxed')
        }
    })


@app.route('/api/videos')
@require_auth
def api_videos():
    """API endpoint to get list of videos."""
    data = get_video_cache()

    # Add favorite status if auth is enabled and user is logged in
    if is_auth_enabled() and current_user.is_authenticated:
        fav_ids = {f.video_id for f in Favorite.query.filter_by(user_id=current_user.id).all()}
        for video in data['videos']:
            video['is_favorite'] = video['id'] in fav_ids
        for cat_videos in data['categories'].values():
            for video in cat_videos:
                video['is_favorite'] = video['id'] in fav_ids

    return jsonify(data)


@app.route('/api/search')
@require_auth
def api_search():
    """Search videos by keyword (fuzzy search)."""
    # In relaxed mode, search requires login
    if is_auth_enabled() and get_auth_mode() == 'relaxed' and not current_user.is_authenticated:
        return jsonify({'error': 'Login required'}), 401

    keyword = request.args.get('q', '').lower().strip()
    category = request.args.get('category', '').strip()

    if not keyword:
        return jsonify({'videos': [], 'count': 0})

    logger.info(f"Search request: '{keyword}', category: '{category}'")

    data = get_video_cache()
    all_videos = data['videos']

    # Filter by category first if specified
    if category and category != 'all':
        all_videos = [v for v in all_videos if v['category'] == category]

    # Fuzzy search: match if all characters in keyword appear in order
    def match_score(video):
        name = video['name'].lower()

        # Exact match gets highest score
        if keyword == name:
            return 100
        if keyword in name:
            return 90

        # Fuzzy match (only on name, not category)
        idx = 0
        matches = 0
        for char in keyword:
            idx = name.find(char, idx)
            if idx == -1:
                return 0
            matches += 1
            idx += 1

        return matches if matches == len(keyword) else 0

    results = []
    for video in all_videos:
        score = match_score(video)
        if score > 0:
            video_copy = video.copy()
            video_copy['_score'] = score
            results.append(video_copy)

    # Sort by score descending
    results.sort(key=lambda x: (-x['_score'], ascii_sort_key(x['name'])))

    # Remove score from output
    for r in results:
        del r['_score']

    # Add favorite status
    if is_auth_enabled() and current_user.is_authenticated:
        fav_ids = {f.video_id for f in Favorite.query.filter_by(user_id=current_user.id).all()}
        for video in results:
            video['is_favorite'] = video['id'] in fav_ids

    logger.info(f"Search '{keyword}' returned {len(results)} results")

    return jsonify({
        'videos': results,
        'count': len(results),
        'keyword': keyword
    })


@app.route('/api/categories')
@require_auth
def api_categories():
    """Get videos grouped by category."""
    data = get_video_cache()

    if is_auth_enabled() and current_user.is_authenticated:
        fav_ids = {f.video_id for f in Favorite.query.filter_by(user_id=current_user.id).all()}
        for cat_videos in data['categories'].values():
            for video in cat_videos:
                video['is_favorite'] = video['id'] in fav_ids

    return jsonify({
        'categories': data['categories'],
        'count': data['count']
    })


@app.route('/api/favorites')
@require_login_for_feature
def api_favorites():
    """Get current user's favorite video IDs."""
    if not is_auth_enabled():
        return jsonify({'favorites': [], 'count': 0})
    favs = Favorite.query.filter_by(user_id=current_user.id).all()
    return jsonify({
        'favorites': [{'video_id': f.video_id, 'created_at': f.created_at.isoformat()} for f in favs],
        'count': len(favs)
    })


@app.route('/api/favorites/<video_id>', methods=['POST'])
@require_login_for_feature
def add_favorite(video_id):
    """Add a video to favorites."""
    if not is_auth_enabled():
        return jsonify({'error': 'Authentication is disabled'}), 400
    existing = Favorite.query.filter_by(user_id=current_user.id, video_id=video_id).first()
    if existing:
        return jsonify({'success': True, 'message': 'Already in favorites'})
    fav = Favorite(user_id=current_user.id, video_id=video_id)
    db.session.add(fav)
    db.session.commit()
    logger.info(f"User {current_user.username} favorited video {video_id}")
    return jsonify({'success': True})


@app.route('/api/favorites/<video_id>', methods=['DELETE'])
@require_login_for_feature
def remove_favorite(video_id):
    """Remove a video from favorites."""
    if not is_auth_enabled():
        return jsonify({'error': 'Authentication is disabled'}), 400
    fav = Favorite.query.filter_by(user_id=current_user.id, video_id=video_id).first()
    if fav:
        db.session.delete(fav)
        db.session.commit()
        logger.info(f"User {current_user.username} unfavorited video {video_id}")
    return jsonify({'success': True})


@app.route('/video/<path:filename>')
@require_auth
def serve_video(filename):
    """Serve a video file with range request support."""
    file_path = VIDEO_DIR / unquote(filename)

    logger.debug(f"Video request: {filename}")

    # Security check: ensure file is within VIDEO_DIR
    try:
        file_path.resolve().relative_to(VIDEO_DIR.resolve())
    except ValueError:
        logger.warning(f"Access denied attempt: {filename}")
        return jsonify({'error': 'Access denied'}), 403

    if not file_path.exists():
        logger.warning(f"Video not found: {filename}")
        return jsonify({'error': 'Video not found'}), 404

    mimetype, _ = mimetypes.guess_type(str(file_path))
    if not mimetype:
        mimetype = 'video/mp4'

    return serve_file_with_range(file_path, mimetype)


@app.route('/thumbnail/<path:filename>')
@require_auth
def serve_thumbnail(filename):
    """Serve a thumbnail image."""
    file_path = VIDEO_DIR / unquote(filename)

    try:
        file_path.resolve().relative_to(VIDEO_DIR.resolve())
    except ValueError:
        logger.warning(f"Thumbnail access denied: {filename}")
        return jsonify({'error': 'Access denied'}), 403

    thumbnail_path = get_thumbnail_path(file_path)

    if thumbnail_path.exists():
        return send_file(thumbnail_path, mimetype='image/jpeg')

    # Generate on demand if missing
    thumbnail, _ = generate_thumbnail(file_path)
    if thumbnail:
        return send_file(thumbnail, mimetype='image/jpeg')

    return jsonify({'error': 'Thumbnail not available'}), 404


@app.route('/api/refresh', methods=['POST'])
@require_role('admin')
def refresh_thumbnails():
    """Force regeneration of all thumbnails."""
    logger.info("Refreshing all thumbnails...")
    data = refresh_video_cache(reason='manual admin refresh', clear_thumbnails=True)
    return jsonify({
        'message': f'Refreshed {data["count"]} thumbnails',
        'count': data['count']
    })


@app.route('/api/logs')
@require_role('admin')
def api_logs():
    """Get recent log entries."""
    try:
        log_file = LOG_DIR / "server.log"
        if not log_file.exists():
            return jsonify({'logs': [], 'count': 0})

        # Read only last 100 lines efficiently
        recent_logs = deque(maxlen=100)
        with open(log_file, 'r', encoding='utf-8') as f:
            for line in f:
                recent_logs.append(line)

        return jsonify({
            'logs': [line.strip() for line in recent_logs],
            'count': len(recent_logs)
        })
    except Exception as e:
        logger.error(f"Error reading logs: {e}")
        return jsonify({'error': 'Failed to read logs'}), 500


@app.route('/api/admin/users')
@require_role('admin')
def api_admin_users():
    """Get all users (admin only)."""
    users = User.query.all()
    return jsonify({
        'users': [{
            'id': u.id,
            'username': u.username,
            'role': u.role,
            'created_at': u.created_at.isoformat() if u.created_at else None
        } for u in users],
        'count': len(users)
    })


@app.route('/api/admin/users', methods=['POST'])
@require_role('admin')
def api_admin_create_user():
    """Create a new user (admin only)."""
    data = request.get_json() or {}
    username = data.get('username', '').strip()
    password = data.get('password', '')
    role = data.get('role', 'user')

    if not username or not password:
        return jsonify({'error': 'Username and password required'}), 400
    if role not in ('admin', 'user'):
        return jsonify({'error': 'Role must be admin or user'}), 400
    if User.query.filter_by(username=username).first():
        return jsonify({'error': 'Username already exists'}), 409

    user = User(username=username, role=role)
    user.set_password(password)
    db.session.add(user)
    db.session.commit()
    logger.info(f"Admin created user: {username} (role: {role})")
    return jsonify({
        'success': True,
        'user': {
            'id': user.id,
            'username': user.username,
            'role': user.role,
            'created_at': user.created_at.isoformat()
        }
    })


@app.route('/api/admin/users/<int:user_id>', methods=['DELETE'])
@require_role('admin')
def api_admin_delete_user(user_id):
    """Delete a user (admin only). Cannot delete yourself."""
    user = User.query.get(user_id)
    if not user:
        return jsonify({'error': 'User not found'}), 404
    if user.id == current_user.id:
        return jsonify({'error': 'Cannot delete yourself'}), 400

    # Delete user's favorites first
    Favorite.query.filter_by(user_id=user.id).delete()
    db.session.delete(user)
    db.session.commit()
    logger.info(f"Admin deleted user: {user.username}")
    return jsonify({'success': True})


@app.route('/api/admin/login-logs')
@require_role('admin')
def api_admin_login_logs():
    """Get login logs (admin only)."""
    limit = min(int(request.args.get('limit', 100)), 500)
    logs = LoginLog.query.order_by(LoginLog.login_time.desc()).limit(limit).all()
    return jsonify({
        'logs': [{
            'id': log.id,
            'user_id': log.user_id,
            'username': log.username,
            'ip_address': log.ip_address,
            'user_agent': log.user_agent,
            'login_time': log.login_time.isoformat() if log.login_time else None,
            'success': log.success
        } for log in logs],
        'count': len(logs)
    })


def main():
    global VIDEO_DIR, CONFIG

    # Load configuration first
    CONFIG = load_config()

    # Setup logging with configuration
    setup_logging()

    # Initialize authentication (conditionally)
    init_auth(app)

    # Parse command line arguments (override config)
    video_path = CONFIG['server'].get('video_dir', '.')
    port = CONFIG['server'].get('port', 8000)

    if len(sys.argv) > 1:
        video_path = sys.argv[1]
    if len(sys.argv) > 2:
        port = int(sys.argv[2])

    VIDEO_DIR = Path(video_path).resolve()

    if not VIDEO_DIR.exists():
        logger.error(f"Directory does not exist: {VIDEO_DIR}")
        sys.exit(1)

    # Ensure directories exist
    THUMBNAIL_DIR.mkdir(exist_ok=True)
    LOG_DIR.mkdir(exist_ok=True)

    logger.info(f"Video directory: {VIDEO_DIR}")
    logger.info(f"Server running at: http://localhost:{port}")
    logger.info(f"Press Ctrl+C to stop")

    # Scan videos on startup
    data = refresh_video_cache(reason='startup')
    start_periodic_video_scan()
    print(f"\nFound {data['count']} video(s) in {len(data['categories'])} categorie(s)")
    if data['duplicate_count'] > 0:
        print(f"Skipped {data['duplicate_count']} duplicate(s)")
    print()

    try:
        app.run(
            host=CONFIG['server'].get('host', '0.0.0.0'),
            port=port,
            debug=False,
            threaded=True
        )
    except KeyboardInterrupt:
        logger.info("Server stopped by user")
    except Exception as e:
        logger.error(f"Server error: {e}")


if __name__ == '__main__':
    main()
