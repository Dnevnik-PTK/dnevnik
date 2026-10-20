const express = require('express');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 3000;

// Разрешаем сайту обращаться к нашему серверу
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    next();
});

// Маршрут, через который приложение будет забирать замены
app.get('/api/changes', async (req, res) => {
    try {
        const targetUrl = 'https://portal.novsu.ru/univer/timetable/spo/i.1473214//?id=2445999';
        const response = await fetch(targetUrl);
        const html = await response.text();
        res.send(html);
    } catch (error) {
        res.status(500).send('Ошибка при получении данных с портала НовГУ: ' + error.message);
    }
});

// Пингулка, чтобы Render не засыпал
app.get('/', (req, res) => {
    res.send('PTK Server is running!');
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
