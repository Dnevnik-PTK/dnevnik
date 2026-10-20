const express = require('express');
const fetch = require('node-fetch');
const XLSX = require('xlsx');
const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    next();
});

// 1. Эндпоинт для замен (.docx)
app.get('/api/changes', async (req, res) => {
    try {
        const pageRes = await fetch('https://portal.novsu.ru/univer/timetable/spo/i.1473214//?id=2445999');
        const html = await pageRes.text();
        const match = html.match(/href="([^"]+\.docx)"/i);
        if (!match) return res.status(404).send('Файл замен не найден');
        
        let docxUrl = match[1];
        if (docxUrl.startsWith('/')) docxUrl = 'https://portal.novsu.ru' + docxUrl;

        const docxRes = await fetch(docxUrl);
        const buffer = await docxRes.buffer();
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.send(buffer);
    } catch (error) {
        res.status(500).send('Ошибка сервера: ' + error.message);
    }
});

// 2. Эндпоинт для расписания (автоматически качает свежий .xlsx с сайта НовГУ)
app.get('/api/schedule/:group', async (req, res) => {
    try {
        const targetGroup = req.params.group;
        
        // Страница расписания ПТК на портале НовГУ (или общая страница расписаний)
        const pageRes = await fetch('https://portal.novsu.ru/univer/timetable/spo/');
        const html = await pageRes.text();
        
        // Ищем ссылку на актуальный файл расписания (.xlsx) на странице
        const match = html.match(/href="([^"]+\.xlsx)"/i);
        if (!match) return res.status(404).json({ error: 'Ссылка на файл расписания на сайте не найдена' });

        let excelUrl = match[1];
        if (excelUrl.startsWith('/')) excelUrl = 'https://portal.novsu.ru' + excelUrl;

        // Скачиваем свежий Excel-файл расписания с сайта
        const excelRes = await fetch(excelUrl);
        const arrayBuffer = await excelRes.arrayBuffer();
        const workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array' });

        let foundData = null;
        let sheetNameFound = '';

        workbook.SheetNames.forEach(sheetName => {
            const sheet = workbook.Sheets[sheetName];
            const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
            const merges = sheet['!merges'] || [];

            for (let r = 0; r < Math.min(15, rows.length); r++) {
                for (let c = 0; c < rows[r].length; c++) {
                    let val = String(rows[r][c] || '').trim();
                    if (val === targetGroup) {
                        foundData = { rows, merges, groupColIdx: c, headerRowIdx: r };
                        sheetNameFound = sheetName;
                    }
                }
            }
        });

        if (!foundData) {
            return res.status(404).json({ error: `Группа ${targetGroup} не найдена в текущем расписании вуза` });
        }

        res.json({ group: targetGroup, sheet: sheetNameFound, ...foundData });
    } catch (error) {
        res.status(500).json({ error: 'Ошибка получения расписания: ' + error.message });
    }
});

app.get('/', (req, res) => {
    res.send('PTK Server is running!');
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
