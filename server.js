const express = require('express');
const fetch = require('node-fetch');
const XLSX = require('xlsx');
const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    next();
});

// Эндпоинт для замен (.docx)
app.get('/api/changes', async (req, res) => {
    try {
        const pageRes = await fetch('https://portal.novsu.ru/univer/timetable/spo/i.1473214//?id=2445999');
        const html = await pageRes.text();
        
        const matches = html.match(/href="([^"]+\.docx(\?[^"]*)?)"/i);
        if (!matches) return res.status(404).send('Файл замен (.docx) не найден');
        
        let docxUrl = matches[1];
        if (docxUrl.startsWith('/')) docxUrl = 'https://portal.novsu.ru' + docxUrl;

        const docxRes = await fetch(docxUrl);
        const buffer = await docxRes.buffer();
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.send(buffer);
    } catch (error) {
        res.status(500).send('Ошибка сервера: ' + error.message);
    }
});

// Эндпоинт для расписания (.xlsx)
app.get('/api/schedule/:group', async (req, res) => {
    try {
        const targetGroup = req.params.group;
        
        // 1. Пробуем получить страницу расписаний СПО НовГУ
        const pageRes = await fetch('https://portal.novsu.ru/univer/timetable/spo/');
        const html = await pageRes.text();
        
        // Ищем все ссылки на .xlsx файлы
        const regex = /href="([^"]+\.xlsx(\?[^"]*)?)"/gi;
        let match;
        let excelUrls = [];

        while ((match = regex.exec(html)) !== null) {
            let link = match[1];
            if (link.startsWith('/')) link = 'https://portal.novsu.ru' + link;
            excelUrls.push(link);
        }

        // Если на странице ничего не нашлось, используем прямой поиск по известным путям или заглушку
        if (excelUrls.length === 0) {
            return res.status(404).json({ error: 'На странице НовГУ не найдены файлы расписания (.xlsx)' });
        }

        let foundData = null;
        let sheetNameFound = '';

        // Проходим по найденным экселькам с сайта (обычно свежий файл первый или содержит ключевые слова)
        for (let excelUrl of excelUrls) {
            try {
                const excelRes = await fetch(excelUrl);
                if (!excelRes.ok) continue;
                const arrayBuffer = await excelRes.arrayBuffer();
                const workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array' });

                workbook.SheetNames.forEach(sheetName => {
                    const sheet = workbook.Sheets[sheetName];
                    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
                    const merges = sheet['!merges'] || [];

                    for (let r = 0; r < rows.length; r++) {
                        for (let c = 0; c < (rows[r] || []).length; c++) {
                            let val = String(rows[r][c] || '').trim();
                            if (val === targetGroup) {
                                foundData = { rows, merges, groupColIdx: c, headerRowIdx: r };
                                sheetNameFound = sheetName;
                            }
                        }
                    }
                });

                if (foundData) break; // Нашли группу — прекращаем перебор файлов
            } catch (err) {
                // Пропускаем битые ссылки и идем дальше
            }
        }

        if (!foundData) {
            return res.status(404).json({ error: `Группа ${targetGroup} не найдена ни в одном файле расписания НовГУ` });
        }

        res.json({ group: targetGroup, sheet: sheetNameFound, ...foundData });
    } catch (error) {
        res.status(500).json({ error: 'Ошибка сервера: ' + error.message });
    }
});

app.get('/', (req, res) => {
    res.send('PTK Server is running!');
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
