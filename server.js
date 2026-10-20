const express = require('express');
const fetch = require('node-fetch');
const XLSX = require('xlsx');
const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    next();
});

// Эндпоинт для замен: автоматически находит и скачивает самый свежий .docx с сайта НовГУ
app.get('/api/changes', async (req, res) => {
    try {
        // Заходим на страницу замен СПО НовГУ
        const pageRes = await fetch('https://portal.novsu.ru/univer/timetable/spo/i.1473214//?id=2445999');
        const html = await pageRes.text();
        
        // Ищем абсолютно любую ссылку на .docx файл на странице
        const regex = /href="([^"]+\.docx(\?[^"]*)?)"/gi;
        let match;
        let docxUrl = '';

        while ((match = regex.exec(html)) !== null) {
            let link = match[1];
            if (link.startsWith('/')) link = 'https://portal.novsu.ru' + link;
            docxUrl = link; // Берем найденную ссылку (обычно актуальная идет первой или последней)
        }

        if (!docxUrl) {
            return res.status(404).send('На странице замен НовГУ не найдено ни одного файла .docx');
        }

        // Скачиваем свежий файл замен
        const docxRes = await fetch(docxUrl);
        const buffer = await docxRes.buffer();

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.send(buffer);
    } catch (error) {
        res.status(500).send('Ошибка сервера при получении замен: ' + error.message);
    }
});

// Эндпоинт для расписания (.xlsx)
app.get('/api/schedule/:group', async (req, res) => {
    try {
        const targetGroup = req.params.group;
        const pageRes = await fetch('https://portal.novsu.ru/univer/timetable/spo/');
        const html = await pageRes.text();
        
        const regex = /href="([^"]+\.xlsx(\?[^"]*)?)"/gi;
        let match;
        let excelUrls = [];

        while ((match = regex.exec(html)) !== null) {
            let link = match[1];
            if (link.startsWith('/')) link = 'https://portal.novsu.ru' + link;
            excelUrls.push(link);
        }

        if (excelUrls.length === 0) {
            return res.status(404).json({ error: 'Ссылки на расписание (.xlsx) не найдены' });
        }

        let foundData = null;
        let sheetNameFound = '';

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

                if (foundData) break;
            } catch (err) {}
        }

        if (!foundData) {
            return res.status(404).json({ error: `Группа ${targetGroup} не найдена в расписании` });
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
