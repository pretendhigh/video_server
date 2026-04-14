// Video Server Frontend
(function() {
    // State
    let allVideos = [];
    let categories = {};
    let currentCategory = 'all';
    let currentSearch = '';
    let currentVideo = null;
    let currentSpeed = 1;
    let isDragging = false;
    let lastSearchCategoryCounts = {};  // Cache for search category counts

    // DOM Elements
    const videoGrid = document.getElementById('video-grid');
    const loadingEl = document.getElementById('loading');
    const emptyStateEl = document.getElementById('empty-state');
    const noSearchResultsEl = document.getElementById('no-search-results');
    const videoCountEl = document.getElementById('video-count');
    const refreshBtn = document.getElementById('refresh-btn');
    const playerModal = document.getElementById('player-modal');
    const playerVideoArea = document.getElementById('player-video-area');
    const customVideoPlayer = document.getElementById('custom-video-player');
    const videoPlayer = document.getElementById('video-player');
    const centerPlayOverlay = document.getElementById('center-play-overlay');
    const playerTitle = document.getElementById('player-title');
    const closePlayerBtn = document.getElementById('close-player');
    const categoryTabs = document.getElementById('category-tabs');
    const searchInput = document.getElementById('search-input');
    const searchBtn = document.getElementById('search-btn');
    const clearSearchBtn = document.getElementById('clear-search');

    // Video Controls
    const bigPlayBtn = document.getElementById('big-play-btn');
    const ctrlPlayPause = document.getElementById('ctrl-play-pause');
    const ctrlRewind = document.getElementById('ctrl-rewind');
    const ctrlForward = document.getElementById('ctrl-forward');
    const ctrlFullscreen = document.getElementById('ctrl-fullscreen');
    const ctrlPip = document.getElementById('ctrl-pip');
    const ctrlDownload = document.getElementById('ctrl-download');
    const timeDisplay = document.getElementById('time-display');
    const progressContainer = document.getElementById('progress-container');
    const progressBar = document.getElementById('progress-bar');
    const progressHandle = document.getElementById('progress-handle');
    const playerControlsBar = document.getElementById('player-controls-bar');

    // Speed Selector Elements
    const speedMenuBtn = document.getElementById('speed-menu-btn');
    const speedPopup = document.getElementById('speed-popup');
    const speedOptions = document.getElementById('speed-options');

    // Logs Modal Elements
    const logsBtn = document.getElementById('logs-btn');
    const logsModal = document.getElementById('logs-modal');
    const closeLogsBtn = document.getElementById('close-logs');
    const refreshLogsBtn = document.getElementById('refresh-logs');
    const logsContent = document.getElementById('logs-content');

    // Configuration
    let playbackSpeeds = [0.5, 1, 1.25, 1.5, 2, 3, 5];
    let controlsHideDelay = 3000;  // milliseconds
    let skipDuration = 10;  // seconds for fast forward/rewind
    let mouseHideTimer = null;

    // Initialize
    async function init() {
        await loadConfig();
        await loadVideos();
        setupEventListeners();
    }

    // Load configuration from server
    async function loadConfig() {
        try {
            const response = await fetch('/api/config');
            const data = await response.json();
            if (data.playback && data.playback.speeds) {
                playbackSpeeds = data.playback.speeds;
            }
            if (data.ui && data.ui.controls_hide_delay) {
                controlsHideDelay = data.ui.controls_hide_delay;
            }
            if (data.playback && data.playback.skip_duration) {
                skipDuration = data.playback.skip_duration;
            }
            renderSpeedPopup();
        } catch (error) {
            console.error('Failed to load config:', error);
            renderSpeedPopup();
        }
    }

    // Render speed popup options
    function renderSpeedPopup() {
        speedOptions.innerHTML = playbackSpeeds.map(speed => `
            <div class="speed-option ${speed === 1 ? 'active' : ''}" data-speed="${speed}">
                <span>${speed === 1 ? '1.0' : speed}x</span>
                <span class="check">✓</span>
            </div>
        `).join('');

        speedOptions.querySelectorAll('.speed-option').forEach(option => {
            option.addEventListener('click', () => {
                const speed = parseFloat(option.dataset.speed);
                setPlaybackSpeed(speed);
                closeSpeedPopup();
            });
        });
    }

    // Open speed popup
    function openSpeedPopup() {
        speedPopup.classList.remove('hidden');
        speedMenuBtn.classList.add('active');
    }

    // Close speed popup
    function closeSpeedPopup() {
        speedPopup.classList.add('hidden');
        speedMenuBtn.classList.remove('active');
    }

    // Toggle speed popup
    function toggleSpeedPopup() {
        if (speedPopup.classList.contains('hidden')) {
            openSpeedPopup();
        } else {
            closeSpeedPopup();
        }
    }

    // Load videos from API
    async function loadVideos() {
        try {
            showLoading();

            const response = await fetch('/api/videos');
            const data = await response.json();

            allVideos = data.videos || [];
            categories = data.categories || {};

            updateVideoCount(data.count || 0, data.duplicate_count || 0);
            renderCategoryTabs(null, data.count || 0);

            if (allVideos.length === 0) {
                showEmptyState();
            } else {
                filterAndRenderVideos();
            }
        } catch (error) {
            console.error('Failed to load videos:', error);
            showError('Failed to load videos. Please try again.');
        }
    }

    // Search videos
    async function searchVideos(keyword) {
        if (!keyword.trim()) {
            currentSearch = '';
            lastSearchCategoryCounts = {};
            renderCategoryTabs();
            filterAndRenderVideos();
            return;
        }

        try {
            showLoading();
            currentSearch = keyword;

            // Always fetch all categories first to get correct counts
            const allResultsResponse = await fetch(`/api/search?q=${encodeURIComponent(keyword)}`);
            const allData = await allResultsResponse.json();
            const allSearchResults = allData.videos || [];

            // Calculate counts for all categories
            lastSearchCategoryCounts = {};
            allSearchResults.forEach(video => {
                const cat = video.category || 'Uncategorized';
                lastSearchCategoryCounts[cat] = (lastSearchCategoryCounts[cat] || 0) + 1;
            });

            // Filter results by current category if needed
            let displayResults = allSearchResults;
            if (currentCategory && currentCategory !== 'all') {
                displayResults = allSearchResults.filter(v => v.category === currentCategory);
            }

            renderCategoryTabs(lastSearchCategoryCounts, allSearchResults.length);

            if (displayResults.length === 0) {
                showNoSearchResults();
            } else {
                renderVideoGrid(displayResults);
                videoCountEl.textContent = `${displayResults.length} result${displayResults.length !== 1 ? 's' : ''}`;
            }

            clearSearchBtn.classList.remove('hidden');
        } catch (error) {
            console.error('Search failed:', error);
            showError('Search failed. Please try again.');
        }
    }

    // Filter and render videos
    function filterAndRenderVideos() {
        let videos = allVideos;

        if (currentCategory !== 'all') {
            videos = videos.filter(v => v.category === currentCategory);
        }

        if (currentSearch) {
            const keyword = currentSearch.toLowerCase();
            videos = videos.filter(v =>
                v.name.toLowerCase().includes(keyword) ||
                v.category.toLowerCase().includes(keyword)
            );
        }

        if (videos.length === 0) {
            if (currentSearch) {
                showNoSearchResults();
            } else {
                showEmptyState();
            }
        } else {
            if (currentCategory === 'all' && !currentSearch) {
                renderVideosByCategory();
            } else {
                renderVideoGrid(videos);
            }
        }
    }

    // Render category tabs
    function renderCategoryTabs(categoryCounts = null, totalCount = null) {
        const categoryNames = Object.keys(categories).sort();
        const isSearchMode = categoryCounts !== null;

        const getCount = (cat) => {
            if (isSearchMode) {
                return categoryCounts[cat] || 0;
            }
            return categories[cat].length;
        };

        const getTotal = () => {
            if (isSearchMode) {
                return totalCount;
            }
            return Object.values(categories).reduce((sum, videos) => sum + videos.length, 0);
        };

        const allCount = getTotal();
        const allActive = currentCategory === 'all' ? 'active' : '';

        let html = `<button class="tab-btn ${allActive}" data-category="all">All (${allCount})</button>`;

        categoryNames.forEach(cat => {
            const count = getCount(cat);
            const activeClass = currentCategory === cat ? 'active' : '';
            html += `<button class="tab-btn ${activeClass}" data-category="${escapeHtml(cat)}">${escapeHtml(cat)} (${count})</button>`;
        });

        categoryTabs.innerHTML = html;
    }

    // Handle category tab clicks via event delegation
    categoryTabs.addEventListener('click', (e) => {
        const btn = e.target.closest('.tab-btn');
        if (!btn) return;

        categoryTabs.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentCategory = btn.dataset.category;

        // If in search mode, re-run search with category filter
        if (currentSearch) {
            searchVideos(currentSearch);
        } else {
            filterAndRenderVideos();
        }
    });

    // Render videos grouped by category
    function renderVideosByCategory() {
        loadingEl.classList.add('hidden');
        emptyStateEl.classList.add('hidden');
        noSearchResultsEl.classList.add('hidden');
        videoGrid.classList.remove('hidden');

        let html = '';
        const sortedCategories = Object.keys(categories).sort();

        sortedCategories.forEach(category => {
            const videos = categories[category];
            if (videos.length === 0) return;

            html += `
                <div class="category-section">
                    <h2 class="category-title">${escapeHtml(category)}</h2>
                    <div class="video-grid">
                        ${videos.map(video => renderVideoCard(video)).join('')}
                    </div>
                </div>
            `;
        });

        videoGrid.innerHTML = html;
        attachVideoCardHandlers();
    }

    // Render video card HTML
    function renderVideoCard(video) {
        return `
            <div class="video-card" data-path="${escapeHtml(video.url_path)}" data-name="${escapeHtml(video.name)}" data-id="${escapeHtml(video.id)}">
                <div class="video-thumbnail">
                    ${video.thumbnail
                        ? `<img src="${video.thumbnail}" alt="${escapeHtml(video.name)}" loading="lazy">`
                        : `<div style="width:100%;height:100%;background:linear-gradient(135deg,#333,#222);display:flex;align-items:center;justify-content:center;color:#666;font-size:14px;">No Preview</div>`
                    }
                    <div class="play-icon"></div>
                    ${video.category && video.category !== 'Uncategorized'
                        ? `<span class="video-category">${escapeHtml(video.category)}</span>`
                        : ''
                    }
                    ${video.duration_formatted
                        ? `<span class="video-duration">${escapeHtml(video.duration_formatted)}</span>`
                        : ''
                    }
                </div>
                <div class="video-info">
                    <div class="video-title">${escapeHtml(video.name)}</div>
                    <div class="video-meta">
                        <span>${video.ext.toUpperCase()}</span>
                        <span>${video.size_formatted}</span>
                    </div>
                </div>
            </div>
        `;
    }

    // Render video grid
    function renderVideoGrid(videos) {
        loadingEl.classList.add('hidden');
        emptyStateEl.classList.add('hidden');
        noSearchResultsEl.classList.add('hidden');
        videoGrid.classList.remove('hidden');

        videoGrid.innerHTML = videos.map(video => renderVideoCard(video)).join('');

        attachVideoCardHandlers();
    }

    // Attach click handlers to video cards
    function attachVideoCardHandlers() {
        document.querySelectorAll('.video-card').forEach(card => {
            card.addEventListener('click', () => {
                const path = card.dataset.path;
                const name = card.dataset.name;
                openPlayer(path, name);
            });
        });
    }

    // Escape HTML to prevent XSS
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // Show loading state
    function showLoading() {
        loadingEl.classList.remove('hidden');
        videoGrid.classList.add('hidden');
        emptyStateEl.classList.add('hidden');
        noSearchResultsEl.classList.add('hidden');
    }

    // Show empty state
    function showEmptyState() {
        loadingEl.classList.add('hidden');
        videoGrid.classList.add('hidden');
        emptyStateEl.classList.remove('hidden');
        noSearchResultsEl.classList.add('hidden');
    }

    // Show no search results
    function showNoSearchResults() {
        loadingEl.classList.add('hidden');
        videoGrid.classList.add('hidden');
        emptyStateEl.classList.add('hidden');
        noSearchResultsEl.classList.remove('hidden');
    }

    // Show error
    function showError(message) {
        loadingEl.classList.add('hidden');
        videoGrid.innerHTML = `<div class="empty-state"><p>${message}</p></div>`;
        videoGrid.classList.remove('hidden');
        emptyStateEl.classList.add('hidden');
        noSearchResultsEl.classList.add('hidden');
    }

    // Update video count
    function updateVideoCount(count, duplicateCount) {
        let text = `${count} video${count !== 1 ? 's' : ''}`;
        if (duplicateCount > 0) {
            text += ` (${duplicateCount} duplicate${duplicateCount !== 1 ? 's' : ''} hidden)`;
        }
        videoCountEl.textContent = text;
    }

    // Format time (seconds to MM:SS)
    function formatTime(seconds) {
        if (isNaN(seconds)) return '0:00';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    // Update progress bar
    function updateProgress() {
        if (!videoPlayer.duration) return;
        const percent = (videoPlayer.currentTime / videoPlayer.duration) * 100;
        progressBar.style.width = percent + '%';
        progressHandle.style.left = percent + '%';
        timeDisplay.textContent = `${formatTime(videoPlayer.currentTime)} / ${formatTime(videoPlayer.duration)}`;
    }

    // Seek video
    function seekVideo(e) {
        const rect = progressContainer.getBoundingClientRect();
        const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        videoPlayer.currentTime = percent * videoPlayer.duration;
        updateProgress();
    }

    // Update play/pause button state
    function updatePlayPauseButton() {
        const playIcons = document.querySelectorAll('.icon-play');
        const pauseIcons = document.querySelectorAll('.icon-pause');

        if (videoPlayer.paused) {
            playIcons.forEach(icon => icon.classList.remove('hidden'));
            pauseIcons.forEach(icon => icon.classList.add('hidden'));
            centerPlayOverlay.classList.remove('hidden');
        } else {
            playIcons.forEach(icon => icon.classList.add('hidden'));
            pauseIcons.forEach(icon => icon.classList.remove('hidden'));
            centerPlayOverlay.classList.add('hidden');
        }
    }

    // Toggle play/pause
    function togglePlayPause() {
        if (videoPlayer.paused) {
            videoPlayer.play();
        } else {
            videoPlayer.pause();
        }
    }

    // Open video player
    function openPlayer(videoPath, videoName) {
        currentVideo = { path: videoPath, name: videoName };

        playerTitle.textContent = videoName;
        videoPlayer.src = `/video/${videoPath}`;
        videoPlayer.load();

        playerModal.classList.remove('hidden');
        document.body.style.overflow = 'hidden';

        videoPlayer.play().then(() => {
            updatePlayPauseButton();
        }).catch(() => {
            updatePlayPauseButton();
        });

        setPlaybackSpeed(1);
        updateProgress();
    }

    // Close video player
    function closePlayer() {
        videoPlayer.pause();
        videoPlayer.removeAttribute('src');
        playerModal.classList.add('hidden');
        document.body.style.overflow = '';
        currentVideo = null;
        closeSpeedPopup();
        showControls(); // Reset controls visibility for next time
    }

    // Set playback speed
    function setPlaybackSpeed(speed) {
        videoPlayer.playbackRate = speed;
        currentSpeed = speed;
        speedMenuBtn.textContent = `${speed === 1 ? '1.0' : speed}x`;

        speedOptions.querySelectorAll('.speed-option').forEach(option => {
            const optionSpeed = parseFloat(option.dataset.speed);
            if (optionSpeed === speed) {
                option.classList.add('active');
            } else {
                option.classList.remove('active');
            }
        });
    }

    // Toggle fullscreen
    async function toggleFullscreen() {
        try {
            if (!document.fullscreenElement) {
                // Request fullscreen on playerVideoArea (includes video + controls)
                if (playerVideoArea.requestFullscreen) {
                    await playerVideoArea.requestFullscreen();
                } else if (playerVideoArea.webkitRequestFullscreen) {
                    await playerVideoArea.webkitRequestFullscreen();
                } else if (playerVideoArea.msRequestFullscreen) {
                    await playerVideoArea.msRequestFullscreen();
                }
            } else {
                if (document.exitFullscreen) {
                    await document.exitFullscreen();
                } else if (document.webkitExitFullscreen) {
                    await document.webkitExitFullscreen();
                } else if (document.msExitFullscreen) {
                    await document.msExitFullscreen();
                }
            }
        } catch (err) {
            console.error('Fullscreen error:', err);
        }
    }

    // Show controls bar (in fullscreen mode)
    function showControls() {
        if (playerControlsBar) {
            playerControlsBar.classList.remove('controls-hidden');
        }
        // Clear any existing timer
        if (mouseHideTimer) {
            clearTimeout(mouseHideTimer);
            mouseHideTimer = null;
        }
    }

    // Hide controls bar after delay (in fullscreen mode)
    function hideControls(delay = 0) {
        if (mouseHideTimer) {
            clearTimeout(mouseHideTimer);
        }
        mouseHideTimer = setTimeout(() => {
            if (document.fullscreenElement && playerControlsBar) {
                playerControlsBar.classList.add('controls-hidden');
            }
        }, delay);
    }

    // Handle mouse movement in fullscreen mode
    function handleFullscreenMouseMove() {
        if (!document.fullscreenElement) return;
        showControls();
        // Auto-hide after delay
        hideControls(controlsHideDelay);
    }

    // Setup fullscreen controls auto-hide behavior
    function setupFullscreenControls() {
        // Mouse movement on video player area shows controls
        playerVideoArea.addEventListener('mousemove', handleFullscreenMouseMove);

        // Mouse entering controls area keeps them visible
        if (playerControlsBar) {
            playerControlsBar.addEventListener('mouseenter', () => {
                if (document.fullscreenElement) {
                    showControls();
                }
            });

            // Mouse leaving controls area starts hide timer
            playerControlsBar.addEventListener('mouseleave', () => {
                if (document.fullscreenElement) {
                    hideControls(controlsHideDelay);
                }
            });
        }

        // Click on video area shows controls briefly
        videoPlayer.addEventListener('click', () => {
            if (document.fullscreenElement) {
                showControls();
                hideControls(controlsHideDelay);
            }
        });
    }

    // Update fullscreen button and controls visibility
    function updateFullscreenButton() {
        const fullscreenIcon = ctrlFullscreen.querySelector('.icon-fullscreen');
        const exitFullscreenIcon = ctrlFullscreen.querySelector('.icon-exit-fullscreen');

        if (document.fullscreenElement) {
            fullscreenIcon.classList.add('hidden');
            exitFullscreenIcon.classList.remove('hidden');
            // In fullscreen: hide controls initially, then show on mouse move
            hideControls(controlsHideDelay);
        } else {
            fullscreenIcon.classList.remove('hidden');
            exitFullscreenIcon.classList.add('hidden');
            // Exit fullscreen: always show controls
            showControls();
        }
    }

    // Toggle Picture-in-Picture
    async function togglePip() {
        try {
            if (document.pictureInPictureElement) {
                await document.exitPictureInPicture();
            } else if (videoPlayer !== document.pictureInPictureElement) {
                await videoPlayer.requestPictureInPicture();
            }
        } catch (error) {
            console.error('PIP error:', error);
            alert('您的浏览器不支持画中画功能');
        }
    }

    // Download video
    function downloadVideo() {
        if (currentVideo) {
            const a = document.createElement('a');
            a.href = videoPlayer.src;
            a.download = currentVideo.name + '.mp4';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        }
    }

    // Load and display logs
    async function loadLogs() {
        try {
            logsContent.textContent = 'Loading logs...';
            const response = await fetch('/api/logs');
            const data = await response.json();

            if (data.logs && data.logs.length > 0) {
                const formatted = data.logs.map(line => {
                    if (line.includes('[ERROR]')) {
                        return `<span class="log-error">${escapeHtml(line)}</span>`;
                    } else if (line.includes('[WARNING]')) {
                        return `<span class="log-warning">${escapeHtml(line)}</span>`;
                    } else if (line.includes('[INFO]')) {
                        return `<span class="log-info">${escapeHtml(line)}</span>`;
                    }
                    return escapeHtml(line);
                }).join('\n');

                logsContent.innerHTML = formatted;
            } else {
                logsContent.textContent = 'No logs available.';
            }
        } catch (error) {
            console.error('Failed to load logs:', error);
            logsContent.textContent = 'Failed to load logs.';
        }
    }

    // Open logs modal
    function openLogs() {
        logsModal.classList.remove('hidden');
        loadLogs();
    }

    // Close logs modal
    function closeLogs() {
        logsModal.classList.add('hidden');
    }

    // Setup event listeners
    function setupEventListeners() {
        // Refresh button
        refreshBtn.addEventListener('click', () => {
            refreshBtn.disabled = true;
            refreshBtn.textContent = 'Refreshing...';

            fetch('/api/refresh', { method: 'POST' })
                .then(() => loadVideos())
                .finally(() => {
                    refreshBtn.disabled = false;
                    refreshBtn.textContent = 'Refresh';
                });
        });

        // Search
        searchBtn.addEventListener('click', () => {
            searchVideos(searchInput.value);
        });

        searchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                searchVideos(searchInput.value);
            }
        });

        // Clear search
        clearSearchBtn.addEventListener('click', () => {
            searchInput.value = '';
            currentSearch = '';
            clearSearchBtn.classList.add('hidden');
            renderCategoryTabs();
            filterAndRenderVideos();
        });

        // Real-time search (debounced)
        let searchTimeout;
        searchInput.addEventListener('input', (e) => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => {
                if (e.target.value.trim()) {
                    searchVideos(e.target.value);
                } else {
                    clearSearchBtn.classList.add('hidden');
                    currentSearch = '';
                    renderCategoryTabs();
                    filterAndRenderVideos();
                }
            }, 300);
        });

        // Close player
        closePlayerBtn.addEventListener('click', closePlayer);

        // Close on overlay click
        document.querySelector('#player-modal .modal-overlay').addEventListener('click', (e) => {
            if (e.target === document.querySelector('#player-modal .modal-overlay')) {
                closePlayer();
            }
        });

        // Speed menu button
        speedMenuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleSpeedPopup();
        });

        // Close popup when clicking outside
        document.addEventListener('click', (e) => {
            if (!speedPopup.classList.contains('hidden') && !speedPopup.contains(e.target) && e.target !== speedMenuBtn) {
                closeSpeedPopup();
            }
        });

        // Center play overlay (click to toggle play/pause)
        centerPlayOverlay.addEventListener('click', togglePlayPause);

        // Play/Pause button
        ctrlPlayPause.addEventListener('click', togglePlayPause);

        // Rewind button
        if (ctrlRewind) {
            ctrlRewind.addEventListener('click', () => {
                videoPlayer.currentTime = Math.max(0, videoPlayer.currentTime - skipDuration);
            });
        }

        // Forward button
        if (ctrlForward) {
            ctrlForward.addEventListener('click', () => {
                videoPlayer.currentTime = Math.min(videoPlayer.duration || 0, videoPlayer.currentTime + skipDuration);
            });
        }

        // Fullscreen button
        ctrlFullscreen.addEventListener('click', toggleFullscreen);

        // PIP button
        ctrlPip.addEventListener('click', togglePip);

        // Download button
        ctrlDownload.addEventListener('click', downloadVideo);

        // Video events
        videoPlayer.addEventListener('play', updatePlayPauseButton);
        videoPlayer.addEventListener('pause', updatePlayPauseButton);
        videoPlayer.addEventListener('timeupdate', updateProgress);
        videoPlayer.addEventListener('loadedmetadata', updateProgress);
        videoPlayer.addEventListener('click', togglePlayPause);

        // Progress bar events
        progressContainer.addEventListener('click', seekVideo);

        progressContainer.addEventListener('mousedown', (e) => {
            isDragging = true;
            seekVideo(e);
        });

        document.addEventListener('mousemove', (e) => {
            if (isDragging) {
                e.preventDefault();
                seekVideo(e);
            }
        });

        document.addEventListener('mouseup', () => {
            isDragging = false;
        });

        // Fullscreen change event
        document.addEventListener('fullscreenchange', updateFullscreenButton);
        document.addEventListener('webkitfullscreenchange', updateFullscreenButton);
        document.addEventListener('mozfullscreenchange', updateFullscreenButton);
        document.addEventListener('MSFullscreenChange', updateFullscreenButton);

        // Logs modal
        logsBtn.addEventListener('click', openLogs);
        closeLogsBtn.addEventListener('click', closeLogs);
        document.querySelector('#logs-modal .modal-overlay').addEventListener('click', closeLogs);
        refreshLogsBtn.addEventListener('click', loadLogs);

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (playerModal.classList.contains('hidden')) return;
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

            switch (e.key) {
                case ' ':
                case 'k':
                case 'K':
                    e.preventDefault();
                    togglePlayPause();
                    break;

                case 'ArrowLeft':
                    e.preventDefault();
                    videoPlayer.currentTime = Math.max(0, videoPlayer.currentTime - 10);
                    break;

                case 'ArrowRight':
                    e.preventDefault();
                    videoPlayer.currentTime = Math.min(videoPlayer.duration, videoPlayer.currentTime + 10);
                    break;

                case 'f':
                case 'F':
                    e.preventDefault();
                    toggleFullscreen();
                    break;

                case 'Escape':
                    if (document.fullscreenElement) {
                        document.exitFullscreen();
                    } else if (!speedPopup.classList.contains('hidden')) {
                        closeSpeedPopup();
                    } else {
                        closePlayer();
                    }
                    break;

                case '0':
                case '1':
                    e.preventDefault();
                    setPlaybackSpeed(1);
                    break;

                case '2':
                    e.preventDefault();
                    setPlaybackSpeed(2);
                    break;

                case '3':
                    e.preventDefault();
                    setPlaybackSpeed(3);
                    break;

                case '5':
                    e.preventDefault();
                    setPlaybackSpeed(5);
                    break;

                case 'ArrowUp':
                    e.preventDefault();
                    videoPlayer.volume = Math.min(1, videoPlayer.volume + 0.1);
                    break;

                case 'ArrowDown':
                    e.preventDefault();
                    videoPlayer.volume = Math.max(0, videoPlayer.volume - 0.1);
                    break;
            }
        });

        // Handle video errors
        videoPlayer.addEventListener('error', () => {
            console.error('Video playback error');
        });

        // Setup fullscreen controls auto-hide
        setupFullscreenControls();
    }

    // Start
    init();
})();
