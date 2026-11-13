process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const express = require('express');
const fetch = require('node-fetch');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;

const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7'
};

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.json());

// ================= ДНЕВНАЯ СТАТИСТИКА И ОНЛАЙН =================
let currentStatsDay = new Date().toISOString().slice(0, 10);
let requestsToday = 0;
let concurrentRequests = 0;
let maxRssTodayMB = 0;
let maxHeapUsedTodayMB = 0;
const activeClientsMap = new Map();
const uniqueUsersTodaySet = new Set();

function updateDailyMetrics(req) {
    const now = Date.now();
    const todayStr = new Date(now).toISOString().slice(0, 10);

    if (todayStr !== currentStatsDay) {
        currentStatsDay = todayStr;
        requestsToday = 0;
        maxRssTodayMB = 0;
        maxHeapUsedTodayMB = 0;
        uniqueUsersTodaySet.clear();
    }

    const mem = process.memoryUsage();
    const rssMB = Math.round((mem.rss / 1024 / 1024) * 10) / 10;
    const heapMB = Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10;

    if (rssMB > maxRssTodayMB) maxRssTodayMB = rssMB;
    if (heapMB > maxHeapUsedTodayMB) maxHeapUsedTodayMB = heapMB;

    if (req && req.path !== '/ping') {
        requestsToday++;
        const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
        const ua = String(req.headers['user-agent'] || '').slice(0, 60);
        const clientKey = `${ip}|${ua}`;

        activeClientsMap.set(clientKey, now);
        uniqueUsersTodaySet.add(clientKey);
    }

    const fiveMinAgo = now - 5 * 60 * 1000;
    for (const [key, lastSeen] of activeClientsMap.entries()) {
        if (lastSeen < fiveMinAgo) activeClientsMap.delete(key);
    }
}

setInterval(() => updateDailyMetrics(null), 15000);

app.use((req, res, next) => {
    concurrentRequests++;
    updateDailyMetrics(req);
    let finished = false;
    const onDone = () => {
        if (finished) return;
        finished = true;
        concurrentRequests = Math.max(0, concurrentRequests - 1);
        updateDailyMetrics(null);
    };
    res.on('finish', onDone);
    res.on('close', onDone);
    next();
});

// ================= КЭШ И ЛИМИТЫ ПАМЯТИ =================
const scheduleCache = new Map();
let changesListCache = [];
const changesBufferCache = new Map();
let lastCacheUpdate = null;
let isSyncing = false;

const pendingSchedules = new Map();
const pendingChangesFiles = new Map();
let pendingChangesList = null;

const MAX_CONCURRENT_DOWNLOADS = 5;
const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024;
const MAX_CHANGES_CACHE_ITEMS = 10;

// ================= ГЛОБАЛЬНЫЙ ОГРАНИЧИТЕЛЬ ЗАПРОСОВ К НОВГУ =================
let activeNovsuRequests = 0;
const novsuRequestQueue = [];

function acquireNovsuSlot() {
    if (activeNovsuRequests < MAX_CONCURRENT_DOWNLOADS) {
        activeNovsuRequests++;
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        novsuRequestQueue.push(resolve);
    });
}

function releaseNovsuSlot() {
    if (novsuRequestQueue.length > 0) {
        const nextResolve = novsuRequestQueue.shift();
        nextResolve();
    } else {
        activeNovsuRequests = Math.max(0, activeNovsuRequests - 1);
    }
}

async function fetchNovsu(url, options = {}) {
    await acquireNovsuSlot();
    try {
        return await fetch(url, {
            headers: BROWSER_HEADERS,
            timeout: 12000,
            ...options
        });
    } finally {
        releaseNovsuSlot();
    }
}

async function readBufferWithLimit(response, maxBytes = MAX_FILE_SIZE_BYTES) {
    const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
    if (contentLength > maxBytes) {
        throw new Error(`Файл слишком большой (${Math.round(contentLength / 1024 / 1024)} МБ)`);
    }
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > maxBytes) {
        throw new Error(`Превышен лимит размера файла (${Math.round(arrayBuffer.byteLength / 1024 / 1024)} МБ)`);
    }
    return Buffer.from(arrayBuffer);
}

function enforceChangesCacheLimit() {
    while (changesBufferCache.size > MAX_CHANGES_CACHE_ITEMS) {
        const oldestKey = changesBufferCache.keys().next().value;
        if (!oldestKey) break;
        changesBufferCache.delete(oldestKey);
    }
}

// ================= ПАРСИНГ ССЫЛОК И ТАБЛИЦ =================
function extractLinksFromHtml(html, baseUrl) {
    const links = [];
    const regex = /<a\s+[^>]*href=(?:["']([^"']+)["']|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = regex.exec(html)) !== null) {
        const rawHref = (m[1] || m[2] || '').replace(/&amp;/g, '&').trim();
        const text = (m[3] || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
        if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:')) continue;
        try {
            const fullUrl = new URL(rawHref, baseUrl).href;
            links.push({ href: rawHref, url: fullUrl, text });
        } catch (e) {}
    }
    return links;
}

function indexWorkbookGroups(workbook, fileLabel) {
    let count = 0;
    for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
        const merges = sheet['!merges'] || [];
        if (rows.length < 4) continue;

        for (let r = 0; r < Math.min(30, rows.length); r++) {
            const row = rows[r] || [];
            for (let c = 0; c < row.length; c++) {
                const cellVal = String(row[c] || '').trim();
                const matches = cellVal.match(/\b([2-9]\d{3}[а-яa-z]*)\b/gi);
                if (matches) {
                    for (const grp of matches) {
                        if (/^202\d$/.test(grp)) continue;
                        scheduleCache.set(grp, {
                            group: grp,
                            sheet: sheetName,
                            fileName: fileLabel || sheetName,
                            rows: rows,
                            merges: merges,
                            groupColIdx: c,
                            headerRowIdx: r
                        });
                        count++;
                    }
                }
            }
        }
    }
    return count;
}

function findGroupInWorkbook(workbook, targetGroup) {
    const cleanTarget = targetGroup.replace(/\s+/g, '');
    for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
        const merges = sheet['!merges'] || [];
        if (rows.length < 4) continue;

        for (let r = 0; r < Math.min(35, rows.length); r++) {
            const row = rows[r] || [];
            for (let c = 0; c < row.length; c++) {
                const cellVal = String(row[c] || '').replace(/\s+/g, '');
                if (cellVal === cleanTarget || cellVal.includes(cleanTarget)) {
                    return { rows, merges, groupColIdx: c, headerRowIdx: r, sheet: sheetName };
                }
            }
        }

        for (let r = 0; r < Math.min(25, rows.length); r++) {
            const row = rows[r] || [];
            const c0 = String(row[0] || '').trim().toLowerCase();
            if (c0 === 'понедельник') {
                const headerRow = Math.max(0, r - 1);
                if (!rows[headerRow]) rows[headerRow] = [];
                rows[headerRow][2] = targetGroup;
                return { rows, merges, groupColIdx: 2, headerRowIdx: headerRow, sheet: sheetName };
            }
        }
    }
    return null;
}

const MONTH_STEMS = [
    { rx: /январ/i, m: 0 },
    { rx: /феврал/i, m: 1 },
    { rx: /март/i, m: 2 },
    { rx: /апрел/i, m: 3 },
    { rx: /\bма[йяюе]\b/i, m: 4 },
    { rx: /июн/i, m: 5 },
    { rx: /июл/i, m: 6 },
    { rx: /август/i, m: 7 },
    { rx: /сентябр/i, m: 8 },
    { rx: /октябр/i, m: 9 },
    { rx: /ноябр/i, m: 10 },
    { rx: /декабр/i, m: 11 }
];

function parseMonthFolderScore(text) {
    const clean = String(text || '').trim();
    let monthIdx = -1;
    for (const item of MONTH_STEMS) {
        if (item.rx.test(clean)) {
            monthIdx = item.m;
            break;
        }
    }
    if (monthIdx === -1) return null;
    const yearMatch = clean.match(/\b(20\d{2})\b/);
    const year = yearMatch ? parseInt(yearMatch[1], 10) : new Date().getFullYear();
    return year * 12 + monthIdx;
}

function collectDateFilesFromLinks(links, targetArray) {
    for (const link of links) {
        if (/\d{1,2}\.\d{1,2}\.\d{2,4}\s*-\s*\d{1,2}\.\d{1,2}\.\d{2,4}/.test(link.text)) continue;

        const dateMatch = link.text.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{2,4})\b/);
        if (!dateMatch) continue;

        const d = parseInt(dateMatch[1], 10);
        const m = parseInt(dateMatch[2], 10) - 1;
        let y = parseInt(dateMatch[3], 10);
        if (y < 100) y += 2000;

        const timestamp = new Date(y, m, d).getTime();
        const cleanTitle = `${String(d).padStart(2, '0')}.${String(m + 1).padStart(2, '0')}.${y}`;

        if (!targetArray.some(f => f.url === link.url || f.title === cleanTitle)) {
            targetArray.push({ title: cleanTitle, url: link.url, timestamp });
        }
    }
}

async function fetchReplacementFilesList() {
    const entryUrls = [
        'https://portal.novsu.ru/univer/timetable/spo/i.1473214/',
        'https://portal.novsu.ru/univer/timetable/spo/i.1473214/?id=2445999'
    ];

    const visitedPages = new Set();
    const allDiscoveredLinks = [];
    let successfulPagesCount = 0;
    let lastNetworkError = null;

    async function scanPage(url) {
        if (!url || visitedPages.has(url)) return [];
        visitedPages.add(url);
        try {
            const res = await fetchNovsu(url, { timeout: 10000 });
            if (!res.ok) {
                lastNetworkError = new Error(`Портал НовГУ ответил кодом ${res.status}`);
                return [];
            }
            successfulPagesCount++;
            const html = await res.text();
            const links = extractLinksFromHtml(html, url);
            allDiscoveredLinks.push(...links);
            return links;
        } catch (e) {
            lastNetworkError = e;
            return [];
        }
    }

    for (const url of entryUrls) {
        await scanPage(url);
    }

    if (successfulPagesCount === 0) {
        throw lastNetworkError || new Error('Портал НовГУ недоступен');
    }

    const ptkRootLinks = allDiscoveredLinks.filter(l => /^птк$/i.test(l.text.trim()));
    for (const ptkLink of ptkRootLinks) {
        await scanPage(ptkLink.url);
    }

    const monthFolders = [];
    const seenFolderUrls = new Set();

    for (const link of allDiscoveredLinks) {
        const score = parseMonthFolderScore(link.text);
        if (score !== null && !seenFolderUrls.has(link.url)) {
            seenFolderUrls.add(link.url);
            monthFolders.push({ title: link.text, url: link.url, score });
        }
    }

    monthFolders.sort((a, b) => b.score - a.score);

    const foldersToScan = monthFolders.slice(0, 2);
    const files = [];

    if (foldersToScan.length > 0) {
        await Promise.allSettled(foldersToScan.map(async (folder) => {
            const folderLinks = await scanPage(folder.url);
            collectDateFilesFromLinks(folderLinks, files);
        }));
    }

    collectDateFilesFromLinks(allDiscoveredLinks, files);

    files.sort((a, b) => b.timestamp - a.timestamp);
    return files.slice(0, 5).map(f => ({ title: f.title, url: f.url }));
}

// ================= ФУНКЦИИ С ДЕДУПЛИКАЦИЕЙ И ЗАЩИТОЙ КЭША =================
async function downloadChangesFileBuffer(url, title) {
    if (changesBufferCache.has(url)) {
        return changesBufferCache.get(url);
    }
    if (pendingChangesFiles.has(url)) {
        return pendingChangesFiles.get(url);
    }

    const promise = (async () => {
        const fileRes = await fetchNovsu(url, { timeout: 10000 });
        if (!fileRes.ok) throw new Error(`Не удалось скачать (${fileRes.status})`);
        const buffer = await readBufferWithLimit(fileRes);
        const item = { buffer, title: title || 'changes.docx', fetchedAt: Date.now() };
        changesBufferCache.set(url, item);
        enforceChangesCacheLimit();
        return item;
    })();

    pendingChangesFiles.set(url, promise);
    try {
        return await promise;
    } finally {
        if (pendingChangesFiles.get(url) === promise) {
            pendingChangesFiles.delete(url);
        }
    }
}

async function getOrFetchChangesList(forceRefresh = false) {
    if (!forceRefresh && changesListCache.length > 0) {
        return { files: changesListCache, cached: true, stale: false };
    }
    if (pendingChangesList) {
        return pendingChangesList;
    }

    const promise = (async () => {
        try {
            const files = await fetchReplacementFilesList();
            if (files.length > 0) {
                changesListCache = files;
                return { files: changesListCache, cached: false, stale: false };
            }
            if (changesListCache.length > 0) {
                return { files: changesListCache, cached: true, stale: true };
            }
            return { files: [], cached: false, stale: false };
        } catch (err) {
            if (changesListCache.length > 0) {
                return { files: changesListCache, cached: true, stale: true };
            }
            throw err;
        }
    })();

    pendingChangesList = promise;
    try {
        return await promise;
    } finally {
        if (pendingChangesList === promise) {
            pendingChangesList = null;
        }
    }
}

async function fetchAndCacheGroupSchedule(targetGroup) {
    const pagesToScan = [
        'https://portal.novsu.ru/univer/timetable/spo/i.1473214/?id=2445999',
        'https://portal.novsu.ru/univer/timetable/spo/'
    ];
    const exactRegex = new RegExp(`(^|\\D)${targetGroup}(\\D|$)`);
    const prefix3 = targetGroup.slice(0, 3);
    const prefixRegex = new RegExp(`(^|\\D)${prefix3}\\d(\\D|$)`);
    const candidates = [];
    const seenUrls = new Set();

    await Promise.allSettled(pagesToScan.map(async (pageUrl) => {
        try {
            const r = await fetchNovsu(pageUrl, { timeout: 10000 });
            if (!r.ok) return;
            const html = await r.text();
            const links = extractLinksFromHtml(html, pageUrl);
            for (const link of links) {
                const combined = `${link.text} ${decodeURIComponent(link.url)}`;
                if (/\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/.test(link.text)) continue;
                if (link.text.trim() === targetGroup || exactRegex.test(combined)) {
                    if (!seenUrls.has(link.url)) { candidates.unshift(link); seenUrls.add(link.url); }
                } else if (prefix3.length === 3 && prefixRegex.test(combined)) {
                    if (!seenUrls.has(link.url)) { candidates.push(link); seenUrls.add(link.url); }
                }
            }
        } catch (e) {}
    }));

    for (const cand of candidates) {
        try {
            const fileRes = await fetchNovsu(cand.url, { timeout: 15000 });
            if (!fileRes.ok) continue;
            const buffer = await readBufferWithLimit(fileRes);
            const headStr = buffer.slice(0, 100).toString('utf8').trim().toLowerCase();
            if (headStr.startsWith('<!doctype') || headStr.startsWith('<html')) continue;

            const workbook = XLSX.read(buffer, { type: 'buffer' });
            indexWorkbookGroups(workbook, cand.text);

            if (scheduleCache.has(targetGroup)) {
                return scheduleCache.get(targetGroup);
            }

            const result = findGroupInWorkbook(workbook, targetGroup);
            if (result) {
                if (!result.rows[result.headerRowIdx]) result.rows[result.headerRowIdx] = [];
                result.rows[result.headerRowIdx][result.groupColIdx] = targetGroup;
                const payload = {
                    group: targetGroup,
                    sheet: result.sheet,
                    fileName: cand.text || result.sheet,
                    rows: result.rows,
                    merges: result.merges,
                    groupColIdx: result.groupColIdx,
                    headerRowIdx: result.headerRowIdx
                };
                scheduleCache.set(targetGroup, payload);
                return payload;
            }
        } catch (e) {}
    }
    return null;
}

function getGroupScheduleWithDedup(targetGroup) {
    if (pendingSchedules.has(targetGroup)) {
        return pendingSchedules.get(targetGroup);
    }

    const promise = (async () => {
        try {
            return await fetchAndCacheGroupSchedule(targetGroup);
        } finally {
            if (pendingSchedules.get(targetGroup) === promise) {
                pendingSchedules.delete(targetGroup);
            }
        }
    })();

    pendingSchedules.set(targetGroup, promise);
    return promise;
}

// ================= ФОНОВАЯ СИНХРОНИЗАЦИЯ =================
async function syncAllDataFromNovsu() {
    if (isSyncing) return;
    isSyncing = true;
    try {
        const chgFiles = await fetchReplacementFilesList().catch(() => []);
        if (chgFiles.length > 0) {
            changesListCache = chgFiles;
            const activeUrls = new Set(chgFiles.map(f => f.url));

            await Promise.allSettled(chgFiles.map(async (f) => {
                if (changesBufferCache.has(f.url)) return;
                try {
                    await downloadChangesFileBuffer(f.url, f.title);
                } catch (e) {}
            }));

            for (const cachedUrl of changesBufferCache.keys()) {
                if (!activeUrls.has(cachedUrl)) {
                    changesBufferCache.delete(cachedUrl);
                }
            }
        }

        const pagesToScan = [
            'https://portal.novsu.ru/univer/timetable/spo/i.1473214/?id=2445999',
            'https://portal.novsu.ru/univer/timetable/spo/'
        ];
        const excelUrls = new Map();

        await Promise.allSettled(pagesToScan.map(async (pageUrl) => {
            try {
                const r = await fetchNovsu(pageUrl, { timeout: 10000 });
                if (!r.ok) return;
                const html = await r.text();
                const links = extractLinksFromHtml(html, pageUrl);
                for (const link of links) {
                    if (/\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/.test(link.text)) continue;
                    if (/\b[2-9]\d{3}\b/.test(link.text) || /\.(xlsx?|xls)($|\?)/i.test(link.url)) {
                        if (!excelUrls.has(link.url)) excelUrls.set(link.url, link.text);
                    }
                }
            } catch (e) {}
        }));

        const excelEntries = Array.from(excelUrls.entries());
        let updatedSchedulesCount = 0;

        await Promise.allSettled(excelEntries.map(async ([url, label]) => {
            try {
                const fileRes = await fetchNovsu(url, { timeout: 15000 });
                if (!fileRes.ok) return;
                const buffer = await readBufferWithLimit(fileRes);
                const headStr = buffer.slice(0, 100).toString('utf8').trim().toLowerCase();
                if (headStr.startsWith('<!doctype') || headStr.startsWith('<html')) return;

                const workbook = XLSX.read(buffer, { type: 'buffer' });
                updatedSchedulesCount += indexWorkbookGroups(workbook, label);
            } catch (e) {}
        }));

        if (chgFiles.length > 0 || updatedSchedulesCount > 0) {
            lastCacheUpdate = new Date().toISOString();
        }
    } catch (err) {
        console.error('[SYNC ERROR]', err.message);
    } finally {
        isSyncing = false;
        updateDailyMetrics(null);
    }
}

setInterval(syncAllDataFromNovsu, 30 * 60 * 1000);

// ================= API РОУТЫ =================
app.get('/api/changes-list', async (req, res) => {
    try {
        const forceRefresh = req.query.refresh === '1';
        const result = await getOrFetchChangesList(forceRefresh);
        res.json(result);
    } catch (error) {
        if (changesListCache.length > 0) {
            return res.json({ files: changesListCache, cached: true, stale: true });
        }
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/changes', async (req, res) => {
    try {
        let targetUrl = req.query.url;
        let fileTitle = req.query.title || 'changes.docx';

        if (!targetUrl) {
            const listResult = await getOrFetchChangesList(false);
            if (!listResult.files || listResult.files.length === 0) {
                return res.status(404).json({ error: 'Файлы не найдены' });
            }
            targetUrl = listResult.files[0].url;
            fileTitle = listResult.files[0].title;
        }

        const parsedUrl = new URL(targetUrl);
        if (!parsedUrl.hostname.endsWith('novsu.ru')) {
            return res.status(403).json({ error: 'Разрешена загрузка только с домена novsu.ru' });
        }

        const cachedOrDownloaded = await downloadChangesFileBuffer(targetUrl, fileTitle);

        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('X-File-Title', encodeURIComponent(cachedOrDownloaded.title || fileTitle));
        res.send(cachedOrDownloaded.buffer);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/schedule/:group', async (req, res) => {
    try {
        const targetGroup = String(req.params.group || '').trim();
        if (!targetGroup) return res.status(400).json({ error: 'Не указана группа' });

        if (scheduleCache.has(targetGroup)) {
            return res.json(scheduleCache.get(targetGroup));
        }

        const payload = await getGroupScheduleWithDedup(targetGroup);
        if (payload) {
            return res.json(payload);
        }

        return res.status(404).json({ error: `Группа ${targetGroup} не найдена` });
    } catch (error) {
        const targetGroup = String(req.params.group || '').trim();
        if (scheduleCache.has(targetGroup)) {
            return res.json(scheduleCache.get(targetGroup));
        }
        res.status(500).json({ error: error.message });
    }
});

app.get('/ping', (req, res) => {
    updateDailyMetrics(null);
    const mem = process.memoryUsage();
    const rssMB = Math.round((mem.rss / 1024 / 1024) * 10) / 10;
    const heapUsedMB = Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10;

    if (req.query.format === 'text') {
        const lines = [
            `Статус сервера: ok (${currentStatsDay})`,
            `Используют прямо сейчас (онлайн за 5 мин): ${activeClientsMap.size} чел.`,
            `Одновременных соединений в эту секунду: ${concurrentRequests}`,
            `Уникальных пользователей за сегодня: ${uniqueUsersTodaySet.size}`,
            `Запросов за сегодня: ${requestsToday}`,
            `Память сейчас (RSS / Heap): ${rssMB} МБ / ${heapUsedMB} МБ`,
            `Макс. память за сегодня (RSS / Heap): ${maxRssTodayMB} МБ / ${maxHeapUsedTodayMB} МБ`,
            `Групп в кэше: ${scheduleCache.size}`,
            `Файлов замен в RAM: ${changesBufferCache.size}`,
            `Активных загрузок расписания: ${pendingSchedules.size}`,
            `Запросов к НовГУ (активно / в очереди): ${activeNovsuRequests} / ${novsuRequestQueue.length}`,
            `Последнее обновление кэша: ${lastCacheUpdate || 'ещё не было'}`
        ];
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.send(lines.join('\n'));
    }

    const stats = {
        status: 'ok',
        date: currentStatsDay,
        onlineUsersLast5Min: activeClientsMap.size,
        concurrentRequestsNow: concurrentRequests,
        uniqueUsersToday: uniqueUsersTodaySet.size,
        requestsToday: requestsToday,
        heapUsedMB: heapUsedMB,
        rssMB: rssMB,
        maxHeapUsedTodayMB: maxHeapUsedTodayMB,
        maxRssTodayMB: maxRssTodayMB,
        cachedGroupsCount: scheduleCache.size,
        changesFilesInRam: changesBufferCache.size,
        inFlightSchedules: pendingSchedules.size,
        activeNovsuRequests: activeNovsuRequests,
        queuedNovsuRequests: novsuRequestQueue.length,
        lastCacheUpdate: lastCacheUpdate
    };

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(JSON.stringify(stats, null, 2) + '\n');
});

app.listen(PORT, () => {
    console.log(`PTK Schedule Server running on port ${PORT}`);
    syncAllDataFromNovsu();
});
