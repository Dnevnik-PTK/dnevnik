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

// Извлекаем все ссылки <a> со страницы
function extractLinksFromHtml(html, baseUrl) {
    const links = [];
    const regex = /<a\s+[^>]*href=["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = regex.exec(html)) !== null) {
        const rawHref = m[1].replace(/&amp;/g, '&').trim();
        const text = m[2].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
        if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:')) continue;
        try {
            const fullUrl = new URL(rawHref, baseUrl).href;
            links.push({ href: rawHref, url: fullUrl, text });
        } catch (e) {}
    }
    return links;
}

// Получаем ТОЛЬКО последние 5 файлов замен (строго с датой ДД.ММ.ГГ в названии)
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
            files.push({
                title: link.text,
                url: link.url,
                timestamp: timestamp
            });
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
            if (files.length === 0) {
                return res.status(404).json({ error: 'Файлы замен на странице НовГУ не найдены' });
            }
            targetUrl = files[0].url;
            fileTitle = files[0].title;
        }

        const fileRes = await fetch(targetUrl, { headers: BROWSER_HEADERS });
        if (!fileRes.ok) throw new Error(`Не удалось скачать файл замен (${fileRes.status})`);

        const arrayBuffer = await fileRes.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('X-File-Title', encodeURIComponent(fileTitle));
        res.send(buffer);
    } catch (error) {
        res.status(500).json({ error: 'Ошибка загрузки замен: ' + error.message });
    }
});

// Умный поиск столбца группы внутри книги Excel
function findGroupInWorkbook(workbook, targetGroup, linkText) {
    const cleanTarget = targetGroup.replace(/\s+/g, '');

    for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
        const merges = sheet['!merges'] || [];
        if (rows.length < 5) continue;

        // 1. Ищем ячейку, где содержится номер нашей группы (например "5952", "гр. 5952", "5952 ")
        for (let r = 0; r < Math.min(35, rows.length); r++) {
            const row = rows[r] || [];
            for (let c = 0; c < row.length; c++) {
                const cellText = String(row[c] || '').replace(/\s+/g, '');
                if (cellText === cleanTarget || cellText.includes(cleanTarget)) {
                    // Проверяем, что под этой ячейкой или рядом действительно идет расписание (дни недели)
                    let hasDaysBelow = false;
                    for (let rr = r + 1; rr < Math.min(r + 15, rows.length); rr++) {
                        const rowStr = (rows[rr] || []).join(' ').toLowerCase();
                        if (/понедельник|вторник|среда|8[\.:]30|10[\.:]20/.test(rowStr)) {
                            hasDaysBelow = true;
                            break;
                        }
                    }
                    if (hasDaysBelow) {
                        return {
                            rows,
                            merges,
                            groupColIdx: c,
                            headerRowIdx: r,
                            sheet: sheetName
                        };
                    }
                }
            }
        }

        // 2. Если ссылка называлась ТОЧНО "5952" (файл на одну группу), а внутри шапки номер не вписан — ищем строку с "понедельник"
        if (String(linkText).trim() === cleanTarget) {
            for (let r = 0; r < Math.min(25, rows.length); r++) {
                const row = rows[r] || [];
                const c0 = String(row[0] || '').trim().toLowerCase();
                if (c0 === 'понедельник') {
                    // В стандартном шаблоне НовГУ: 0 = день, 1 = время, 2 = предмет
                    const headerRow = Math.max(0, r - 1);
                    if (!rows[headerRow]) rows[headerRow] = [];
                    rows[headerRow][2] = targetGroup;
                    return {
                        rows,
                        merges,
                        groupColIdx: 2,
                        headerRowIdx: headerRow,
                        sheet: sheetName
                    };
                }
            }
        }
    }
    return null;
}

// 3. Поиск и разбор расписания группы с сайта НовГУ (.xls / .xlsx)
app.get('/api/schedule/:group', async (req, res) => {
    try {
        const targetGroup = String(req.params.group || '').trim();
        if (!targetGroup) return res.status(400).json({ error: 'Не указан номер группы' });

        const urlsToScan = [
            'https://portal.novsu.ru/univer/timetable/spo/',
            'https://portal.novsu.ru/univer/timetable/spo/i.1473214/?id=2445999'
        ];

        const exactLinks = [];
        const partialLinks = [];
        const subPagesToScan = [];
        const seenUrls = new Set();

        const groupWordRegex = new RegExp(`(^|\\D)${targetGroup}(\\D|$)`);

        async function collectLinksFromPage(pageUrl) {
            const pageRes = await fetch(pageUrl, { headers: BROWSER_HEADERS });
            if (!pageRes.ok) return;
            const html = await pageRes.text();
            const links = extractLinksFromHtml(html, pageUrl);

            for (const link of links) {
                const decodedUrl = decodeURIComponent(link.url);
                // Если на главной странице СПО есть ссылки на подстраницы колледжей (i.1473214/?id=...)
                if (/univer\/timetable\/spo\/i\./i.test(link.url) && !/\.(xls|xlsx|doc|docx|pdf)($|\?)/i.test(link.url)) {
                    if (!urlsToScan.includes(link.url) && !subPagesToScan.includes(link.url)) {
                        subPagesToScan.push(link.url);
                    }
                }

                if (link.text.trim() === targetGroup) {
                    if (!seenUrls.has(link.url)) {
                        exactLinks.push(link);
                        seenUrls.add(link.url);
                    }
                } else if (groupWordRegex.test(link.text) || groupWordRegex.test(decodedUrl)) {
                    if (!seenUrls.has(link.url)) {
                        partialLinks.push(link);
                        seenUrls.add(link.url);
                    }
                }
            }
        }

        for (const u of urlsToScan) {
            try { await collectLinksFromPage(u); } catch (e) {}
        }

        // Если на первых двух страницах не нашли, проверяем подстраницы других колледжей СПО
        if (exactLinks.length === 0 && partialLinks.length === 0) {
            for (const subUrl of subPagesToScan.slice(0, 6)) {
                try { await collectLinksFromPage(subUrl); } catch (e) {}
            }
        }

        const candidateLinks = [...exactLinks, ...partialLinks];
        if (candidateLinks.length === 0) {
            return res.status(404).json({ error: `Ссылка для группы ${targetGroup} не найдена на сайте НовГУ` });
        }

        for (const cand of candidateLinks) {
            try {
                const fileRes = await fetch(cand.url, { headers: BROWSER_HEADERS });
                if (!fileRes.ok) continue;

                const contentType = (fileRes.headers.get('content-type') || '').toLowerCase();
                const arrayBuffer = await fileRes.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);

                // Проверяем, не скачалась ли HTML-веб-страница вместо бинарного Excel-файла
                const firstBytes = buffer.slice(0, 100).toString('utf8').trim().toLowerCase();
                if (contentType.includes('text/html') || firstBytes.startsWith('<!doctype') || firstBytes.startsWith('<html')) {
                    // Проваливаемся внутрь этой страницы и ищем прямую ссылку на .xls / .xlsx файл!
                    const innerHtml = buffer.toString('utf8');
                    const innerLinks = extractLinksFromHtml(innerHtml, cand.url);
                    for (const inner of innerLinks) {
                        if (/\.(xlsx?|xls)($|\?)/i.test(inner.url) || groupWordRegex.test(inner.text) || /\/file\/\d+/i.test(inner.url)) {
                            if (!seenUrls.has(inner.url)) {
                                candidateLinks.push(inner);
                                seenUrls.add(inner.url);
                            }
                        }
                    }
                    continue;
                }

                const workbook = XLSX.read(buffer, { type: 'buffer' });
                const result = findGroupInWorkbook(workbook, targetGroup, cand.text);

                if (result) {
                    // Гарантируем, что в ячейке заголовка стоит точный номер группы для клиента
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

        return res.status(404).json({ error: `Группа ${targetGroup} не найдена в файлах расписания НовГУ` });
    } catch (error) {
        res.status(500).json({ error: 'Ошибка сервера: ' + error.message });
    }
});

app.get('/', (req, res) => {
    res.send('PTK Diary Server v4.2 is Live!');
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
