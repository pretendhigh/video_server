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
    let lastSearchResults = [];
    let lastSearchTotalCount = 0;
    let totalVideoCount = 0;
    let totalDuplicateCount = 0;

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
    const categoryTabsPrevBtn = document.getElementById('category-tabs-prev');
    const categoryTabsNextBtn = document.getElementById('category-tabs-next');
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
    const ctrlFavorite = document.getElementById('ctrl-favorite');
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

    // Auth State
    let authEnabled = false;
    let authMode = 'relaxed';
    let currentUser = null;
    let favoriteIds = new Set();

    // Auth DOM Elements
    const authBar = document.getElementById('auth-bar');
    const loginBtn = document.getElementById('login-btn');
    const logoutBtn = document.getElementById('logout-btn');
    const userMenu = document.getElementById('user-menu');
    const userMenuTrigger = document.getElementById('user-menu-trigger');
    const userMenuDropdown = document.getElementById('user-menu-dropdown');
    const usernameDisplay = document.getElementById('username-display');
    const userRoleDisplay = document.getElementById('user-role-display');
    const avatarInitials = document.getElementById('avatar-initials');
    const userMenuAvatar = document.getElementById('user-menu-avatar');
    const loginModal = document.getElementById('login-modal');
    const closeLoginBtn = document.getElementById('close-login');
    const loginSubmitBtn = document.getElementById('login-submit');
    const loginUsernameInput = document.getElementById('login-username');
    const loginPasswordInput = document.getElementById('login-password');
    const loginError = document.getElementById('login-error');

    // Admin DOM Elements
    const adminBtn = document.getElementById('admin-btn');
    const adminModal = document.getElementById('admin-modal');
    const closeAdminBtn = document.getElementById('close-admin');
    const adminTabs = document.querySelectorAll('.admin-tab-btn');
    const adminUsersTab = document.getElementById('admin-users-tab');
    const adminLoginLogsTab = document.getElementById('admin-login-logs-tab');
    const adminUsersTableBody = document.querySelector('#admin-users-table tbody');
    const adminLogsTableBody = document.querySelector('#admin-logs-table tbody');
    const adminAddUserBtn = document.getElementById('admin-add-user-btn');
    const adminAddUserForm = document.getElementById('admin-add-user-form');
    const adminCreateUserBtn = document.getElementById('admin-create-user-btn');
    const adminCancelUserBtn = document.getElementById('admin-cancel-user-btn');
    const adminNewUsername = document.getElementById('admin-new-username');
    const adminNewPassword = document.getElementById('admin-new-password');
    const adminNewRole = document.getElementById('admin-new-role');
    const adminUserError = document.getElementById('admin-user-error');

    // Initialize
    async function init() {
        await loadConfig();
        await loadAuthState();

        // Check if page requested auto-show login modal
        const pageShowLogin = document.body.dataset.showLogin === 'true';
        if (pageShowLogin && authEnabled && !currentUser) {
            openLoginModal();
        }

        // In strict mode without login, show login prompt instead of loading videos
        if (authEnabled && authMode === 'strict' && !currentUser) {
            showEmptyStateCustom('Please log in to view videos', 'Enter your username and password in the login form above.');
            renderCategoryTabs();
        } else {
            await loadVideos();
        }

        setupEventListeners();
    }

    // Load authentication state from server
    async function loadAuthState() {
        try {
            const response = await fetch('/api/me');
            const data = await response.json();
            authEnabled = data.auth_enabled;
            authMode = data.auth_mode || 'relaxed';
            if (data.is_authenticated && data.user) {
                currentUser = data.user;
                if (authEnabled) {
                    await loadFavorites();
                }
            } else {
                currentUser = null;
                favoriteIds = new Set();
                if (currentCategory === '__favorites__') {
                    currentCategory = 'all';
                }
            }
            closeUserMenuDropdown();
            updateAuthUI();
        } catch (error) {
            console.error('Failed to load auth state:', error);
        }
    }

    // Load favorites from server
    async function loadFavorites() {
        if (!authEnabled || !currentUser) return;
        try {
            const response = await fetch('/api/favorites');
            const data = await response.json();
            favoriteIds = new Set((data.favorites || []).map(f => f.video_id));
        } catch (error) {
            console.error('Failed to load favorites:', error);
        }
    }

    function getRoleLabel(role) {
        if (!role) return 'User';
        return role.charAt(0).toUpperCase() + role.slice(1);
    }

    function asciiCompare(a, b) {
        if (a === b) return 0;
        return a < b ? -1 : 1;
    }

    function sortCategoryNames(categoryNames) {
        const names = [...categoryNames].sort(asciiCompare);
        const priority = ['Uncategorized'];

        const prioritized = priority.filter(name => names.includes(name));
        const remaining = names.filter(name => !priority.includes(name));

        return [...prioritized, ...remaining];
    }

    function getInitials(name) {
        if (!name) return 'VS';
        const parts = name.trim().split(/\s+/).filter(Boolean);
        if (parts.length === 0) return 'VS';
        if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
        return (parts[0][0] + parts[1][0]).toUpperCase();
    }

    function setUserMenuProfile(name, role) {
        const initials = getInitials(name);
        if (usernameDisplay) usernameDisplay.textContent = name;
        if (userRoleDisplay) userRoleDisplay.textContent = role;
        if (avatarInitials) avatarInitials.textContent = initials;
        if (userMenuAvatar) userMenuAvatar.textContent = initials;
    }

    function closeUserMenuDropdown() {
        if (userMenuDropdown) userMenuDropdown.classList.add('hidden');
        if (userMenu) userMenu.classList.remove('open');
        if (userMenuTrigger) userMenuTrigger.setAttribute('aria-expanded', 'false');
    }

    function toggleUserMenuDropdown(event) {
        if (event) event.stopPropagation();
        if (!userMenuDropdown || userMenu.classList.contains('hidden')) return;
        const shouldOpen = userMenuDropdown.classList.contains('hidden');
        if (shouldOpen) {
            userMenuDropdown.classList.remove('hidden');
            userMenu.classList.add('open');
            userMenuTrigger.setAttribute('aria-expanded', 'true');
        } else {
            closeUserMenuDropdown();
        }
    }

    function replaceFavoriteIdsFromVideos(videos) {
        if (!Array.isArray(videos) || videos.length === 0) return;
        const hasFavoriteState = videos.some(video => Object.prototype.hasOwnProperty.call(video, 'is_favorite'));
        if (!hasFavoriteState) return;
        favoriteIds = new Set(videos.filter(video => video.is_favorite).map(video => video.id));
    }

    function findVideoById(videoId) {
        return allVideos.find(video => video.id === videoId)
            || lastSearchResults.find(video => video.id === videoId)
            || null;
    }

    function updateFavoriteButtonState(button, isFav, title) {
        if (!button) return;
        button.classList.toggle('favorited', isFav);
        button.setAttribute('aria-pressed', isFav ? 'true' : 'false');
        button.title = title;
    }

    function updateVideoCollectionsFavoriteState(videoId, isFav) {
        const updateCollection = (videos) => {
            videos.forEach(video => {
                if (video.id === videoId) {
                    video.is_favorite = isFav;
                }
            });
        };
        updateCollection(allVideos);
        Object.values(categories).forEach(updateCollection);
        updateCollection(lastSearchResults);
    }

    function updatePlayerFavoriteButton() {
        if (!ctrlFavorite) return;

        const shouldShow = authEnabled && currentVideo;
        ctrlFavorite.classList.toggle('hidden', !shouldShow);

        if (!shouldShow) {
            ctrlFavorite.classList.remove('favorited');
            ctrlFavorite.disabled = true;
            ctrlFavorite.title = '收藏';
            return;
        }

        ctrlFavorite.disabled = false;
        const isFav = currentUser ? favoriteIds.has(currentVideo.id) : false;
        const title = currentUser
            ? (isFav ? '取消收藏' : '收藏')
            : '登录后收藏';
        updateFavoriteButtonState(ctrlFavorite, isFav, title);
    }

    function setVideoFavoriteState(videoId, isFav) {
        if (isFav) {
            favoriteIds.add(videoId);
        } else {
            favoriteIds.delete(videoId);
        }

        updateVideoCollectionsFavoriteState(videoId, isFav);

        document.querySelectorAll(`.favorite-btn[data-id="${videoId}"]`).forEach(btn => {
            updateFavoriteButtonState(btn, isFav, isFav ? 'Remove from favorites' : 'Add to favorites');
        });

        updatePlayerFavoriteButton();
        renderCategoryTabs();
    }

    function updateCategoryTabsNav() {
        if (!categoryTabs || !categoryTabsPrevBtn || !categoryTabsNextBtn) return;

        const hasOverflow = categoryTabs.scrollWidth - categoryTabs.clientWidth > 8;
        const atStart = categoryTabs.scrollLeft <= 8;
        const atEnd = categoryTabs.scrollLeft + categoryTabs.clientWidth >= categoryTabs.scrollWidth - 8;

        categoryTabsPrevBtn.classList.remove('hidden');
        categoryTabsNextBtn.classList.remove('hidden');
        categoryTabsPrevBtn.disabled = !hasOverflow || atStart;
        categoryTabsNextBtn.disabled = !hasOverflow || atEnd;
        categoryTabsPrevBtn.classList.toggle('is-disabled', categoryTabsPrevBtn.disabled);
        categoryTabsNextBtn.classList.toggle('is-disabled', categoryTabsNextBtn.disabled);

        categoryTabsPrevBtn.title = 'Previous category';
        categoryTabsPrevBtn.setAttribute('aria-label', 'Show previous categories');
        categoryTabsNextBtn.title = 'Next category';
        categoryTabsNextBtn.setAttribute('aria-label', 'Show next categories');
    }

    function getCategoryTabPagePositions() {
        if (!categoryTabs) return [0];

        const maxScrollLeft = Math.max(0, categoryTabs.scrollWidth - categoryTabs.clientWidth);
        const pageStep = Math.max(1, categoryTabs.clientWidth);

        if (maxScrollLeft <= 0) {
            return [0];
        }

        const positions = [0];
        for (let left = pageStep; left < maxScrollLeft; left += pageStep) {
            positions.push(left);
        }
        if (positions[positions.length - 1] !== maxScrollLeft) {
            positions.push(maxScrollLeft);
        }

        return positions;
    }

    function scrollCategoryTabs(direction) {
        if (!categoryTabs) return;

        const positions = getCategoryTabPagePositions();
        const currentLeft = categoryTabs.scrollLeft;
        let targetLeft = currentLeft;

        if (direction === 'next') {
            const nextLeft = positions.find(pos => pos > currentLeft + 1);
            if (nextLeft !== undefined) {
                targetLeft = nextLeft;
            }
        } else {
            const prevPositions = positions.filter(pos => pos < currentLeft - 1);
            if (prevPositions.length > 0) {
                targetLeft = prevPositions[prevPositions.length - 1];
            } else {
                targetLeft = 0;
            }
        }

        categoryTabs.scrollTo({
            left: targetLeft,
            behavior: 'smooth'
        });
    }

    function scrollToNextCategory() {
        scrollCategoryTabs('next');
    }

    function scrollToPreviousCategory() {
        scrollCategoryTabs('prev');
    }

    // Update UI based on auth state
    function updateAuthUI() {
        if (!authEnabled) {
            if (authBar) authBar.classList.remove('hidden');
            if (loginBtn) loginBtn.classList.add('hidden');
            if (userMenu) userMenu.classList.remove('hidden');
            if (logoutBtn) logoutBtn.classList.add('hidden');
            setUserMenuProfile('Guest Access', 'Authentication Disabled');
            if (logsBtn) logsBtn.classList.remove('hidden');
            if (adminBtn) adminBtn.classList.add('hidden');
            if (refreshBtn) refreshBtn.classList.add('hidden');
            updatePlayerFavoriteButton();
            return;
        }

        if (authBar) authBar.classList.remove('hidden');

        if (currentUser) {
            if (loginBtn) loginBtn.classList.add('hidden');
            if (userMenu) userMenu.classList.remove('hidden');
            if (logoutBtn) logoutBtn.classList.remove('hidden');
            setUserMenuProfile(currentUser.username, getRoleLabel(currentUser.role));
            const isAdmin = currentUser.role === 'admin';
            if (logsBtn) logsBtn.classList.toggle('hidden', !isAdmin);
            if (refreshBtn) refreshBtn.classList.toggle('hidden', !isAdmin);
            if (adminBtn) adminBtn.classList.toggle('hidden', !isAdmin);
        } else {
            if (loginBtn) loginBtn.classList.remove('hidden');
            if (userMenu) userMenu.classList.add('hidden');
            if (logsBtn) logsBtn.classList.add('hidden');
            if (refreshBtn) refreshBtn.classList.add('hidden');
            if (adminBtn) adminBtn.classList.add('hidden');
            if (logoutBtn) logoutBtn.classList.add('hidden');
            closeUserMenuDropdown();
        }

        updatePlayerFavoriteButton();
    }

    // Toggle favorite for a video
    async function toggleFavorite(videoId, event) {
        if (event) event.stopPropagation();
        if (!authEnabled || !currentUser) {
            if (authEnabled) {
                openLoginModal();
            }
            return;
        }
        const isFav = favoriteIds.has(videoId);
        const method = isFav ? 'DELETE' : 'POST';
        try {
            const response = await fetch(`/api/favorites/${encodeURIComponent(videoId)}`, { method });
            if (response.status === 401) {
                openLoginModal();
                return;
            }
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.error || 'Failed to update favorite');
            }
            if (data.success) {
                setVideoFavoriteState(videoId, !isFav);
                if (currentCategory === '__favorites__') {
                    filterAndRenderVideos();
                }
            }
        } catch (error) {
            console.error('Failed to toggle favorite:', error);
        }
    }

    // Open login modal
    function openLoginModal() {
        if (loginModal) {
            loginModal.classList.remove('hidden');
            loginUsernameInput.focus();
        }
    }

    // Close login modal
    function closeLoginModal() {
        if (loginModal) {
            loginModal.classList.add('hidden');
            loginError.classList.add('hidden');
            loginUsernameInput.value = '';
            loginPasswordInput.value = '';
        }
    }

    // Handle login submission
    async function handleLogin() {
        const username = loginUsernameInput.value.trim();
        const password = loginPasswordInput.value;
        if (!username || !password) {
            loginError.textContent = 'Please enter username and password';
            loginError.classList.remove('hidden');
            return;
        }
        try {
            const formData = new URLSearchParams();
            formData.append('username', username);
            formData.append('password', password);
            const response = await fetch('/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: formData
            });
            if (response.ok) {
                window.location.href = '/';
                return;
            } else {
                loginError.textContent = 'Invalid username or password';
                loginError.classList.remove('hidden');
            }
        } catch (error) {
            console.error('Login failed:', error);
            loginError.textContent = 'Login failed. Please try again.';
            loginError.classList.remove('hidden');
        }
    }

    // Handle logout
    async function handleLogout() {
        try {
            await fetch('/logout', { method: 'POST' });
            if (authEnabled && authMode === 'strict') {
                window.location.href = '/login';
                return;
            }
            currentUser = null;
            currentCategory = 'all';
            currentSearch = '';
            lastSearchResults = [];
            lastSearchCategoryCounts = {};
            lastSearchTotalCount = 0;
            favoriteIds = new Set();
            if (searchInput) searchInput.value = '';
            if (clearSearchBtn) clearSearchBtn.classList.add('hidden');
            closeUserMenuDropdown();
            await loadAuthState();
            await loadVideos();
        } catch (error) {
            console.error('Logout failed:', error);
        }
    }

    // ===========================
    // Admin Functions
    // ===========================

    function openAdminModal() {
        if (adminModal) {
            adminModal.classList.remove('hidden');
            closeUserMenuDropdown();
            loadAdminUsers();
        }
    }

    function closeAdminModal() {
        if (adminModal) {
            adminModal.classList.add('hidden');
            adminAddUserForm.classList.add('hidden');
            adminUserError.classList.add('hidden');
        }
    }

    async function loadAdminUsers() {
        if (!adminUsersTableBody) return;
        adminUsersTableBody.innerHTML = '<tr><td colspan="5">Loading...</td></tr>';
        try {
            const response = await fetch('/api/admin/users');
            if (!response.ok) {
                adminUsersTableBody.innerHTML = '<tr><td colspan="5">Failed to load users</td></tr>';
                return;
            }
            const data = await response.json();
            const users = data.users || [];
            if (users.length === 0) {
                adminUsersTableBody.innerHTML = '<tr><td colspan="5">No users found</td></tr>';
                return;
            }
            adminUsersTableBody.innerHTML = users.map(u => `
                <tr>
                    <td>${u.id}</td>
                    <td>${escapeHtml(u.username)}</td>
                    <td><span class="role-badge role-${u.role}">${u.role}</span></td>
                    <td>${u.created_at ? new Date(u.created_at).toLocaleString() : '-'}</td>
                    <td>
                        ${u.id !== currentUser?.id ? `<button class="btn-delete" data-user-id="${u.id}">Delete</button>` : '-'}
                    </td>
                </tr>
            `).join('');
            // Attach delete handlers
            adminUsersTableBody.querySelectorAll('.btn-delete').forEach(btn => {
                btn.addEventListener('click', () => deleteUser(parseInt(btn.dataset.userId)));
            });
        } catch (error) {
            console.error('Failed to load admin users:', error);
            adminUsersTableBody.innerHTML = '<tr><td colspan="5">Failed to load users</td></tr>';
        }
    }

    async function deleteUser(userId) {
        if (!confirm('Are you sure you want to delete this user?')) return;
        try {
            const response = await fetch(`/api/admin/users/${userId}`, { method: 'DELETE' });
            if (response.ok) {
                loadAdminUsers();
            } else {
                const data = await response.json();
                alert(data.error || 'Failed to delete user');
            }
        } catch (error) {
            console.error('Failed to delete user:', error);
            alert('Failed to delete user');
        }
    }

    async function handleCreateUser() {
        const username = adminNewUsername.value.trim();
        const password = adminNewPassword.value;
        const role = adminNewRole.value;

        if (!username || !password) {
            adminUserError.textContent = 'Username and password are required';
            adminUserError.classList.remove('hidden');
            return;
        }

        try {
            const response = await fetch('/api/admin/users', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password, role })
            });
            const data = await response.json();
            if (response.ok) {
                adminAddUserForm.classList.add('hidden');
                adminNewUsername.value = '';
                adminNewPassword.value = '';
                adminNewRole.value = 'user';
                adminUserError.classList.add('hidden');
                loadAdminUsers();
            } else {
                adminUserError.textContent = data.error || 'Failed to create user';
                adminUserError.classList.remove('hidden');
            }
        } catch (error) {
            console.error('Failed to create user:', error);
            adminUserError.textContent = 'Failed to create user';
            adminUserError.classList.remove('hidden');
        }
    }

    async function loadAdminLoginLogs() {
        if (!adminLogsTableBody) return;
        adminLogsTableBody.innerHTML = '<tr><td colspan="4">Loading...</td></tr>';
        try {
            const response = await fetch('/api/admin/login-logs');
            if (!response.ok) {
                adminLogsTableBody.innerHTML = '<tr><td colspan="4">Failed to load logs</td></tr>';
                return;
            }
            const data = await response.json();
            const logs = data.logs || [];
            if (logs.length === 0) {
                adminLogsTableBody.innerHTML = '<tr><td colspan="4">No login logs</td></tr>';
                return;
            }
            adminLogsTableBody.innerHTML = logs.map(log => `
                <tr>
                    <td>${log.login_time ? new Date(log.login_time).toLocaleString() : '-'}</td>
                    <td>${escapeHtml(log.username)}</td>
                    <td>${escapeHtml(log.ip_address)}</td>
                    <td><span class="log-status ${log.success ? 'success' : 'failure'}">${log.success ? 'Success' : 'Failed'}</span></td>
                </tr>
            `).join('');
        } catch (error) {
            console.error('Failed to load login logs:', error);
            adminLogsTableBody.innerHTML = '<tr><td colspan="4">Failed to load logs</td></tr>';
        }
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
            totalVideoCount = data.count || 0;
            totalDuplicateCount = data.duplicate_count || 0;
            replaceFavoriteIdsFromVideos(allVideos);

            updateVideoCount(totalVideoCount, totalDuplicateCount);
            renderCategoryTabs();

            if (allVideos.length === 0) {
                showEmptyState();
            } else if (currentSearch) {
                await searchVideos(currentSearch);
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
        const trimmedKeyword = keyword.trim();

        if (!trimmedKeyword) {
            currentSearch = '';
            lastSearchCategoryCounts = {};
            lastSearchResults = [];
            lastSearchTotalCount = 0;
            renderCategoryTabs();
            filterAndRenderVideos();
            clearSearchBtn.classList.add('hidden');
            return;
        }

        // In relaxed mode, search requires login
        if (authEnabled && authMode === 'relaxed' && !currentUser) {
            openLoginModal();
            return;
        }

        try {
            showLoading();
            currentSearch = trimmedKeyword;

            // Always fetch all categories first to get correct counts
            const allResultsResponse = await fetch(`/api/search?q=${encodeURIComponent(trimmedKeyword)}`);
            if (allResultsResponse.status === 401) {
                openLoginModal();
                return;
            }
            const allData = await allResultsResponse.json();
            if (!allResultsResponse.ok) {
                throw new Error(allData.error || 'Search failed');
            }
            const allSearchResults = allData.videos || [];
            lastSearchResults = allSearchResults;
            lastSearchTotalCount = allSearchResults.length;

            // Calculate counts for all categories
            lastSearchCategoryCounts = {};
            allSearchResults.forEach(video => {
                const cat = video.category || 'Uncategorized';
                lastSearchCategoryCounts[cat] = (lastSearchCategoryCounts[cat] || 0) + 1;
            });

            renderCategoryTabs();
            filterAndRenderVideos();
            clearSearchBtn.classList.remove('hidden');
        } catch (error) {
            console.error('Search failed:', error);
            showError('Search failed. Please try again.');
        }
    }

    // Filter and render videos
    function filterAndRenderVideos() {
        let videos = currentSearch ? lastSearchResults : allVideos;

        // Favorites filter
        if (currentCategory === '__favorites__') {
            videos = videos.filter(v => favoriteIds.has(v.id));
        } else if (currentCategory !== 'all') {
            videos = videos.filter(v => v.category === currentCategory);
        }

        if (videos.length === 0) {
            if (currentSearch) {
                showNoSearchResults();
            } else if (currentCategory === '__favorites__') {
                showEmptyStateCustom('No favorites yet.', 'Click the heart icon on videos to add them to your favorites.');
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

        if (currentSearch) {
            videoCountEl.textContent = `${videos.length} result${videos.length !== 1 ? 's' : ''}`;
        } else {
            updateVideoCount(totalVideoCount, totalDuplicateCount);
        }
    }

    // Render category tabs
    function renderCategoryTabs() {
        const categoryNames = sortCategoryNames(Object.keys(categories));
        const isSearchMode = Boolean(currentSearch);

        const getCount = (cat) => {
            if (isSearchMode) {
                return lastSearchCategoryCounts[cat] || 0;
            }
            return categories[cat].length;
        };

        const getTotal = () => {
            if (isSearchMode) {
                return lastSearchTotalCount;
            }
            return Object.values(categories).reduce((sum, videos) => sum + videos.length, 0);
        };

        const getFavoriteCount = () => {
            if (!isSearchMode) {
                return favoriteIds.size;
            }
            return lastSearchResults.filter(video => favoriteIds.has(video.id)).length;
        };

        const allCount = getTotal();
        const allActive = currentCategory === 'all' ? 'active' : '';

        let html = `<button class="tab-btn ${allActive}" data-category="all">All (${allCount})</button>`;

        // Add Favorites tab when auth is enabled and user is logged in
        if (authEnabled && currentUser) {
            const favCount = getFavoriteCount();
            const favActive = currentCategory === '__favorites__' ? 'active' : '';
            html += `<button class="tab-btn ${favActive}" data-category="__favorites__">Favorites (${favCount})</button>`;
        }

        categoryNames.forEach(cat => {
            const count = getCount(cat);
            const activeClass = currentCategory === cat ? 'active' : '';
            html += `<button class="tab-btn ${activeClass}" data-category="${escapeHtml(cat)}">${escapeHtml(cat)} (${count})</button>`;
        });

        categoryTabs.innerHTML = html;
        requestAnimationFrame(updateCategoryTabsNav);
    }

    // Handle category tab clicks via event delegation
    categoryTabs.addEventListener('click', (e) => {
        const btn = e.target.closest('.tab-btn');
        if (!btn) return;

        currentCategory = btn.dataset.category;
        renderCategoryTabs();
        filterAndRenderVideos();
    });

    // Render videos grouped by category
    function renderVideosByCategory() {
        loadingEl.classList.add('hidden');
        emptyStateEl.classList.add('hidden');
        noSearchResultsEl.classList.add('hidden');
        videoGrid.classList.remove('hidden');
        videoGrid.classList.add('category-sections');

        let html = '';
        const sortedCategories = sortCategoryNames(Object.keys(categories));

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
        const isFav = favoriteIds.has(video.id);
        const favClass = isFav ? 'favorited' : '';
        const showFavBtn = authEnabled;
        return `
            <div class="video-card" data-path="${escapeHtml(video.url_path)}" data-name="${escapeHtml(video.name)}" data-id="${escapeHtml(video.id)}">
                <div class="video-thumbnail">
                    ${video.thumbnail
                        ? `<img src="${video.thumbnail}" alt="${escapeHtml(video.name)}" loading="lazy">`
                        : `<div style="width:100%;height:100%;background:linear-gradient(135deg,#333,#222);display:flex;align-items:center;justify-content:center;color:#666;font-size:14px;">No Preview</div>`
                    }
                    <div class="play-icon"></div>
                    ${showFavBtn ? `<button class="favorite-btn ${favClass}" data-id="${escapeHtml(video.id)}" title="${isFav ? 'Remove from favorites' : 'Add to favorites'}" aria-pressed="${isFav ? 'true' : 'false'}">
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
                    </button>` : ''}
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
        videoGrid.classList.remove('category-sections');

        videoGrid.innerHTML = videos.map(video => renderVideoCard(video)).join('');

        attachVideoCardHandlers();
    }

    // Attach click handlers to video cards
    function attachVideoCardHandlers() {
        document.querySelectorAll('.video-card').forEach(card => {
            card.addEventListener('click', (e) => {
                // Don't open player if clicking the favorite button
                if (e.target.closest('.favorite-btn')) return;
                const video = findVideoById(card.dataset.id) || {
                    id: card.dataset.id,
                    url_path: card.dataset.path,
                    name: card.dataset.name
                };
                openPlayer(video);
            });
        });
        // Favorite button handlers
        document.querySelectorAll('.favorite-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const videoId = btn.dataset.id;
                toggleFavorite(videoId, e);
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

    // Show custom empty state
    function showEmptyStateCustom(title, subtitle) {
        loadingEl.classList.add('hidden');
        videoGrid.classList.add('hidden');
        emptyStateEl.innerHTML = `<p>${title}</p><p>${subtitle}</p>`;
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
        videoGrid.classList.remove('category-sections');
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
    function openPlayer(video) {
        currentVideo = {
            id: video.id,
            path: video.url_path || video.path,
            name: video.name
        };

        playerTitle.textContent = currentVideo.name;
        videoPlayer.src = `/video/${currentVideo.path}`;
        videoPlayer.load();

        playerModal.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
        updatePlayerFavoriteButton();

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
        updatePlayerFavoriteButton();
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
            if (response.status === 401) {
                logsContent.textContent = 'Login required.';
                return;
            }
            if (response.status === 403) {
                logsContent.textContent = 'Admin access required.';
                return;
            }
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.error || 'Failed to load logs');
            }

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
        closeUserMenuDropdown();
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
            closeUserMenuDropdown();
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
            lastSearchResults = [];
            lastSearchCategoryCounts = {};
            lastSearchTotalCount = 0;
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
                    lastSearchResults = [];
                    lastSearchCategoryCounts = {};
                    lastSearchTotalCount = 0;
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
            if (userMenu && !userMenu.classList.contains('hidden') && !userMenu.contains(e.target)) {
                closeUserMenuDropdown();
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

        // Favorite button
        if (ctrlFavorite) {
            ctrlFavorite.addEventListener('click', (e) => {
                if (currentVideo) {
                    toggleFavorite(currentVideo.id, e);
                }
            });
        }

        if (categoryTabsPrevBtn) {
            categoryTabsPrevBtn.addEventListener('click', scrollToPreviousCategory);
        }
        if (categoryTabsNextBtn) {
            categoryTabsNextBtn.addEventListener('click', scrollToNextCategory);
        }
        if (categoryTabs) {
            categoryTabs.addEventListener('scroll', updateCategoryTabsNav, { passive: true });
        }
        window.addEventListener('resize', updateCategoryTabsNav);

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

        // Login modal
        if (loginBtn) loginBtn.addEventListener('click', openLoginModal);
        if (closeLoginBtn) closeLoginBtn.addEventListener('click', closeLoginModal);
        if (loginSubmitBtn) loginSubmitBtn.addEventListener('click', handleLogin);
        if (loginPasswordInput) {
            loginPasswordInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') handleLogin();
            });
        }
        if (logoutBtn) logoutBtn.addEventListener('click', handleLogout);
        if (userMenuTrigger) userMenuTrigger.addEventListener('click', toggleUserMenuDropdown);
        if (loginModal) {
            loginModal.querySelector('.modal-overlay').addEventListener('click', closeLoginModal);
        }

        // Admin modal
        if (adminBtn) adminBtn.addEventListener('click', openAdminModal);
        if (closeAdminBtn) closeAdminBtn.addEventListener('click', closeAdminModal);
        if (adminModal) {
            adminModal.querySelector('.modal-overlay').addEventListener('click', closeAdminModal);
        }
        // Admin tabs
        document.querySelectorAll('.admin-tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.admin-tab-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const tab = btn.dataset.adminTab;
                if (tab === 'users') {
                    adminUsersTab.classList.remove('hidden');
                    adminLoginLogsTab.classList.add('hidden');
                } else {
                    adminUsersTab.classList.add('hidden');
                    adminLoginLogsTab.classList.remove('hidden');
                    loadAdminLoginLogs();
                }
            });
        });
        if (adminAddUserBtn) adminAddUserBtn.addEventListener('click', () => {
            adminAddUserForm.classList.remove('hidden');
            adminUserError.classList.add('hidden');
        });
        if (adminCancelUserBtn) adminCancelUserBtn.addEventListener('click', () => {
            adminAddUserForm.classList.add('hidden');
            adminNewUsername.value = '';
            adminNewPassword.value = '';
            adminNewRole.value = 'user';
            adminUserError.classList.add('hidden');
        });
        if (adminCreateUserBtn) adminCreateUserBtn.addEventListener('click', handleCreateUser);

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
