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
    next();
});

// Извлекаем все ссылки <a> со страницы НовГУ (даже если href без кавычек)
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

// Замены (.docx) — строго последние 5 файлов с датой ДД.ММ.ГГ в названии
async function getReplacementFilesList() {
    const pageUrl = 'https://portal.novsu.ru/univer/timetable/spo/i.1473214/?id=2445999';
    const response = await fetch(pageUrl, { headers: BROWSER_HEADERS });
    if (!response.ok) throw new Error(`Портал НовГУ ответил кодом ${response.status}`);
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

// 1. Список последних 5 файлов замен
app.get('/api/changes-list', async (req, res) => {
    try {
        const files = await getReplacementFilesList();
        res.json({ files });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 2. Скачивание файла замен (.docx)
app.get('/api/changes', async (req, res) => {
    try {
        let targetUrl = req.query.url;
        let fileTitle = req.query.title || 'changes.docx';

        if (!targetUrl) {
            const files = await getReplacementFilesList();
            if (files.length === 0) return res.status(404).json({ error: 'Файлы замен не найдены' });
            targetUrl = files[0].url;
            fileTitle = files[0].title;
        }

        const fileRes = await fetch(targetUrl, { headers: BROWSER_HEADERS });
        if (!fileRes.ok) throw new Error(`Не удалось скачать файл (${fileRes.status})`);

        const arrayBuffer = await fileRes.arrayBuffer();
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('X-File-Title', encodeURIComponent(fileTitle));
        res.send(Buffer.from(arrayBuffer));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Поиск столбца нужной группы внутри скачанной книги Excel (.xls / .xlsx)
function findGroupInWorkbook(workbook, targetGroup) {
    const cleanTarget = targetGroup.replace(/\s+/g, '');

    for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
        const merges = sheet['!merges'] || [];
        if (rows.length < 4) continue;

        // 1. Ищем ячейку, где написан номер нашей группы (например "5952")
        for (let r = 0; r < Math.min(35, rows.length); r++) {
            const row = rows[r] || [];
            for (let c = 0; c < row.length; c++) {
                const cellVal = String(row[c] || '').replace(/\s+/g, '');
                if (cellVal === cleanTarget || cellVal.includes(cleanTarget)) {
                    return { rows, merges, groupColIdx: c, headerRowIdx: r, sheet: sheetName };
                }
            }
        }

        // 2. Если книга скачалась по прямой ссылке группы (на 1 группу), а шапка без номера — ищем строку "понедельник"
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

// 3. Точечный поиск и разбор расписания группы с сайта НовГУ
app.get('/api/schedule/:group', async (req, res) => {
    try {
        const targetGroup = String(req.params.group || '').trim();
        if (!targetGroup) return res.status(400).json({ error: 'Не указан номер группы' });

        // Сканируем обе страницы расписаний СПО НовГУ
        const pagesToScan = [
            'https://portal.novsu.ru/univer/timetable/spo/i.1473214/?id=2445999',
            'https://portal.novsu.ru/univer/timetable/spo/'
        ];

        const exactGroupLinks = [];
        const neighborGroupLinks = [];
        const collegeSubPages = [];
        const seenUrls = new Set();

        const exactRegex = new RegExp(`(^|\\D)${targetGroup}(\\D|$)`);
        const prefix3 = targetGroup.slice(0, 3);
        const prefixRegex = new RegExp(`(^|\\D)${prefix3}\\d(\\D|$)`);

        async function scanPage(pageUrl) {
            const r = await fetch(pageUrl, { headers: BROWSER_HEADERS });
            if (!r.ok) return;
            const html = await r.text();
            const links = extractLinksFromHtml(html, pageUrl);

            for (const link of links) {
                const decodedUrl = decodeURIComponent(link.url);
                const combinedText = `${link.text} ${decodedUrl}`;

                // Пропускаем файлы замен с датами вида 21.10.2026
                if (/\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/.test(link.text)) continue;

                // 1. Точное совпадение номера группы в тексте ссылки или в URL (например "5952" или "5951 5952 5953.xls")
                if (link.text.trim() === targetGroup || exactRegex.test(combinedText)) {
                    if (!seenUrls.has(link.url)) {
                        exactGroupLinks.push(link);
                        seenUrls.add(link.url);
                    }
                }
                // 2. Ссылка на соседние группы того же потока (например "5951" когда ищем "5952")
                else if (prefix3.length === 3 && prefixRegex.test(combinedText)) {
                    if (!seenUrls.has(link.url)) {
                        neighborGroupLinks.push(link);
                        seenUrls.add(link.url);
                    }
                }
                // 3. Ссылки на подстраницы других колледжей СПО
                else if (/univer\/timetable\/spo\/i\./i.test(link.url) && !pagesToScan.includes(link.url)) {
                    if (!collegeSubPages.includes(link.url)) collegeSubPages.push(link.url);
                }
            }
        }

        for (const url of pagesToScan) {
            try { await scanPage(url); } catch (e) {}
        }

        // Если на главных страницах не нашли, заглядываем в подстраницы колледжей
        if (exactGroupLinks.length === 0 && neighborGroupLinks.length === 0) {
            for (const subUrl of collegeSubPages.slice(0, 5)) {
                try { await scanPage(subUrl); } catch (e) {}
            }
        }

        const candidates = [...exactGroupLinks, ...neighborGroupLinks];
        if (candidates.length === 0) {
            return res.status(404).json({
                error: `Группа ${targetGroup} не найдена в списке ссылок на сайте НовГУ`
            });
        }

        const checkedFiles = [];

        for (const cand of candidates) {
            try {
                const fileRes = await fetch(cand.url, { headers: BROWSER_HEADERS });
                if (!fileRes.ok) continue;

                const arrayBuffer = await fileRes.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);

                // Если по ссылке открылась HTML-страница, ищем внутри неё прямые ссылки на .xls файлы
                const headStr = buffer.slice(0, 120).toString('utf8').trim().toLowerCase();
                if (headStr.startsWith('<!doctype') || headStr.startsWith('<html')) {
                    const innerLinks = extractLinksFromHtml(buffer.toString('utf8'), cand.url);
                    for (const inner of innerLinks) {
                        const decInner = decodeURIComponent(inner.url);
                        if (exactRegex.test(`${inner.text} ${decInner}`) || /\.(xlsx?|xls)($|\?)/i.test(inner.url)) {
                            if (!seenUrls.has(inner.url)) {
                                candidates.push(inner);
                                seenUrls.add(inner.url);
                            }
                        }
                    }
                    continue;
                }

                checkedFiles.push(cand.text || cand.url.split('/').pop());
                const workbook = XLSX.read(buffer, { type: 'buffer' });
                const result = findGroupInWorkbook(workbook, targetGroup);

                if (result) {
                    if (!result.rows[result.headerRowIdx]) result.rows[result.headerRowIdx] = [];
                    result.rows[result.headerRowIdx][result.groupColIdx] = targetGroup;

                    return res.json({
                        group: targetGroup,
                        sheet: result.sheet,
                        fileName: cand.text || result.sheet,
                        rows: result.rows,
                        merges: result.merges,
                        groupColIdx: result.groupColIdx,
                        headerRowIdx: result.headerRowIdx
                    });
                }
            } catch (e) {}
        }

        return res.status(404).json({
            error: `Проверены файлы (${checkedFiles.join(', ') || '0'}), но таблица группы ${targetGroup} не распознана`
        });
    } catch (error) {
        res.status(500).json({ error: 'Ошибка сервера: ' + error.message });
    }
});

app.get('/', (req, res) => {
    res.send('PTK Server v4.3 is Live!');
});

app.listen(PORT, () => {
    console.log(`Server v4.3 is running on port ${PORT}`);
});
