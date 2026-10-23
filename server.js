process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const express = require('express');
const fetch = require('node-fetch');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const STATE_FILE = path.join(__dirname, 'backup-state.json');

const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7'
};

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

// ================= КЭШ И ЛЕГКОВЕСНЫЕ ХРАНИЛИЩА =================
const scheduleCache = new Map();
let changesListCache = [];
const changesBufferCache = new Map();
let lastCacheUpdate = null;
let isSyncing = false;

const starostaOneTimeKeys = new Map();
const starostaSessions = new Map();
const groupTasksStorage = new Map();
const groupMaterialsStorage = new Map();
const adminSessions = new Set();

function loadPersistentState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            if (raw.oneTimeKeys) Object.entries(raw.oneTimeKeys).forEach(([k, v]) => starostaOneTimeKeys.set(k, v));
            if (raw.sessions) Object.entries(raw.sessions).forEach(([k, v]) => starostaSessions.set(k, v));
            if (raw.tasks) Object.entries(raw.tasks).forEach(([k, v]) => groupTasksStorage.set(k, v));
            if (raw.materials) Object.entries(raw.materials).forEach(([k, v]) => groupMaterialsStorage.set(k, v));
            if (Array.isArray(raw.admins)) raw.admins.forEach(t => adminSessions.add(t));
        }
    } catch (e) {}
}

function savePersistentState() {
    try {
        const data = {
            oneTimeKeys: Object.fromEntries(starostaOneTimeKeys),
            sessions: Object.fromEntries(starostaSessions),
            tasks: Object.fromEntries(groupTasksStorage),
            materials: Object.fromEntries(groupMaterialsStorage),
            admins: Array.from(adminSessions)
        };
        fs.writeFileSync(STATE_FILE, JSON.stringify(data), 'utf8');
    } catch (e) {}
}

loadPersistentState();

function generateRandomCode(len = 6) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let res = '';
    for (let i = 0; i < len; i++) res += chars.charAt(Math.floor(Math.random() * chars.length));
    return res;
}

let currentRootOneTimeKey = process.env.ROOT_KEY || `ROOT-${generateRandomCode(8)}`;
console.log('====================================================');
console.log('🔑 КЛЮЧ СОЗДАТЕЛЯ ДЛЯ ВХОДА В АДМИНКУ:');
console.log(currentRootOneTimeKey);
console.log('====================================================');

// ================= АДМИНКА И СТАРОСТЫ (МГНОВЕННЫЙ ОТКЛИК) =================
app.post('/api/admin/auth', (req, res) => {
    const { rootKey } = req.body || {};
    const cleanKey = String(rootKey || '').trim();

    if (!currentRootOneTimeKey || cleanKey !== currentRootOneTimeKey) {
        return res.status(403).json({ error: 'Одноразовый ключ создателя недействителен или уже сгорел' });
    }

    if (!process.env.ROOT_KEY) currentRootOneTimeKey = null;
    const adminToken = `ADMIN-${generateRandomCode(20)}`;
    adminSessions.add(adminToken);
    savePersistentState();

    res.json({ success: true, adminToken });
});

app.post('/api/admin/generate-starosta-key', (req, res) => {
    const { adminToken, group } = req.body || {};
    if (!adminSessions.has(adminToken)) {
        return res.status(403).json({ error: 'Сессия администратора не подтверждена' });
    }
    const cleanGroup = String(group || '').trim();
    if (!cleanGroup) return res.status(400).json({ error: 'Укажите номер группы' });

    const key = `KEY-${cleanGroup}-${generateRandomCode(6)}`;
    starostaOneTimeKeys.set(key, cleanGroup);
    savePersistentState();

    res.json({ success: true, group: cleanGroup, key });
});

app.post('/api/admin/revoke-starosta', (req, res) => {
    const { adminToken, group } = req.body || {};
    if (!adminSessions.has(adminToken)) {
        return res.status(403).json({ error: 'Доступ запрещён' });
    }
    const cleanGroup = String(group || '').trim();
    starostaSessions.delete(cleanGroup);
    savePersistentState();
    res.json({ success: true, message: `Староста группы ${cleanGroup} сброшен` });
});

app.post('/api/tasks/auth', (req, res) => {
    const { secretKey } = req.body || {};
    const cleanKey = String(secretKey || '').trim().toUpperCase();

    if (!starostaOneTimeKeys.has(cleanKey)) {
        return res.status(403).json({ error: 'Одноразовый ключ недействителен или уже был активирован' });
    }

    const group = starostaOneTimeKeys.get(cleanKey);
    starostaOneTimeKeys.delete(cleanKey);

    const sessionToken = `STAROSTA-${group}-${generateRandomCode(16)}`;
    starostaSessions.set(group, sessionToken);
    savePersistentState();

    res.json({ success: true, group, sessionToken });
});

// ================= ГРУППОВЫЕ ЗАДАНИЯ =================
app.get('/api/tasks/:group', (req, res) => {
    const group = String(req.params.group || '').trim();
    res.json({ tasks: groupTasksStorage.get(group) || [] });
});

app.post('/api/tasks/:group', (req, res) => {
    const group = String(req.params.group || '').trim();
    const { task, sessionToken } = req.body || {};

    const activeToken = starostaSessions.get(group);
    if (!activeToken || activeToken !== sessionToken) {
        return res.status(403).json({ error: 'Сессия старосты недействительна' });
    }

    if (!task || !task.title || !task.dueDate) {
        return res.status(400).json({ error: 'Заполните название задания и срок сдачи' });
    }

    if (!groupTasksStorage.has(group)) groupTasksStorage.set(group, []);

    const newTask = {
        id: Date.now(),
        subject: String(task.subject || 'Общее').trim(),
        title: String(task.title || '').trim(),
        dueDate: String(task.dueDate || '').trim(),
        author: 'Староста',
        createdAt: new Date().toISOString()
    };

    const list = groupTasksStorage.get(group);
    list.unshift(newTask);
    if (list.length > 50) list.length = 50;
    savePersistentState();

    res.json({ success: true, task: newTask });
});

app.delete('/api/tasks/:group/:id', (req, res) => {
    const group = String(req.params.group || '').trim();
    const taskId = parseInt(req.params.id, 10);
    const { sessionToken } = req.body || {};

    const activeToken = starostaSessions.get(group);
    if (!activeToken || activeToken !== sessionToken) {
        return res.status(403).json({ error: 'Сессия старосты недействительна' });
    }

    if (groupTasksStorage.has(group)) {
        const filtered = groupTasksStorage.get(group).filter(t => t.id !== taskId);
        groupTasksStorage.set(group, filtered);
        savePersistentState();
    }

    res.json({ success: true });
});

// ================= ССЫЛКИ НА МАТЕРИАЛЫ ГРУППЫ (БЕЗ ФАЙЛОВ В ОЗУ) =================
app.get('/api/materials/:group', (req, res) => {
    const group = String(req.params.group || '').trim();
    res.json({ materials: groupMaterialsStorage.get(group) || [] });
});

app.post('/api/materials/:group', (req, res) => {
    const group = String(req.params.group || '').trim();
    const { material, sessionToken } = req.body || {};

    const activeToken = starostaSessions.get(group);
    if (!activeToken || activeToken !== sessionToken) {
        return res.status(403).json({ error: 'Сессия старосты недействительна' });
    }

    if (!material || !material.title || !material.fileUrl) {
        return res.status(400).json({ error: 'Заполните название и прикрепите файл или ссылку' });
    }

    if (!groupMaterialsStorage.has(group)) groupMaterialsStorage.set(group, []);

    const newMaterial = {
        id: Date.now(),
        title: String(material.title || '').trim(),
        subject: String(material.subject || 'Общий материал').trim(),
        fileUrl: String(material.fileUrl || '').trim(),
        viewUrl: String(material.viewUrl || material.fileUrl || '').trim(),
        fileName: String(material.fileName || 'Файл').trim(),
        fileSize: String(material.fileSize || '').trim(),
        author: 'Староста',
        createdAt: new Date().toISOString()
    };

    const list = groupMaterialsStorage.get(group);
    list.unshift(newMaterial);
    if (list.length > 100) list.length = 100;
    savePersistentState();

    res.json({ success: true, material: newMaterial });
});

app.delete('/api/materials/:group/:id', (req, res) => {
    const group = String(req.params.group || '').trim();
    const materialId = parseInt(req.params.id, 10);
    const { sessionToken } = req.body || {};

    const activeToken = starostaSessions.get(group);
    if (!activeToken || activeToken !== sessionToken) {
        return res.status(403).json({ error: 'Сессия старосты недействительна' });
    }

    if (groupMaterialsStorage.has(group)) {
        const filtered = groupMaterialsStorage.get(group).filter(m => m.id !== materialId);
        groupMaterialsStorage.set(group, filtered);
        savePersistentState();
    }

    res.json({ success: true });
});

// ================= ПАРСИНГ РАСПИСАНИЯ И ЗАМЕН НОВГУ =================
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

async function fetchReplacementFilesList() {
    const pageUrl = 'https://portal.novsu.ru/univer/timetable/spo/i.1473214/?id=2445999';
    const response = await fetch(pageUrl, { headers: BROWSER_HEADERS });
    if (!response.ok) throw new Error(`Портал ответил ${response.status}`);
    const html = await response.text();
    const allLinks = extractLinksFromHtml(html, pageUrl);
    const files = [];

    for (const link of allLinks) {
        const dateMatch = link.text.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{2,4})\b/);
        if (!dateMatch) continue;
        const d = parseInt(dateMatch[1], 10);
        const m = parseInt(dateMatch[2], 10) - 1;
        let y = parseInt(dateMatch[3], 10);
        if (y < 100) y += 2000;
        const timestamp = new Date(y, m, d).getTime();
        if (!files.some(f => f.url === link.url || f.title === link.text)) {
            files.push({ title: link.text, url: link.url, timestamp });
        }
    }
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
            changesBufferCache.clear();
            for (const f of chgFiles) {
                try {
                    const r = await fetch(f.url, { headers: BROWSER_HEADERS });
                    if (r.ok) {
                        const buf = Buffer.from(await r.arrayBuffer());
                        changesBufferCache.set(f.url, { buffer: buf, title: f.title });
                    }
                } catch (e) {}
            }
        }

        const pagesToScan = [
            'https://portal.novsu.ru/univer/timetable/spo/i.1473214/?id=2445999',
            'https://portal.novsu.ru/univer/timetable/spo/'
        ];
        const excelUrls = new Map();
        for (const pageUrl of pagesToScan) {
            try {
                const r = await fetch(pageUrl, { headers: BROWSER_HEADERS });
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
                const fileRes = await fetch(url, { headers: BROWSER_HEADERS });
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
    } finally {
        isSyncing = false;
    }
}
setInterval(syncAllDataFromNovsu, 30 * 60 * 1000);

app.get('/api/changes-list', async (req, res) => {
    try {
        if (changesListCache.length > 0) return res.json({ files: changesListCache, cached: true });
        const files = await fetchReplacementFilesList();
        changesListCache = files;
        res.json({ files, cached: false });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/changes', async (req, res) => {
    try {
        let targetUrl = req.query.url;
        let fileTitle = req.query.title || 'changes.docx';
        if (!targetUrl) {
            if (changesListCache.length === 0) changesListCache = await fetchReplacementFilesList();
            if (changesListCache.length === 0) return res.status(404).json({ error: 'Файлы не найдены' });
            targetUrl = changesListCache[0].url;
            fileTitle = changesListCache[0].title;
        }
        if (changesBufferCache.has(targetUrl)) {
            const cachedItem = changesBufferCache.get(targetUrl);
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('X-File-Title', encodeURIComponent(cachedItem.title || fileTitle));
            return res.send(cachedItem.buffer);
        }
        const fileRes = await fetch(targetUrl, { headers: BROWSER_HEADERS });
        if (!fileRes.ok) throw new Error(`Не удалось скачать (${fileRes.status})`);
        const buffer = Buffer.from(await fileRes.arrayBuffer());
        changesBufferCache.set(targetUrl, { buffer, title: fileTitle });
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('X-File-Title', encodeURIComponent(fileTitle));
        res.send(buffer);
    } catch (error) { res.status(500).json({ error: error.message }); }
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
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/ping', (req, res) => {
    res.json({
        status: 'ok',
        cachedGroupsCount: scheduleCache.size,
        lastCacheUpdate,
        memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024)
    });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    syncAllDataFromNovsu();
});
