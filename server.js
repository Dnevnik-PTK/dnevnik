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

// ================= КЭШ РАСПИСАНИЙ И ЗАМЕН =================
const scheduleCache = new Map();
let changesListCache = [];
const changesBufferCache = new Map();
let lastCacheUpdate = null;
let isSyncing = false;

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
        // Пропускаем диапазоны недель вида "02.11.2026 - 07.11.2026"
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

    async function scanPage(url) {
        if (!url || visitedPages.has(url)) return [];
        visitedPages.add(url);
        try {
            const res = await fetch(url, { headers: BROWSER_HEADERS, timeout: 10000 });
            if (!res.ok) return [];
            const html = await res.text();
            const links = extractLinksFromHtml(html, url);
            allDiscoveredLinks.push(...links);
            return links;
        } catch (e) {
            return [];
        }
    }

    // 1. Сканируем стартовые страницы
    for (const url of entryUrls) {
        await scanPage(url);
    }

    // 2. Если на странице есть ссылка в корневую папку "ПТК" (из хлебных крошек), заходим в неё
    const ptkRootLinks = allDiscoveredLinks.filter(l => /^птк$/i.test(l.text.trim()));
    for (const ptkLink of ptkRootLinks) {
        await scanPage(ptkLink.url);
    }

    // 3. Ищем все папки месяцев ("Сентябрь 2026", "октябрь 2026", "ноябрь 2026" и т.д.)
    const monthFolders = [];
    const seenFolderUrls = new Set();

    for (const link of allDiscoveredLinks) {
        const score = parseMonthFolderScore(link.text);
        if (score !== null && !seenFolderUrls.has(link.url)) {
            seenFolderUrls.add(link.url);
            monthFolders.push({ title: link.text, url: link.url, score });
        }
    }

    // Сортируем папки месяцев от самой новой к старой (Ноябрь 2026 -> Октябрь 2026 -> Сентябрь 2026)
    monthFolders.sort((a, b) => b.score - a.score);

    // 4. Заходим в 2 самых свежих месяца параллельно (чтобы в начале месяца захватывать и конец прошлого)
    const foldersToScan = monthFolders.slice(0, 2);
    const files = [];

    if (foldersToScan.length > 0) {
        await Promise.allSettled(foldersToScan.map(async (folder) => {
            const folderLinks = await scanPage(folder.url);
            collectDateFilesFromLinks(folderLinks, files);
        }));
    }

    // На случай если файлы лежат сразу в корне
    collectDateFilesFromLinks(allDiscoveredLinks, files);

    files.sort((a, b) => b.timestamp - a.timestamp);
    return files.slice(0, 5).map(f => ({ title: f.title, url: f.url }));
}


async function syncAllDataFromNovsu() {
    if (isSyncing) return;
    isSyncing = true;
    try {
        const chgFiles = await fetchReplacementFilesList();
        if (chgFiles.length > 0) {
            changesListCache = chgFiles;
            const activeUrls = new Set(chgFiles.map(f => f.url));

            // Удаляем из памяти только старые файлы, которых больше нет в топ-5
            for (const cachedUrl of changesBufferCache.keys()) {
                if (!activeUrls.has(cachedUrl)) {
                    changesBufferCache.delete(cachedUrl);
                }
            }

            // Скачиваем недостающие файлы замен параллельно
            await Promise.allSettled(chgFiles.map(async (f) => {
                if (changesBufferCache.has(f.url)) return;
                try {
                    const r = await fetch(f.url, { headers: BROWSER_HEADERS, timeout: 10000 });
                    if (r.ok) {
                        const buf = Buffer.from(await r.arrayBuffer());
                        changesBufferCache.set(f.url, { buffer: buf, title: f.title });
                    }
                } catch (e) {}
            }));
        }

        const pagesToScan = [
            'https://portal.novsu.ru/univer/timetable/spo/i.1473214/?id=2445999',
            'https://portal.novsu.ru/univer/timetable/spo/'
        ];
        const excelUrls = new Map();
        for (const pageUrl of pagesToScan) {
            try {
                const r = await fetch(pageUrl, { headers: BROWSER_HEADERS, timeout: 10000 });
                if (!r.ok) continue;
                const html = await r.text();
                const links = extractLinksFromHtml(html, pageUrl);
                for (const link of links) {
                    if (/\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/.test(link.text)) continue;
                    if (/\b[2-9]\d{3}\b/.test(link.text) || /\.(xlsx?|xls)($|\?)/i.test(link.url)) {
                        if (!excelUrls.has(link.url)) excelUrls.set(link.url, link.text);
                    }
                }
            } catch (e) {}
        }

        for (const [url, label] of excelUrls.entries()) {
            try {
                const fileRes = await fetch(url, { headers: BROWSER_HEADERS, timeout: 15000 });
                if (!fileRes.ok) continue;
                const buffer = Buffer.from(await fileRes.arrayBuffer());
                const headStr = buffer.slice(0, 100).toString('utf8').trim().toLowerCase();
                if (headStr.startsWith('<!doctype') || headStr.startsWith('<html')) continue;

                const workbook = XLSX.read(buffer, { type: 'buffer' });
                indexWorkbookGroups(workbook, label);
            } catch (e) {}
        }
        lastCacheUpdate = new Date().toISOString();
    } catch (err) {
        console.error('[SYNC ERROR]', err.message);
    } finally {
        isSyncing = false;
    }
}

setInterval(syncAllDataFromNovsu, 30 * 60 * 1000);

// ================= API РОУТЫ =================
app.get('/api/changes-list', async (req, res) => {
    try {
        if (changesListCache.length > 0) return res.json({ files: changesListCache, cached: true });
        const files = await fetchReplacementFilesList();
        changesListCache = files;
        res.json({ files, cached: false });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/changes', async (req, res) => {
    try {
        let targetUrl = req.query.url;
        let fileTitle = req.query.title || 'changes.docx';

        if (!targetUrl) {
            if (changesListCache.length === 0) {
                changesListCache = await fetchReplacementFilesList();
            }
            if (changesListCache.length === 0) {
                return res.status(404).json({ error: 'Файлы не найдены' });
            }
            targetUrl = changesListCache[0].url;
            fileTitle = changesListCache[0].title;
        }

        // Проверяем, что ссылка ведет строго на сайт НовГУ
        const parsedUrl = new URL(targetUrl);
        if (!parsedUrl.hostname.endsWith('novsu.ru')) {
            return res.status(403).json({ error: 'Разрешена загрузка только с домена novsu.ru' });
        }

        if (changesBufferCache.has(targetUrl)) {
            const cachedItem = changesBufferCache.get(targetUrl);
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('X-File-Title', encodeURIComponent(cachedItem.title || fileTitle));
            return res.send(cachedItem.buffer);
        }

        const fileRes = await fetch(targetUrl, { headers: BROWSER_HEADERS, timeout: 10000 });
        if (!fileRes.ok) throw new Error(`Не удалось скачать (${fileRes.status})`);

        const buffer = Buffer.from(await fileRes.arrayBuffer());
        changesBufferCache.set(targetUrl, { buffer, title: fileTitle });

        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('X-File-Title', encodeURIComponent(fileTitle));
        res.send(buffer);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


app.get('/api/schedule/:group', async (req, res) => {
    try {
        const targetGroup = String(req.params.group || '').trim();
        if (!targetGroup) return res.status(400).json({ error: 'Не указана группа' });
        if (scheduleCache.has(targetGroup)) return res.json(scheduleCache.get(targetGroup));

        const pagesToScan = [
            'https://portal.novsu.ru/univer/timetable/spo/i.1473214/?id=2445999',
            'https://portal.novsu.ru/univer/timetable/spo/'
        ];
        const exactRegex = new RegExp(`(^|\\D)${targetGroup}(\\D|$)`);
        const prefix3 = targetGroup.slice(0, 3);
        const prefixRegex = new RegExp(`(^|\\D)${prefix3}\\d(\\D|$)`);
        const candidates = [];
        const seenUrls = new Set();

        for (const pageUrl of pagesToScan) {
            try {
                const r = await fetch(pageUrl, { headers: BROWSER_HEADERS });
                if (!r.ok) continue;
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
        }

        for (const cand of candidates) {
            try {
                const fileRes = await fetch(cand.url, { headers: BROWSER_HEADERS });
                if (!fileRes.ok) continue;
                const buffer = Buffer.from(await fileRes.arrayBuffer());
                const headStr = buffer.slice(0, 100).toString('utf8').trim().toLowerCase();
                if (headStr.startsWith('<!doctype') || headStr.startsWith('<html')) continue;

                const workbook = XLSX.read(buffer, { type: 'buffer' });
                indexWorkbookGroups(workbook, cand.text);
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
                    return res.json(payload);
                }
            } catch (e) {}
        }
        return res.status(404).json({ error: `Группа ${targetGroup} не найдена` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/ping', (req, res) => {
    res.json({
        status: 'ok',
        cachedGroupsCount: scheduleCache.size,
        lastCacheUpdate,
        memoryUsage: process.memoryUsage()
    });
});

app.listen(PORT, () => {
    console.log(`PTK Schedule Server running on port ${PORT}`);
    syncAllDataFromNovsu();
});
