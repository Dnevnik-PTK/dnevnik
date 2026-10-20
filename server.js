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

// Вспомогательная функция извлечения всех ссылок <a> со страницы НовГУ
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

// Вспомогательная функция поиска файлов замен на странице НовГУ
async function getReplacementFilesList() {
    const pageUrl = 'https://portal.novsu.ru/univer/timetable/spo/i.1473214/?id=2445999';
    const response = await fetch(pageUrl, { headers: BROWSER_HEADERS });
    if (!response.ok) throw new Error(`Портал НовГУ ответил кодом ${response.status}`);
    const html = await response.text();

    const allLinks = extractLinksFromHtml(html, pageUrl);
    const files = [];

    for (const link of allLinks) {
        const isDocFile = /\.(docx?|xlsx?)(?:$|\?)/i.test(link.url) || /\.(docx?|xlsx?)/i.test(link.text);
        const isDateNamed = /\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/.test(link.text) || /\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/.test(link.href);
        const isNovsuFileId = /\/file\/\d+/i.test(link.url) && (isDateNamed || /замен|изменен|расписан/i.test(link.text));

        if (isDocFile || (isDateNamed && !/univer\/timetable\/(ochn|zaochn|session|spo\/?$)/i.test(link.url)) || isNovsuFileId) {
            if (!files.some(f => f.url === link.url)) {
                files.push({
                    title: link.text || link.url.split('/').pop(),
                    url: link.url
                });
            }
        }
    }

    // Сортируем найденные файлы по дате в названии (например 21.10.2026), чтобы самый свежий был первым
    files.sort((a, b) => {
        const parseDate = (str) => {
            const dm = String(str).match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
            if (!dm) return 0;
            const d = parseInt(dm[1], 10);
            const m = parseInt(dm[2], 10) - 1;
            let y = parseInt(dm[3], 10);
            if (y < 100) y += 2000;
            return new Date(y, m, d).getTime();
        };
        return parseDate(b.title) - parseDate(a.title);
    });

    return files;
}

// 1. Список всех доступных файлов замен (на сегодня / на завтра)
app.get('/api/changes-list', async (req, res) => {
    try {
        const files = await getReplacementFilesList();
        res.json({ files });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 2. Скачивание конкретного или самого свежего .docx файла замен
app.get('/api/changes', async (req, res) => {
    try {
        let targetUrl = req.query.url;
        let fileTitle = req.query.title || 'changes.docx';

        if (!targetUrl) {
            const files = await getReplacementFilesList();
            if (files.length === 0) {
                return res.status(404).json({ error: 'Файлы замен (.docx) на странице НовГУ не найдены' });
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

// 3. Скачивание и разбор расписания группы с сайта НовГУ (.xls / .xlsx)
app.get('/api/schedule/:group', async (req, res) => {
    try {
        const targetGroup = String(req.params.group || '').trim();
        if (!targetGroup) return res.status(400).json({ error: 'Не указан номер группы' });

        const spoUrl = 'https://portal.novsu.ru/univer/timetable/spo/';
        const pageRes = await fetch(spoUrl, { headers: BROWSER_HEADERS });
        if (!pageRes.ok) throw new Error(`Портал НовГУ недоступен (${pageRes.status})`);
        const html = await pageRes.text();

        const allLinks = extractLinksFromHtml(html, spoUrl);
        const groupRegex = new RegExp(`(^|\\D)${targetGroup}(\\D|$)`);
        const prefix3 = targetGroup.slice(0, 3);
        const prefixRegex = new RegExp(`(^|\\D)${prefix3}\\d(\\D|$)`);

        // Сначала ищем ссылку, в тексте или адресе которой прямо написана наша группа (например "5951 5952 5953")
        const candidateLinks = [];
        for (const link of allLinks) {
            if (groupRegex.test(link.text) || groupRegex.test(decodeURIComponent(link.url))) {
                candidateLinks.unshift(link); // Высший приоритет
            } else if (prefix3.length === 3 && (prefixRegex.test(link.text) || /\.xlsx?$/i.test(link.url))) {
                candidateLinks.push(link); // Запасной вариант, если 4-я группа внутри файла соседних групп
            }
        }

        if (candidateLinks.length === 0) {
            return res.status(404).json({ error: `Ссылка на расписание для группы ${targetGroup} не найдена на сайте НовГУ` });
        }

        let foundData = null;
        let sheetNameFound = '';
        let fileTitleFound = '';

        // Проверяем найденные кандидаты (обычно срабатывает самый первый файл за 0.5 сек)
        for (const cand of candidateLinks.slice(0, 5)) {
            try {
                const excelRes = await fetch(cand.url, { headers: BROWSER_HEADERS });
                if (!excelRes.ok) continue;
                const arrayBuffer = await excelRes.arrayBuffer();
                const workbook = XLSX.read(Buffer.from(arrayBuffer), { type: 'buffer' });

                for (const sheetName of workbook.SheetNames) {
                    const sheet = workbook.Sheets[sheetName];
                    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
                    const merges = sheet['!merges'] || [];

                    for (let r = 0; r < Math.min(20, rows.length); r++) {
                        for (let c = 0; c < (rows[r] || []).length; c++) {
                            const val = String(rows[r][c] || '').trim();
                            if (val === targetGroup) {
                                foundData = { rows, merges, groupColIdx: c, headerRowIdx: r };
                                sheetNameFound = sheetName;
                                fileTitleFound = cand.text || 'Расписание НовГУ';
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
            return res.status(404).json({ error: `Группа ${targetGroup} не найдена внутри таблиц расписания НовГУ` });
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
    res.send('PTK Diary Server v4.0 is Live!');
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
