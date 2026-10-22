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
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// ================= НАДЁЖНЫЙ ПРОКСИ-АПЛОАДЕР В ОБЛАКО =================
app.post('/api/upload', express.raw({ type: '*/*', limit: '100mb' }), async (req, res) => {
    try {
        if (!req.body || req.body.length === 0) {
            return res.status(400).json({ error: 'Файл не передан' });
        }

        const originalName = decodeURIComponent(req.query.filename || 'material.pdf');
        const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);

        const pre = Buffer.from(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="reqtype"\r\n\r\n` +
            `fileupload\r\n` +
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="fileToUpload"; filename="${originalName}"\r\n` +
            `Content-Type: application/octet-stream\r\n\r\n`
        );
        const post = Buffer.from(`\r\n--${boundary}--\r\n`);
        const fullBody = Buffer.concat([pre, req.body, post]);

        const uploadRes = await fetch('https://catbox.moe/user/api.php', {
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'User-Agent': BROWSER_HEADERS['User-Agent']
            },
            body: fullBody
        });

        if (!uploadRes.ok) {
            throw new Error(`Хранилище ответило статусом ${uploadRes.status}`);
        }

        const fileUrl = (await uploadRes.text()).trim();
        if (!fileUrl.startsWith('http')) {
            throw new Error(fileUrl || 'Сбой получения ссылки из хранилища');
        }

        res.json({ success: true, url: fileUrl });
    } catch (err) {
        console.error('[UPLOAD ERROR]', err.message);
        res.status(500).json({ error: 'Ошибка загрузки в облако: ' + err.message });
    }
});

// ================= СКВОЗНОЕ ТРАНЗИТНОЕ СКАЧИВАНИЕ (STREAM PASS-THROUGH) =================
// Забирает файл из заблокированного облака и потоком передаёт клиенту (ноль нагрузки на память Render)
app.get('/api/download', async (req, res) => {
    try {
        const fileUrl = req.query.url;
        let fileName = req.query.filename || 'material.pdf';

        if (!fileUrl) {
            return res.status(400).send('Ссылка на файл не указана');
        }

        const response = await fetch(fileUrl, { headers: BROWSER_HEADERS });
        if (!response.ok) {
            throw new Error(`Облако ответило кодом ${response.status}`);
        }

        if (!/\.[a-zA-Z0-9]+$/.test(fileName)) {
            const ext = fileUrl.split('.').pop().split(/[?#]/)[0];
            if (ext && ext.length <= 5) fileName += '.' + ext;
        }

        res.setHeader('Content-Type', response.headers.get('content-type') || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);

        // Потоковая сквозная передача байтов (в памяти сервера ничего не оседает)
        response.body.pipe(res);

        res.on('close', () => {
            if (response.body && response.body.destroy) response.body.destroy();
        });
    } catch (e) {
        console.error('[DOWNLOAD ERROR]', e.message);
        res.status(500).send('Ошибка скачивания: ' + e.message);
    }
});

app.use(express.json());

// ================= КЭШ И ХРАНИЛИЩА =================
const scheduleCache = new Map();
let changesListCache = [];
const changesBufferCache = new Map();
let lastCacheUpdate = null;
let isSyncing = false;

// Одноразовые ключи для старост (key -> groupName)
const starostaOneTimeKeys = new Map();
// Сессии авторизованных старост (groupName -> sessionToken)
const starostaSessions = new Map();
// Задания групп (groupName -> Array of tasks)
const groupTasksStorage = new Map();
// Учебники и материалы групп (groupName -> Array of materials)
const groupMaterialsStorage = new Map();

// Сессии подтверждённых админов
const adminSessions = new Set();

function generateRandomCode(len = 6) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let res = '';
    for (let i = 0; i < len; i++) res += chars.charAt(Math.floor(Math.random() * chars.length));
    return res;
}

let currentRootOneTimeKey = `ROOT-${generateRandomCode(8)}`;
console.log('====================================================');
console.log('🔑 ОДНОРАЗОВЫЙ КЛЮЧ СОЗДАТЕЛЯ ДЛЯ ВХОДА В АДМИНКУ:');
console.log(currentRootOneTimeKey);
console.log('====================================================');

// 1. АВТОРИЗАЦИЯ СОЗДАТЕЛЯ
app.post('/api/admin/auth', (req, res) => {
    const { rootKey } = req.body || {};
    const cleanKey = String(rootKey || '').trim();

    if (!currentRootOneTimeKey || cleanKey !== currentRootOneTimeKey) {
        return res.status(403).json({ error: 'Одноразовый ключ создателя недействителен или уже сгорел' });
    }

    currentRootOneTimeKey = null;
    const adminToken = `ADMIN-${generateRandomCode(20)}`;
    adminSessions.add(adminToken);

    res.json({ success: true, adminToken });
});

// 2. ВЫПУСК ОДНОРАЗОВОГО КЛЮЧА ДЛЯ СТАРОСТЫ
app.post('/api/admin/generate-starosta-key', (req, res) => {
    const { adminToken, group } = req.body || {};
    if (!adminSessions.has(adminToken)) {
        return res.status(403).json({ error: 'Сессия администратора не подтверждена' });
    }
    const cleanGroup = String(group || '').trim();
    if (!cleanGroup) return res.status(400).json({ error: 'Укажите номер группы' });

    const key = `KEY-${cleanGroup}-${generateRandomCode(6)}`;
    starostaOneTimeKeys.set(key, cleanGroup);

    res.json({ success: true, group: cleanGroup, key });
});

// 3. СБРОС СТАРОСТЫ ГРУППЫ
app.post('/api/admin/revoke-starosta', (req, res) => {
    const { adminToken, group } = req.body || {};
    if (!adminSessions.has(adminToken)) {
        return res.status(403).json({ error: 'Доступ запрещён' });
    }
    const cleanGroup = String(group || '').trim();
    starostaSessions.delete(cleanGroup);
    res.json({ success: true, message: `Староста группы ${cleanGroup} сброшен` });
});

// 4. АВТОРИЗАЦИЯ СТАРОСТЫ
app.post('/api/tasks/auth', (req, res) => {
    const { secretKey } = req.body || {};
    const cleanKey = String(secretKey || '').trim();

    if (!starostaOneTimeKeys.has(cleanKey)) {
        return res.status(403).json({ error: 'Одноразовый ключ недействителен или уже был активирован' });
    }

    const group = starostaOneTimeKeys.get(cleanKey);
    starostaOneTimeKeys.delete(cleanKey);

    const sessionToken = `STAROSTA-${group}-${generateRandomCode(16)}`;
    starostaSessions.set(group, sessionToken);

    res.json({ success: true, group, sessionToken });
});

// 5. ЗАДАНИЯ ГРУППЫ
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

    groupTasksStorage.get(group).unshift(newTask);
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
    }

    res.json({ success: true });
});

// 6. УЧЕБНИКИ И МАТЕРИАЛЫ ГРУППЫ
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
        fileName: String(material.fileName || 'Файл').trim(),
        fileSize: String(material.fileSize || '').trim(),
        isDirectUpload: Boolean(material.isDirectUpload),
        author: 'Староста',
        createdAt: new Date().toISOString()
    };

    groupMaterialsStorage.get(group).unshift(newMaterial);
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
    }

    res.json({ success: true });
});

// ================= РАСПИСАНИЕ И ЗАМЕНЫ =================
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
    res.json({ status: 'ok', cachedGroupsCount: scheduleCache.size, lastCacheUpdate });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    syncAllDataFromNovsu();
});
