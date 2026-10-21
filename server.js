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
        // Берем ТОЛЬКО те ссылки, в тексте которых есть дата вида 21.10.2026 или 13.10.26 (отсекаем номера групп вроде 6901, 5911)
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

    // Сортируем от самой свежей даты к старым и оставляем ТОЛЬКО последние 5 дней
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

// 3. Поиск и разбор расписания группы с сайта НовГУ (.xls / .xlsx)
app.get('/api/schedule/:group', async (req, res) => {
    try {
        const targetGroup = String(req.params.group || '').trim();
        if (!targetGroup) return res.status(400).json({ error: 'Не указан номер группы' });

        // Проверяем обе страницы СПО на всякий случай
        const urlsToScan = [
            'https://portal.novsu.ru/univer/timetable/spo/',
            'https://portal.novsu.ru/univer/timetable/spo/i.1473214/?id=2445999'
        ];

        const exactLinks = [];
        const partialLinks = [];
        const seenUrls = new Set();

        const groupWordRegex = new RegExp(`(^|\\D)${targetGroup}(\\D|$)`);

        for (const pageUrl of urlsToScan) {
            try {
                const pageRes = await fetch(pageUrl, { headers: BROWSER_HEADERS });
                if (!pageRes.ok) continue;
                const html = await pageRes.text();
                const links = extractLinksFromHtml(html, pageUrl);

                for (const link of links) {
                    const decodedUrl = decodeURIComponent(link.url);
                    // Если текст ссылки в точности равен номеру группы (например "5952")
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
            } catch (e) {}
        }

        const candidateLinks = [...exactLinks, ...partialLinks];
        if (candidateLinks.length === 0) {
            return res.status(404).json({ error: `Группа ${targetGroup} не найдена в списке расписаний на сайте НовГУ` });
        }

        let foundData = null;
        let sheetNameFound = '';
        let fileTitleFound = '';

        for (const cand of candidateLinks) {
            try {
                const excelRes = await fetch(cand.url, { headers: BROWSER_HEADERS });
                if (!excelRes.ok) continue;
                const arrayBuffer = await excelRes.arrayBuffer();
                const workbook = XLSX.read(Buffer.from(arrayBuffer), { type: 'buffer' });

                for (const sheetName of workbook.SheetNames) {
                    const sheet = workbook.Sheets[sheetName];
                    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
                    const merges = sheet['!merges'] || [];

                    for (let r = 0; r < Math.min(30, rows.length); r++) {
                        const row = rows[r] || [];
                        for (let c = 0; c < row.length; c++) {
                            const val = String(row[c] || '').trim();
                            // Ищем точное совпадение "5952" или запись вида "гр. 5952" в шапке
                            if (val === targetGroup || groupWordRegex.test(val)) {
                                foundData = { rows, merges, groupColIdx: c, headerRowIdx: r };
                                sheetNameFound = sheetName;
                                fileTitleFound = cand.text || sheetName;
                                break;
                            }
                        }
                        if (foundData) break;
                    }
                    if (foundData) break;
                }
                if (foundData) break;
            } catch (e) {}
        }

        if (!foundData) {
            return res.status(404).json({ error: `Файл для группы ${targetGroup} скачан, но столбец группы внутри таблицы не найден` });
        }

        res.json({
            group: targetGroup,
            sheet: sheetNameFound,
            fileName: fileTitleFound,
            ...foundData
        });
    } catch (error) {
        res.status(500).json({ error: 'Ошибка сервера: ' + error.message });
    }
});

app.get('/', (req, res) => {
    res.send('PTK Diary Server v4.1 is Live!');
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
