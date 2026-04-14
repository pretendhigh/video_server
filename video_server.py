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
import logging
import logging.handlers
from pathlib import Path
from urllib.parse import quote, unquote
from collections import defaultdict, deque
from datetime import datetime

from flask import Flask, render_template, jsonify, send_file, request, Response

app = Flask(__name__)

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
    "ui": {
        "controls_hide_delay": 3000  # milliseconds
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

# Global logger
logger = logging.getLogger('video_server')


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


def get_file_hash(file_path: Path) -> str:
    """Generate a hash based on file content (size + mtime) for deduplication."""
    stat = file_path.stat()
    content = f"{stat.st_size}:{stat.st_mtime}"
    return hashlib.md5(content.encode()).hexdigest()


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
    seen_names = {}  # name -> file_hash for deduplication
    duplicate_count = 0

    logger.info(f"Scanning directory: {directory}")

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
                file_hash = get_file_hash(file_path)

                # Check for duplicate (same name, same content)
                if name in seen_names:
                    if seen_names[name] == file_hash:
                        logger.warning(f"Duplicate video skipped: {rel_path} (same as existing)")
                        duplicate_count += 1
                        continue
                    else:
                        logger.warning(f"Same name but different content: {rel_path}")

                seen_names[name] = file_hash

                # Get category
                category = get_category(rel_path)

                # Generate or get thumbnail (returns both thumbnail path and duration)
                thumbnail, duration = generate_thumbnail(file_path)

                # Get file size
                size = file_path.stat().st_size

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
    videos.sort(key=lambda x: x['name'].lower())

    # Sort categories
    sorted_categories = dict(sorted(categories.items()))
    for cat in sorted_categories:
        sorted_categories[cat].sort(key=lambda x: x['name'].lower())

    logger.info(f"Scan complete: {len(videos)} videos found, {duplicate_count} duplicates skipped")
    logger.info(f"Categories: {list(sorted_categories.keys())}")

    return {
        'videos': videos,
        'categories': sorted_categories,
        'count': len(videos),
        'duplicate_count': duplicate_count
    }


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


@app.route('/')
def index():
    """Render the main gallery page."""
    return render_template('index.html')


@app.route('/api/config')
def api_config():
    """Get frontend configuration (playback speeds, UI settings, etc)."""
    return jsonify({
        'playback': CONFIG.get('playback', DEFAULT_CONFIG['playback']),
        'ui': CONFIG.get('ui', DEFAULT_CONFIG['ui'])
    })


@app.route('/api/videos')
def api_videos():
    """API endpoint to get list of videos."""
    data = scan_videos(VIDEO_DIR)
    return jsonify(data)


@app.route('/api/search')
def api_search():
    """Search videos by keyword (fuzzy search)."""
    keyword = request.args.get('q', '').lower().strip()
    category = request.args.get('category', '').strip()

    if not keyword:
        return jsonify({'videos': [], 'count': 0})

    logger.info(f"Search request: '{keyword}', category: '{category}'")

    data = scan_videos(VIDEO_DIR)
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
    results.sort(key=lambda x: (-x['_score'], x['name'].lower()))

    # Remove score from output
    for r in results:
        del r['_score']

    logger.info(f"Search '{keyword}' returned {len(results)} results")

    return jsonify({
        'videos': results,
        'count': len(results),
        'keyword': keyword
    })


@app.route('/api/categories')
def api_categories():
    """Get videos grouped by category."""
    data = scan_videos(VIDEO_DIR)
    return jsonify({
        'categories': data['categories'],
        'count': data['count']
    })


@app.route('/video/<path:filename>')
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
def refresh_thumbnails():
    """Force regeneration of all thumbnails."""
    logger.info("Refreshing all thumbnails...")

    # Clear existing thumbnails
    count = 0
    for thumb in THUMBNAIL_DIR.glob('*.jpg'):
        thumb.unlink()
        count += 1

    logger.info(f"Cleared {count} thumbnails")

    # Regenerate
    data = scan_videos(VIDEO_DIR)
    return jsonify({
        'message': f'Refreshed {data["count"]} thumbnails',
        'count': data['count']
    })


@app.route('/api/logs')
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


def main():
    global VIDEO_DIR, CONFIG

    # Load configuration first
    CONFIG = load_config()

    # Setup logging with configuration
    setup_logging()

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
    data = scan_videos(VIDEO_DIR)
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
