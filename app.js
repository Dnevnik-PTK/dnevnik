try {
    if (window.Telegram && window.Telegram.WebApp) {
        window.Telegram.WebApp.expand();
    }
} catch (e) {}

// ================= НАСТРОЙКИ СЕРВЕРА И GOOGLE APPS SCRIPT =================
const RENDER_URL = 'https://dnevnik-1.onrender.com';
// ВСТАВЬТЕ СЮДА URL РАЗВЕРНУТОГО ВЕБ-ПРИЛОЖЕНИЯ GOOGLE APPS SCRIPT:
const GOOGLE_SCRIPT_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycby0OHCGp42wNiBPWnqxO7Z3jImgL5_qhE2s0FODcKEe65cfoaLNh6Ho6njABsbtB5aDaw/exec';

const STORAGE_MARKS_KEY = 'ptk_diary_subjects_v3';
const STORAGE_SCHED_KEY = 'ptk_diary_schedules_v6';
const STORAGE_CHANGES_KEY = 'ptk_diary_changes_v9';
const STORAGE_TASKS_KEY = 'ptk_diary_tasks_v2';
const STORAGE_THEME_KEY = 'ptk_diary_theme_v1';
const STORAGE_PERSONAL_MATS_KEY = 'ptk_diary_personal_mats_v2';
const STORAGE_STAROSTA_SESSION_KEY = 'ptk_diary_starosta_session_v3';
const STORAGE_CREATOR_PASS_KEY = 'ptk_diary_creator_pass_v1';

const DAY_NAMES_FULL = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const DAY_NAMES_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const MONTHS_GENITIVE = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

let subjects = [], activeSubjectIndex = 0;
let schedules = [], activeScheduleIndex = 0;
let currentSelectedWeek = 'upper';
let scheduleViewMode = 'day';
let selectedDayIndex = 0;
let lastActiveSection = 'schedule';
let currentTheme = 'dark';

let starostaAuth = null;
let creatorMasterPassword = localStorage.getItem(STORAGE_CREATOR_PASS_KEY) || null;

let personalMaterials = [];
let googleDriveMaterials = [];
let activeMaterialSubjectFilter = 'ALL';
let materialTarget = 'personal';
let materialInputMode = 'file';
let selectedFileBase64 = null;
let selectedFileName = '';
let selectedFileSize = '';
let selectedFileType = '';

let changesData = { dateTitle: 'Изменения в расписании', fileName: '', items: [], portalFiles: [] };
let activeChangesGroupFilter = 'ALL';
let activeChangesTypeFilter = 'ALL';

let localTasks = [];
let activeTaskFilter = 'ALL';
let taskSubTab = 'tasks';
let selectedSubjectInModal = '';

let marksViewMode = 'subjects';
let cachedSubjectSummaries = {};
let selectedGroupForMarks = '';
let tempMarksWorkbook = null, tempExcelData = null;

document.addEventListener('DOMContentLoaded', function() {
    try { subjects = JSON.parse(localStorage.getItem(STORAGE_MARKS_KEY)) || []; } catch(e) { subjects = []; }
    try { schedules = JSON.parse(localStorage.getItem(STORAGE_SCHED_KEY)) || []; } catch(e) { schedules = []; }
    try {
        const sc = JSON.parse(localStorage.getItem(STORAGE_CHANGES_KEY));
        if (sc && Array.isArray(sc.items)) changesData = sc;
    } catch(e) {}
    try { localTasks = JSON.parse(localStorage.getItem(STORAGE_TASKS_KEY)) || []; } catch(e) { localTasks = []; }
    try { personalMaterials = JSON.parse(localStorage.getItem(STORAGE_PERSONAL_MATS_KEY)) || []; } catch(e) { personalMaterials = []; }
    try { starostaAuth = JSON.parse(localStorage.getItem(STORAGE_STAROSTA_SESSION_KEY)) || null; } catch(e) { starostaAuth = null; }

    const savedTheme = localStorage.getItem(STORAGE_THEME_KEY) || 'dark';
    setAppTheme(savedTheme);

    const jsDay = new Date().getDay();
    selectedDayIndex = jsDay === 0 ? 6 : jsDay - 1;

    currentSelectedWeek = getInitialWeekType();
    updateWeekButtonsUI();
    renderWeekDaysBar();

    const known = getKnownUserGroups();
    if (known.length > 0) activeChangesGroupFilter = known[0];

    updateStarostaUI();
    updateCreatorUI();
    fetchGoogleDriveMaterials();

    if (schedules.length > 0) switchSection('schedule');
    else if (subjects.length > 0) switchSection('marks');
    else switchSection('schedule');
});

// ================= ТЕМА ОФОРМЛЕНИЯ =================
function setAppTheme(theme) {
    currentTheme = theme === 'light' ? 'light' : 'dark';
    localStorage.setItem(STORAGE_THEME_KEY, currentTheme);

    if (currentTheme === 'light') document.body.classList.add('light-theme');
    else document.body.classList.remove('light-theme');

    const btnDark = document.getElementById('btnThemeDark');
    const btnLight = document.getElementById('btnThemeLight');
    const iconEl = document.getElementById('themeIconDisplay');
    const subEl = document.getElementById('themeSubtitleDisplay');

    if (btnDark && btnLight) {
        btnDark.className = currentTheme === 'dark' ? "px-3 py-1.5 rounded-lg text-xs font-semibold transition blue-glow" : "px-3 py-1.5 rounded-lg text-xs font-medium transition text-slate-400";
        btnLight.className = currentTheme === 'light' ? "px-3 py-1.5 rounded-lg text-xs font-semibold transition blue-glow" : "px-3 py-1.5 rounded-lg text-xs font-medium transition text-slate-400";
    }
    if (iconEl) iconEl.innerText = currentTheme === 'light' ? '☀️' : '🌙';
    if (subEl) subEl.innerText = currentTheme === 'light' ? 'Активна светлая тема' : 'Активна тёмная тема';
}

function getSubjectIcon(name) {
    const s = String(name || '').toLowerCase();
    if (/матем|алгебр|геометр|дискрет/.test(s)) return 'π';
    if (/программ|алгоритм|информ|код|веб|ос|систем/.test(s)) return '</>';
    if (/физик|электро|схем|аппарат/.test(s)) return '⚛';
    if (/англ|иностр|язык/.test(s)) return 'A';
    return '📘';
}

function getKnownUserGroups() {
    const s = new Set();
    schedules.forEach(x => { if (x && x.groupName) s.add(String(x.groupName)); });
    subjects.forEach(x => { if (x && x.groupName && /^\d{4}$/.test(String(x.groupName))) s.add(String(x.groupName)); });
    return Array.from(s);
}

function getActiveGroupName() {
    const known = getKnownUserGroups();
    return known[0] || '';
}

function getInitialWeekType() {
    const now = new Date();
    const year = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
    const septFirst = new Date(year, 8, 1);
    const diffDays = Math.ceil(Math.abs(now - septFirst) / (1000 * 60 * 60 * 24));
    return (Math.ceil(diffDays / 7) % 2 !== 0) ? 'upper' : 'lower';
}

function getWeekTypeForDate(dateObj) {
    const year = dateObj.getMonth() >= 8 ? dateObj.getFullYear() : dateObj.getFullYear() - 1;
    const septFirst = new Date(year, 8, 1);
    const diffDays = Math.ceil(Math.abs(dateObj - septFirst) / (1000 * 60 * 60 * 24));
    return (Math.ceil(diffDays / 7) % 2 !== 0) ? 'upper' : 'lower';
}

function setWeekType(type) {
    currentSelectedWeek = type;
    updateWeekButtonsUI();
    loadScheduleForActive();
}

function updateWeekButtonsUI() {
    const u = document.getElementById('btnUpperWeek'), l = document.getElementById('btnLowerWeek');
    if (!u || !l) return;
    u.className = currentSelectedWeek === 'upper' ? "py-1.5 rounded-xl text-xs font-semibold transition blue-glow" : "py-1.5 rounded-xl text-xs font-medium transition text-slate-400";
    l.className = currentSelectedWeek === 'lower' ? "py-1.5 rounded-xl text-xs font-semibold transition blue-glow" : "py-1.5 rounded-xl text-xs font-medium transition text-slate-400";
}

// ================= НАВИГАЦИЯ =================
function switchSection(section) {
    lastActiveSection = section;
    const allSecs = ['scheduleSection', 'changesSection', 'tasksSection', 'marksSection', 'setupScreen', 'setupScheduleScreen', 'addTaskModal', 'addMaterialModal', 'profileSection'];
    allSecs.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
    });

    const titles = {
        schedule: 'Расписание',
        changes: 'Изменения в расписании',
        tasks: 'Задания',
        marks: 'Оценки'
    };
    if (titles[section]) document.getElementById('topScreenTitle').innerText = titles[section];

    const topProfBtn = document.getElementById('topProfileBtn');
    if (topProfBtn) topProfBtn.className = "w-9 h-9 rounded-full app-card flex items-center justify-center text-slate-300 hover:text-white active:scale-95 transition";

    const navs = { schedule: 'navScheduleBtn', changes: 'navChangesBtn', tasks: 'navTasksBtn', marks: 'navMarksBtn' };
    const actCls = "flex flex-col items-center justify-center py-1.5 rounded-2xl transition blue-glow";
    const inactCls = "flex flex-col items-center justify-center py-1.5 rounded-2xl transition text-slate-400";

    Object.keys(navs).forEach(k => {
        const btn = document.getElementById(navs[k]);
        if (btn) btn.className = (k === section) ? actCls : inactCls;
    });

    if (section === 'schedule') {
        document.getElementById('scheduleSection').classList.remove('hidden');
        renderScheduleTabs();
        renderWeekDaysBar();
        loadScheduleForActive();
    } else if (section === 'changes') {
        document.getElementById('changesSection').classList.remove('hidden');
        renderPortalFilesButtons();
        renderChangesGroupFilter();
        renderChangesList();
        if (!changesData.items || changesData.items.length === 0) fetchChangesFromPortal();
    } else if (section === 'tasks') {
        document.getElementById('tasksSection').classList.remove('hidden');
        switchTaskSubTab(taskSubTab);
    } else if (section === 'marks') {
        document.getElementById('marksSection').classList.remove('hidden');
        renderSubjectTabs();
        loadMarksForActiveSubject();
    }
}

function toggleProfileModal() {
    const profSec = document.getElementById('profileSection');
    if (profSec && !profSec.classList.contains('hidden')) closeProfileModal();
    else openProfileModal();
}

function openProfileModal() {
    const allSecs = ['scheduleSection', 'changesSection', 'tasksSection', 'marksSection', 'setupScreen', 'setupScheduleScreen', 'addTaskModal', 'addMaterialModal'];
    allSecs.forEach(id => document.getElementById(id).classList.add('hidden'));
    document.getElementById('profileSection').classList.remove('hidden');
    document.getElementById('topScreenTitle').innerText = 'Личный кабинет';

    const topProfBtn = document.getElementById('topProfileBtn');
    if (topProfBtn) topProfBtn.className = "w-9 h-9 rounded-full blue-glow flex items-center justify-center active:scale-95 transition";

    const stName = subjects.length > 0 ? subjects[activeSubjectIndex].studentName : 'Студент НовГУ';
    const grp = getActiveGroupName() || 'не выбрана';
    document.getElementById('profileStudentName').innerText = stName;
    document.getElementById('profileGroupText').innerText = `Группа: ${grp}`;

    renderProfileSubjectsList();
    updateCreatorUI();
    updateStarostaUI();
}

function closeProfileModal() {
    switchSection(lastActiveSection || 'schedule');
}

// ================= ПАНЕЛЬ СОЗДАТЕЛЯ (АВТОРИЗАЦИЯ И ВЫПУСК ОДНОРАЗОВЫХ КЛЮЧЕЙ) =================
function updateCreatorUI() {
    const unlocked = document.getElementById('creatorUnlockedBlock');
    const loginForm = document.getElementById('creatorLoginForm');
    if (creatorMasterPassword) {
        if (unlocked) unlocked.classList.remove('hidden');
        if (loginForm) loginForm.classList.add('hidden');
    } else {
        if (unlocked) unlocked.classList.add('hidden');
        if (loginForm) loginForm.classList.remove('hidden');
    }
}

async function authCreator() {
    const input = document.getElementById('creatorMasterPassInput');
    const pass = input.value.trim();
    if (!pass) { alert("Введите пароль создателя!"); return; }

    try {
        const res = await fetch(GOOGLE_SCRIPT_WEBAPP_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ action: 'adminAuth', password: pass })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || "Неверный пароль");

        creatorMasterPassword = pass;
        localStorage.setItem(STORAGE_CREATOR_PASS_KEY, pass);
        input.value = '';
        updateCreatorUI();
        alert("✓ Вход в панель создателя выполнен!");
    } catch (e) {
        alert("Ошибка: " + e.message);
    }
}

function logoutCreator() {
    if (confirm("Выйти из панели создателя?")) {
        creatorMasterPassword = null;
        localStorage.removeItem(STORAGE_CREATOR_PASS_KEY);
        updateCreatorUI();
    }
}

async function generateOneTimeKey() {
    const grp = document.getElementById('creatorGroupInput').value.trim();
    if (!grp) { alert("Укажите номер группы!"); return; }
    const btn = document.getElementById('btnGenKey');
    btn.innerText = "⏳...";
    btn.disabled = true;

    try {
        const res = await fetch(GOOGLE_SCRIPT_WEBAPP_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({
                action: 'generateStarostaKey',
                adminPassword: creatorMasterPassword,
                group: grp
            })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || "Ошибка генерации ключа");

        document.getElementById('creatorKeyResult').innerText = data.key;
        document.getElementById('creatorKeyBox').classList.remove('hidden');
    } catch (e) {
        alert("Ошибка: " + e.message);
    } finally {
        btn.innerText = "Создать ключ";
        btn.disabled = false;
    }
}

function copyCreatedKey() {
    const keyText = document.getElementById('creatorKeyResult').innerText;
    if (navigator.clipboard) {
        navigator.clipboard.writeText(keyText);
        alert("Ключ скопирован в буфер обмена!");
    }
}

// ================= ДОСТУП СТАРОСТЫ (ОДНОРАЗОВАЯ АКТИВАЦИЯ) =================
function updateStarostaUI() {
    const activeBlock = document.getElementById('starostaActiveBlock');
    const loginForm = document.getElementById('starostaLoginForm');
    const groupLabel = document.getElementById('starostaActiveGroupLabel');
    const notice = document.getElementById('matTargetGroupNotice');

    if (starostaAuth && starostaAuth.sessionToken) {
        if (activeBlock) activeBlock.classList.remove('hidden');
        if (loginForm) loginForm.classList.add('hidden');
        if (groupLabel) groupLabel.innerText = `Группа: ${starostaAuth.group}`;
        if (notice) notice.classList.add('hidden');
    } else {
        if (activeBlock) activeBlock.classList.add('hidden');
        if (loginForm) loginForm.classList.remove('hidden');
        if (notice) notice.classList.remove('hidden');
    }
}

async function activateStarostaOneTimeKey() {
    const keyInput = document.getElementById('starostaOneTimeKeyInput');
    const key = keyInput.value.trim().toUpperCase();
    if (!key) { alert("Вставьте одноразовый ключ!"); return; }

    const currentGrp = getActiveGroupName();
    if (!currentGrp) {
        alert("Сначала подключите вашу группу в разделе «Расписание»!");
        return;
    }

    const btn = document.getElementById('btnActivateStarosta');
    btn.innerText = "⏳ Проверка ключа...";
    btn.disabled = true;

    try {
        const res = await fetch(GOOGLE_SCRIPT_WEBAPP_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({
                action: 'activateStarostaKey',
                key: key,
                group: currentGrp
            })
        });

        const data = await res.json();
        if (!data.success) throw new Error(data.error || "Неверный или сгоревший ключ");

        starostaAuth = {
            group: data.group,
            sessionToken: data.sessionToken
        };
        localStorage.setItem(STORAGE_STAROSTA_SESSION_KEY, JSON.stringify(starostaAuth));
        keyInput.value = '';
        updateStarostaUI();
        alert(`✓ Поздравляем! Вы активировали права старосты группы ${data.group}. Одноразовый ключ сгорел.`);
    } catch (e) {
        alert("Ошибка: " + e.message);
    } finally {
        btn.innerText = "Активировать статус старосты";
        btn.disabled = false;
    }
}

function logoutStarosta() {
    if (confirm("Сбросить сессию старосты на этом телефоне? Для повторного входа потребуется новый ключ от создателя.")) {
        starostaAuth = null;
        localStorage.removeItem(STORAGE_STAROSTA_SESSION_KEY);
        updateStarostaUI();
    }
}

// ================= РАСПИСАНИЕ И АНАЛИЗ ПАР =================
function getMondayOfCurrentWeek() {
    const now = new Date();
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1);
    return new Date(now.setDate(diff));
}

function getDateForDayIndex(dayIdx) {
    const monday = getMondayOfCurrentWeek();
    const d = new Date(monday);
    d.setDate(monday.getDate() + dayIdx);
    return d.toISOString().slice(0, 10);
}

function renderWeekDaysBar() {
    const bar = document.getElementById('weekDaysBar');
    if (!bar) return;
    bar.innerHTML = '';
    const monday = getMondayOfCurrentWeek();

    for (let i = 0; i < 7; i++) {
        const d = new Date(monday);
        d.setDate(monday.getDate() + i);
        const dateNum = d.getDate();
        const isSelected = (i === selectedDayIndex && scheduleViewMode === 'day');

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = isSelected
            ? "py-2 rounded-2xl flex flex-col items-center justify-center transition blue-glow font-bold"
            : "py-2 rounded-2xl flex flex-col items-center justify-center transition app-card text-slate-400";
        btn.innerHTML = `<span class="text-[11px]">${DAY_NAMES_SHORT[i]}</span><span class="text-sm font-bold mt-0.5">${dateNum}</span>`;
        btn.onclick = () => {
            selectedDayIndex = i;
            scheduleViewMode = 'day';
            updateScheduleModeUI();
            renderWeekDaysBar();
            loadScheduleForActive();
        };
        bar.appendChild(btn);
    }

    const selDate = new Date(monday);
    selDate.setDate(monday.getDate() + selectedDayIndex);
    const headingEl = document.getElementById('selectedDateHeading');
    if (headingEl) {
        headingEl.innerText = scheduleViewMode === 'day'
            ? `${DAY_NAMES_FULL[selectedDayIndex]}, ${selDate.getDate()} ${MONTHS_GENITIVE[selDate.getMonth()]}`
            : `Расписание на всю неделю`;
    }
}

function setScheduleViewMode(mode) {
    scheduleViewMode = mode;
    updateScheduleModeUI();
    renderWeekDaysBar();
    loadScheduleForActive();
}

function updateScheduleModeUI() {
    const bDay = document.getElementById('btnModeDay'), bWeek = document.getElementById('btnModeWeek');
    bDay.className = scheduleViewMode === 'day' ? "py-1.5 rounded-xl text-xs font-semibold transition blue-glow" : "py-1.5 rounded-xl text-xs font-medium transition text-slate-400";
    bWeek.className = scheduleViewMode === 'week' ? "py-1.5 rounded-xl text-xs font-semibold transition blue-glow" : "py-1.5 rounded-xl text-xs font-medium transition text-slate-400";
}

function parseLessonDetails(rawText) {
    const str = String(rawText || '').trim();
    let aud = '';
    const audMatch = str.match(/(?:ауд\.?|аул\.?|каб\.?|зал)\s*([0-9а-яА-Яa-zA-Z\-\s]+)$/i) || str.match(/(СП\s*зал|спорт\s*зал)/i);
    let cleanStr = str;
    if (audMatch) {
        aud = audMatch[0].trim();
        cleanStr = str.replace(audMatch[0], '').replace(/,\s*$/, '').trim();
    }
    const parts = cleanStr.split(',').map(s => s.trim()).filter(Boolean);
    const title = parts[0] || str;
    const teacher = parts.slice(1).join(', ') || 'Занятие по расписанию';
    return { title, teacher, aud: aud || 'НовГУ ПТК' };
}

function getLessonsForDayAndWeek(targetDayName, weekType) {
    const current = schedules[activeScheduleIndex];
    if (!current || !current.rawRows) return [];

    const rows = current.rawRows, merges = current.merges || [];
    const groupWordRegex = new RegExp(`(^|\\D)${current.groupName}(\\D|$)`);
    let groupColIdx = -1, headerRowIdx = -1;

    for (let r = 0; r < Math.min(30, rows.length); r++) {
        for (let c = 0; c < (rows[r] || []).length; c++) {
            const val = String(rows[r][c] || '').trim();
            if (val === current.groupName || groupWordRegex.test(val)) { groupColIdx = c; headerRowIdx = r; break; }
        }
        if (groupColIdx !== -1) break;
    }

    if (groupColIdx === -1) return [];

    const timeColIdx = groupColIdx - 1, dayColIdx = groupColIdx - 2;
    let currentDay = "Понедельник";
    const foundLessons = [];

    for (let r = headerRowIdx + 1; r < rows.length; r++) {
        let row = rows[r];
        if (!row) continue;
        let dayCandidate = String(row[dayColIdx] || row[0] || '').trim().toLowerCase();
        if (/^(понедельник|вторник|среда|четверг|пятница|суббота)$/.test(dayCandidate)) {
            currentDay = dayCandidate.charAt(0).toUpperCase() + dayCandidate.slice(1);
        }

        if (currentDay.toLowerCase() !== targetDayName.toLowerCase()) continue;

        let timeVal = String(row[timeColIdx] || row[1] || '').trim();
        if (!/\d{1,2}[\.:]\d{2}\s*-\s*\d{1,2}[\.:]\d{2}/.test(timeVal)) continue;

        let upperVal = String(rows[r][groupColIdx] || '').trim();
        let nextRow = rows[r + 1] || [];
        let lowerVal = String(nextRow[groupColIdx] || '').trim();
        let nextTimeVal = String(nextRow[timeColIdx] || nextRow[1] || '').trim();
        let hasSecondRow = !(/\d{1,2}[\.:]\d{2}\s*-\s*\d{1,2}[\.:]\d{2}/.test(nextTimeVal));
        let isMerged = isCellMergedVertically(merges, r, groupColIdx);

        if (isMerged || !hasSecondRow) lowerVal = upperVal;
        let chosenLesson = weekType === 'upper' ? upperVal : lowerVal;

        if (chosenLesson && chosenLesson !== '-' && chosenLesson !== '—' && !/Зам\.\s*директора/i.test(chosenLesson)) {
            const parsed = parseLessonDetails(chosenLesson);
            if (!foundLessons.includes(parsed.title)) {
                foundLessons.push(parsed.title);
            }
        }
    }
    return foundLessons;
}

function getAllGroupSubjectNames() {
    const set = new Set();
    const current = schedules[activeScheduleIndex];
    if (current && current.rawRows) {
        current.rawRows.forEach(r => {
            (r || []).forEach(cell => {
                const str = String(cell || '').trim();
                if (str && !/понедельник|вторник|среда|четверг|пятница|суббота|воскресенье|зам\.|директор/i.test(str)) {
                    if (/[а-яА-ЯёЁ]{3,}/.test(str) && !/^\d{4}/.test(str) && !/\d{1,2}[\.:]\d{2}/.test(str)) {
                        const parsed = parseLessonDetails(str);
                        if (parsed.title && parsed.title.length > 2) {
                            set.add(parsed.title);
                        }
                    }
                }
            });
        });
    }
    subjects.forEach(s => {
        if (s.subjectName) set.add(s.subjectName);
    });
    return Array.from(set).sort();
}

function onMaterialSubjectInput(query) {
    const container = document.getElementById('matSubjectSuggestions');
    if (!container) return;

    const allSubjects = getAllGroupSubjectNames();
    const q = String(query || '').trim().toLowerCase();

    const matches = allSubjects.filter(s => s.toLowerCase().includes(q));

    if (matches.length === 0) {
        container.innerHTML = '';
        container.classList.add('hidden');
        return;
    }

    container.innerHTML = '';
    container.classList.remove('hidden');

    matches.slice(0, 6).forEach(subj => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = "w-full text-left px-3 py-2 text-xs rounded-xl hover:bg-blue-600/30 text-white font-medium transition flex items-center justify-between";
        btn.innerHTML = `
            <span class="truncate">${subj}</span>
            <span class="text-blue-400 text-[10px] shrink-0 font-bold ml-2">Выбрать</span>
        `;
        btn.onmousedown = (e) => {
            e.preventDefault();
            document.getElementById('matSubjectInput').value = subj;
            container.classList.add('hidden');
        };
        container.appendChild(btn);
    });
}

document.addEventListener('click', function(e) {
    const suggestions = document.getElementById('matSubjectSuggestions');
    const input = document.getElementById('matSubjectInput');
    if (suggestions && input && !input.contains(e.target) && !suggestions.contains(e.target)) {
        suggestions.classList.add('hidden');
    }
});

function getLessonLiveStatus(timeStr, pairIdx) {
    const m = String(timeStr).match(/(\d{1,2})[\.:](\d{2})\s*-\s*(\d{1,2})[\.:](\d{2})/);
    if (!m) return `${pairIdx} пара`;
    const now = new Date();
    const curMin = now.getHours() * 60 + now.getMinutes();
    const startMin = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    const endMin = parseInt(m[3], 10) * 60 + parseInt(m[4], 10);

    const jsDay = now.getDay();
    const todayIdx = jsDay === 0 ? 6 : jsDay - 1;
    if (selectedDayIndex === todayIdx && scheduleViewMode === 'day') {
        if (curMin >= startMin && curMin <= endMin) return 'Сейчас';
        if (startMin > curMin && startMin - curMin <= 60) return `Через ${startMin - curMin} мин`;
    }
    return `${pairIdx} пара`;
}

function openAddSchedule() {
    const allSecs = ['scheduleSection', 'changesSection', 'tasksSection', 'marksSection', 'setupScreen', 'addTaskModal', 'addMaterialModal', 'profileSection'];
    allSecs.forEach(id => document.getElementById(id).classList.add('hidden'));
    document.getElementById('setupScheduleScreen').classList.remove('hidden');
    document.getElementById('excelFileInput').value = '';
    document.getElementById('serverGroupInput').value = '';
    document.getElementById('excelGroupsBlock').classList.add('hidden');
    tempExcelData = null;
}

async function addScheduleFromServer() {
    const groupName = document.getElementById('serverGroupInput').value.trim();
    if (!groupName) { alert("Введите номер группы!"); return; }
    const btn = document.getElementById('fetchSchedBtn');
    btn.innerText = "⏳ Ищем...";
    try {
        const res = await fetch(`${RENDER_URL}/api/schedule/${encodeURIComponent(groupName)}`);
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || "Группа не найдена");

        const existingIdx = schedules.findIndex(s => s.groupName === groupName);
        const newEntry = {
            groupName,
            fileName: `НовГУ (${data.fileName || data.sheet})`,
            rawRows: data.rows,
            merges: data.merges || []
        };
        if (existingIdx !== -1) { schedules[existingIdx] = newEntry; activeScheduleIndex = existingIdx; }
        else { schedules.push(newEntry); activeScheduleIndex = schedules.length - 1; }

        localStorage.setItem(STORAGE_SCHED_KEY, JSON.stringify(schedules));
        activeChangesGroupFilter = groupName;
        fetchGoogleDriveMaterials();
        switchSection('schedule');
    } catch (e) {
        alert("Ошибка загрузки: " + e.message);
    } finally {
        btn.innerText = "Найти на сайте";
    }
}

async function refreshActiveScheduleFromServer() {
    const current = schedules[activeScheduleIndex];
    if (!current) { openAddSchedule(); return; }
    document.getElementById('schedSubInfo').innerText = "⏳ Обновляем...";
    try {
        const res = await fetch(`${RENDER_URL}/api/schedule/${encodeURIComponent(current.groupName)}`);
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || "Ошибка");
        schedules[activeScheduleIndex] = {
            groupName: current.groupName,
            fileName: `НовГУ (${data.fileName || data.sheet})`,
            rawRows: data.rows,
            merges: data.merges || []
        };
        localStorage.setItem(STORAGE_SCHED_KEY, JSON.stringify(schedules));
        loadScheduleForActive();
    } catch (e) {
        alert("Не удалось обновить: " + e.message);
        loadScheduleForActive();
    }
}

function handleExcelFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const workbook = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
            let foundGroups = [], allSheetsData = {};
            workbook.SheetNames.forEach(sheetName => {
                const sheet = workbook.Sheets[sheetName];
                const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
                allSheetsData[sheetName] = { rows, merges: sheet['!merges'] || [] };
                for (let r = 0; r < Math.min(20, rows.length); r++) {
                    for (let c = 0; c < rows[r].length; c++) {
                        let val = String(rows[r][c] || '').trim();
                        if (/^\d{4}[а-яa-z]*$/i.test(val) && !/^202\d$/.test(val)) foundGroups.push({ groupName: val, sheetName });
                    }
                }
            });
            tempExcelData = { fileName: file.name, sheets: allSheetsData };
            const btnContainer = document.getElementById('excelGroupsButtons');
            btnContainer.innerHTML = '';
            foundGroups.forEach(g => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = "blue-glow font-bold px-4 py-2 rounded-xl text-xs";
                btn.textContent = `👥 Группа ${g.groupName}`;
                btn.onclick = () => saveScheduleGroup(g.groupName, g.sheetName);
                btnContainer.appendChild(btn);
            });
            document.getElementById('excelGroupsBlock').classList.remove('hidden');
        } catch (err) { alert("Ошибка чтения Excel: " + err.message); }
    };
    reader.readAsArrayBuffer(file);
}

function saveScheduleGroup(groupName, sheetName) {
    if (!tempExcelData) return;
    const sheetObj = tempExcelData.sheets[sheetName];
    schedules.push({ groupName, fileName: tempExcelData.fileName, rawRows: sheetObj.rows, merges: sheetObj.merges || [] });
    localStorage.setItem(STORAGE_SCHED_KEY, JSON.stringify(schedules));
    activeScheduleIndex = schedules.length - 1;
    activeChangesGroupFilter = groupName;
    fetchGoogleDriveMaterials();
    switchSection('schedule');
}

function renderScheduleTabs() {
    const container = document.getElementById('scheduleTabs');
    container.innerHTML = '';
    schedules.forEach((sch, idx) => {
        const isActive = idx === activeScheduleIndex;
        container.innerHTML += `
            <div onclick="switchSchedule(${idx})" class="flex items-center rounded-xl px-3 py-1.5 text-xs font-semibold shrink-0 cursor-pointer transition ${isActive ? 'blue-glow' : 'app-card text-slate-400'}">
                <span>Гр. ${sch.groupName}</span>
                <button type="button" onclick="deleteSchedule(event, ${idx})" class="ml-2 opacity-75 hover:opacity-100">✕</button>
            </div>
        `;
    });
}

function switchSchedule(idx) {
    activeScheduleIndex = idx;
    renderScheduleTabs();
    fetchGoogleDriveMaterials();
    loadScheduleForActive();
}

function deleteSchedule(event, idx) {
    event.stopPropagation();
    if (confirm(`Удалить группу ${schedules[idx].groupName}?`)) {
        schedules.splice(idx, 1);
        localStorage.setItem(STORAGE_SCHED_KEY, JSON.stringify(schedules));
        activeScheduleIndex = 0;
        switchSection('schedule');
    }
}

function isCellMergedVertically(merges, r, c) {
    return (merges || []).some(m => m.s.r === r && m.e.r > r && c >= m.s.c && c <= m.e.c);
}

function loadScheduleForActive() {
    const current = schedules[activeScheduleIndex];
    const container = document.getElementById('scheduleList');
    if (!current || !current.rawRows) {
        document.getElementById('schedSubInfo').innerText = "";
        container.innerHTML = `
            <div class="app-card rounded-3xl p-6 text-center space-y-3">
                <div class="text-slate-300 text-sm font-semibold">Группа ещё не выбрана</div>
                <div class="text-slate-400 text-xs">Подключите расписание вашей группы с портала НовГУ</div>
                <button type="button" onclick="openAddSchedule()" class="blue-glow text-xs font-semibold px-5 py-2.5 rounded-xl transition">➕ Выбрать группу</button>
            </div>
        `;
        return;
    }

    document.getElementById('schedSubInfo').innerText = `Гр. ${current.groupName} • ${currentSelectedWeek === 'upper' ? 'Верхняя' : 'Нижняя'}`;

    try {
        const rows = current.rawRows, merges = current.merges || [];
        const groupWordRegex = new RegExp(`(^|\\D)${current.groupName}(\\D|$)`);
        let groupColIdx = -1, headerRowIdx = -1;

        for (let r = 0; r < Math.min(30, rows.length); r++) {
            for (let c = 0; c < (rows[r] || []).length; c++) {
                const val = String(rows[r][c] || '').trim();
                if (val === current.groupName || groupWordRegex.test(val)) { groupColIdx = c; headerRowIdx = r; break; }
            }
            if (groupColIdx !== -1) break;
        }

        if (groupColIdx === -1) {
            container.innerHTML = `<div class="app-card p-6 rounded-2xl text-center text-red-400 text-xs">Группа ${current.groupName} не найдена</div>`;
            return;
        }

        const timeColIdx = groupColIdx - 1, dayColIdx = groupColIdx - 2;
        let daysSchedule = {}, currentDay = "Понедельник", pairCounter = 0;

        for (let r = headerRowIdx + 1; r < rows.length; r++) {
            let row = rows[r];
            if (!row) continue;
            let dayCandidate = String(row[dayColIdx] || row[0] || '').trim().toLowerCase();
            if (/^(понедельник|вторник|среда|четверг|пятница|суббота)$/.test(dayCandidate)) {
                currentDay = dayCandidate.charAt(0).toUpperCase() + dayCandidate.slice(1);
                pairCounter = 0;
            }

            let timeVal = String(row[timeColIdx] || row[1] || '').trim();
            if (!/\d{1,2}[\.:]\d{2}\s*-\s*\d{1,2}[\.:]\d{2}/.test(timeVal)) continue;
            pairCounter++;

            let upperVal = String(rows[r][groupColIdx] || '').trim();
            let nextRow = rows[r + 1] || [];
            let lowerVal = String(nextRow[groupColIdx] || '').trim();
            let nextTimeVal = String(nextRow[timeColIdx] || nextRow[1] || '').trim();
            let hasSecondRow = !(/\d{1,2}[\.:]\d{2}\s*-\s*\d{1,2}[\.:]\d{2}/.test(nextTimeVal));
            let isMerged = isCellMergedVertically(merges, r, groupColIdx);

            if (isMerged || !hasSecondRow) lowerVal = upperVal;
            let chosenLesson = currentSelectedWeek === 'upper' ? upperVal : lowerVal;

            if (chosenLesson && chosenLesson !== '-' && chosenLesson !== '—' && !/Зам\.\s*директора/i.test(chosenLesson)) {
                if (!daysSchedule[currentDay]) daysSchedule[currentDay] = [];
                daysSchedule[currentDay].push({
                    pairNum: pairCounter,
                    time: timeVal.replace(/\./g, ':'),
                    lesson: chosenLesson,
                    onlyThisWeek: (!isMerged && hasSecondRow && upperVal !== lowerVal)
                });
            }
        }

        let html = '';
        const targetDays = scheduleViewMode === 'day' ? [DAY_NAMES_FULL[selectedDayIndex]] : DAY_NAMES_FULL;

        targetDays.forEach((dayName) => {
            const lessons = daysSchedule[dayName] || [];
            const dayIdx = scheduleViewMode === 'day' ? selectedDayIndex : DAY_NAMES_FULL.indexOf(dayName);
            const targetDayDateStr = getDateForDayIndex(dayIdx);

            const dayTasks = localTasks.filter(t => t.dueDate === targetDayDateStr);

            if (scheduleViewMode === 'week' && lessons.length === 0 && dayTasks.length === 0) return;

            if (scheduleViewMode === 'week') {
                html += `<div class="text-xs font-bold text-blue-400 uppercase tracking-wider px-1 pt-2">${dayName}</div>`;
            }

            if (lessons.length === 0) {
                if (scheduleViewMode === 'day' && dayTasks.length === 0) {
                    html += `
                        <div class="app-card p-6 rounded-3xl text-center space-y-1">
                            <div class="text-base">🎉</div>
                            <div class="text-sm font-semibold text-white">В этот день пар нет</div>
                            <div class="text-xs text-slate-400">Можно отдохнуть или заняться заданиями</div>
                        </div>
                    `;
                }
            } else {
                lessons.forEach(l => {
                    const info = parseLessonDetails(l.lesson);
                    const statusText = getLessonLiveStatus(l.time, l.pairNum);
                    const isNow = statusText === 'Сейчас';
                    const statusCls = isNow ? 'blue-glow' : 'pill-bar text-slate-300';

                    const lessonTasks = dayTasks.filter(t => {
                        const tSubj = String(t.subject || '').trim().toLowerCase();
                        const pTitle = String(info.title || '').trim().toLowerCase();
                        return tSubj === pTitle || pTitle.includes(tSubj) || tSubj.includes(pTitle);
                    });

                    let taskInsideCardHtml = '';
                    if (lessonTasks.length > 0) {
                        taskInsideCardHtml += `<div class="mt-2.5 pt-2.5 border-t border-slate-700/50 space-y-1.5">`;
                        lessonTasks.forEach(t => {
                            taskInsideCardHtml += `
                                <div class="bg-blue-500/10 border border-blue-500/30 p-2 rounded-xl text-xs flex items-start justify-between gap-2">
                                    <div class="min-w-0">
                                        <div class="text-[10px] text-blue-400 font-bold uppercase tracking-wider">📝 Задание:</div>
                                        <div class="text-white font-medium leading-snug pt-0.5">${t.title}</div>
                                    </div>
                                    <span class="text-emerald-400 text-xs shrink-0 pt-0.5">✓</span>
                                </div>
                            `;
                        });
                        taskInsideCardHtml += `</div>`;
                    }

                    html += `
                        <div class="app-card p-4 rounded-3xl space-y-2 relative transition">
                            <div class="flex justify-between items-center">
                                <span class="text-xs font-mono text-slate-400 font-medium">${l.time}</span>
                                <span class="text-[11px] font-semibold px-2.5 py-0.5 rounded-full ${statusCls}">${statusText}</span>
                            </div>
                            <div class="font-bold text-[15px] text-white leading-snug pr-4">${info.title}</div>
                            <div class="text-xs text-slate-400">${info.teacher}</div>
                            <div class="flex items-center justify-between pt-1 text-xs text-slate-300">
                                <div class="flex items-center gap-1.5">
                                    <span class="text-blue-400">📍</span>
                                    <span>${info.aud}</span>
                                </div>
                                ${l.onlyThisWeek ? `<span class="text-[10px] bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded-md font-medium">${currentSelectedWeek === 'upper' ? 'Верхняя нед.' : 'Нижняя нед.'}</span>` : '<span class="text-slate-400">›</span>'}
                            </div>
                            ${taskInsideCardHtml}
                        </div>
                    `;
                });
            }

            const unassignedTasks = dayTasks.filter(t => {
                const tSubj = String(t.subject || '').trim().toLowerCase();
                return !lessons.some(l => {
                    const pTitle = String(parseLessonDetails(l.lesson).title || '').trim().toLowerCase();
                    return tSubj === pTitle || pTitle.includes(tSubj) || tSubj.includes(pTitle);
                });
            });

            if (unassignedTasks.length > 0) {
                html += `
                    <div class="app-card p-3 rounded-2xl border-dashed border-slate-700/80 space-y-1.5 text-xs">
                        <div class="text-[10px] font-bold text-slate-400 uppercase">📌 Прочие задания на этот день:</div>
                `;
                unassignedTasks.forEach(ut => {
                    html += `<div>• <b class="text-white">${ut.subject}:</b> ${ut.title}</div>`;
                });
                html += `</div>`;
            }
        });

        container.innerHTML = html || '<div class="app-card p-6 rounded-3xl text-center text-slate-400 text-sm">На этой неделе пар не найдено</div>';
    } catch (e) {
        container.innerHTML = `<div class="app-card p-6 rounded-3xl text-center text-red-400 text-xs">Ошибка: ${e.message}</div>`;
    }
}

// ================= ЭКРАН 2: ИЗМЕНЕНИЯ В РАСПИСАНИИ =================
function setChangesTypeFilter(type) {
    activeChangesTypeFilter = type;
    const ids = { ALL: 'chgFilterAll', MOVE: 'chgFilterMove', CANCEL: 'chgFilterCancel' };
    Object.keys(ids).forEach(k => {
        document.getElementById(ids[k]).className = (k === type)
            ? "py-2 rounded-xl text-xs font-semibold transition blue-glow"
            : "py-2 rounded-xl text-xs font-medium transition text-slate-400";
    });
    renderChangesList();
}

function filterOnlyLast5DateFiles(files) {
    return (files || []).filter(f => /\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/.test(String(f.title || ''))).slice(0, 5);
}

async function fetchChangesFromPortal(specificUrl, specificTitle) {
    const statusEl = document.getElementById('changesStatusText');
    const listEl = document.getElementById('changesList');
    const btn = document.getElementById('fetchChangesBtn');

    statusEl.innerText = "⏳ Загружаем с сайта НовГУ...";
    listEl.innerHTML = '<div class="app-card p-8 rounded-3xl text-center text-slate-400 animate-pulse text-xs">Получаем свежий документ изменений...</div>';
    if (btn) btn.innerText = "⏳...";

    try {
        if (!specificUrl) {
            try {
                const listRes = await fetch(`${RENDER_URL}/api/changes-list`);
                if (listRes.ok) {
                    const listJson = await listRes.json();
                    const cleanFiles = filterOnlyLast5DateFiles(listJson.files);
                    if (cleanFiles.length > 0) {
                        changesData.portalFiles = cleanFiles;
                        renderPortalFilesButtons();
                        specificUrl = cleanFiles[0].url;
                        specificTitle = cleanFiles[0].title;
                    }
                }
            } catch (e) {}
        }

        let fetchUrl = `${RENDER_URL}/api/changes`;
        if (specificUrl) fetchUrl += `?url=${encodeURIComponent(specificUrl)}&title=${encodeURIComponent(specificTitle || '')}`;

        const res = await fetch(fetchUrl);
        if (!res.ok) throw new Error("Не удалось скачать файл замен");

        const headerTitle = res.headers.get('X-File-Title');
        const finalTitle = specificTitle || (headerTitle ? decodeURIComponent(headerTitle) : 'Замены НовГУ.docx');
        const arrayBuffer = await res.arrayBuffer();
        await parseChangesBuffer(arrayBuffer, finalTitle);
    } catch (e) {
        statusEl.innerText = "Ошибка автозагрузки";
        listEl.innerHTML = `<div class="app-card p-5 rounded-3xl text-center text-amber-400 text-xs">⚠️ ${e.message}</div>`;
    } finally {
        if (btn) btn.innerText = "🔄 С сайта";
    }
}

function renderPortalFilesButtons() {
    const block = document.getElementById('portalFilesContainer');
    const list = document.getElementById('portalFilesList');
    if (!list) return;
    list.innerHTML = '';
    const cleanFiles = filterOnlyLast5DateFiles(changesData.portalFiles);
    if (cleanFiles.length === 0) { block.classList.add('hidden'); return; }
    block.classList.remove('hidden');
    cleanFiles.forEach(f => {
        const isActive = changesData.fileName === f.title;
        const cls = isActive ? "blue-glow" : "pill-bar text-slate-300";
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `px-3 py-1.5 rounded-xl text-xs font-medium transition ${cls}`;
        btn.textContent = f.title;
        btn.onclick = () => fetchChangesFromPortal(f.url, f.title);
        list.appendChild(btn);
    });
}

function handleManualChangesFile(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async function(e) { await parseChangesBuffer(e.target.result, file.name); };
    reader.readAsArrayBuffer(file);
}

async function parseChangesBuffer(arrayBuffer, fileName) {
    try {
        if (window.mammoth && !/\.xlsx?$/i.test(fileName)) {
            const result = await mammoth.convertToHtml({ arrayBuffer });
            if (result && result.value) { parseDocxHtmlChanges(result.value, fileName); return; }
        }
        const workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array' });
        const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: "" });
        parseRawRowsToChanges(rows, "Изменения в расписании", fileName);
    } catch (err) { alert("Ошибка файла: " + err.message); }
}

function parseDocxHtmlChanges(htmlString, fileName) {
    const doc = new DOMParser().parseFromString(htmlString, 'text/html');
    let dateTitle = "Изменения в расписании";
    doc.querySelectorAll('p').forEach(p => {
        const t = p.textContent.replace(/\s+/g, ' ').trim();
        if (/на\s+\d+/i.test(t) || /неделя/i.test(t)) dateTitle = "Замены " + t;
    });
    const rows = [];
    doc.querySelectorAll('table tr').forEach(tr => {
        const cols = [];
        tr.querySelectorAll('td, th').forEach(td => cols.push(td.textContent.replace(/\s+/g, ' ').trim()));
        if (cols.some(c => c.length > 0)) rows.push(cols);
    });
    parseRawRowsToChanges(rows, dateTitle, fileName);
}

function parseRawRowsToChanges(rows, dateTitle, fileName) {
    const items = [];
    let lastGroupRaw = '';
    for (let r = 0; r < rows.length; r++) {
        const row = rows[r].map(c => String(c || '').trim());
        const c0 = row[0] || '', c1 = row[1] || '', c2 = row[2] || '', c3 = row[3] || '', c4 = row[4] || '';
        if (/групп/i.test(c0) || /дисциплина\s+по\s+расписанию/i.test(c2) || /методист/i.test(row.join(' '))) continue;
        if (!c0 && !c1 && !c2 && !c3 && !c4) continue;

        const groupRaw = c0 || lastGroupRaw;
        if (c0 && /\d{4}/.test(c0)) lastGroupRaw = c0;
        const groups = groupRaw.match(/\d{4}/g) || [];
        if (groups.length === 0) continue;

        items.push({ groupRaw, groups, pair: c1 || '—', oldLesson: c2 || '—', newLesson: c3 || '', aud: c4 || '' });
    }
    const savedPortalFiles = changesData.portalFiles || [];
    changesData = { dateTitle, fileName, items, portalFiles: savedPortalFiles };
    localStorage.setItem(STORAGE_CHANGES_KEY, JSON.stringify(changesData));

    document.getElementById('changesHeaderTitle').innerText = dateTitle;
    document.getElementById('changesStatusText').innerText = `Дата: ${fileName} • Найдено: ${items.length}`;
    renderPortalFilesButtons();
    renderChangesGroupFilter();
    renderChangesList();
}

function renderChangesGroupFilter() {
    const container = document.getElementById('changesGroupFilter');
    container.innerHTML = '';
    const groupsSet = new Set(['ALL', ...getKnownUserGroups()]);
    (changesData.items || []).forEach(it => (it.groups || []).forEach(g => groupsSet.add(g)));

    groupsSet.forEach(g => {
        const isSelected = activeChangesGroupFilter === g;
        const cls = isSelected ? "blue-glow" : "pill-bar text-slate-400";
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `px-3 py-1.5 rounded-xl text-xs font-medium shrink-0 transition ${cls}`;
        btn.textContent = g === 'ALL' ? 'Все группы' : 'Гр. ' + g;
        btn.onclick = () => { activeChangesGroupFilter = g; renderChangesGroupFilter(); renderChangesList(); };
        container.appendChild(btn);
    });
}

function renderChangesList() {
    const container = document.getElementById('changesList');
    if (!changesData.items || changesData.items.length === 0) {
        container.innerHTML = `<div class="app-card p-6 rounded-3xl text-center text-slate-400 text-xs">Нажмите «🔄 С сайта», чтобы загрузить свежие замены</div>`;
        return;
    }

    const filtered = changesData.items.filter(it => {
        const matchGroup = activeChangesGroupFilter === 'ALL' || (it.groups || []).includes(activeChangesGroupFilter) || String(it.groupRaw).includes(activeChangesGroupFilter);
        if (!matchGroup) return false;
        const isCancel = /не\s*будет|отмен/i.test(it.aud) || /не\s*будет|отмен/i.test(it.newLesson);
        if (activeChangesTypeFilter === 'CANCEL') return isCancel;
        if (activeChangesTypeFilter === 'MOVE') return !isCancel;
        return true;
    });

    if (filtered.length === 0) {
        container.innerHTML = `<div class="app-card p-6 rounded-3xl text-center text-slate-300 text-xs">🎉 Для выбранного фильтра изменений нет!</div>`;
        return;
    }

    let html = '';
    filtered.forEach(it => {
        const isCancelled = /не\s*будет|отмен/i.test(it.aud) || /не\s*будет|отмен/i.test(it.newLesson);
        const iconBox = isCancelled
            ? `<div class="w-10 h-10 rounded-full bg-red-500/20 border border-red-500/40 flex items-center justify-center text-red-400 font-bold shrink-0">✕</div>`
            : `<div class="w-10 h-10 rounded-full bg-blue-500/20 border border-blue-500/40 flex items-center justify-center text-blue-400 font-bold shrink-0">⇄</div>`;

        const typeLabel = isCancelled
            ? `<span class="text-xs font-bold text-red-400">Отмена</span>`
            : `<span class="text-xs font-bold text-blue-400">Замена</span>`;

        const removedBlock = `
            <div class="flex items-start gap-2 bg-red-500/10 border border-red-500/30 p-2.5 rounded-2xl text-xs">
                <span class="text-red-400 font-bold shrink-0 mt-0.5">✕</span>
                <div>
                    <span class="text-[10px] uppercase tracking-wider text-red-400/80 font-semibold block">Убрано из расписания:</span>
                    <span class="text-red-400 font-medium leading-snug">${it.oldLesson}</span>
                </div>
            </div>
        `;

        const replacementBlock = (!isCancelled && it.newLesson)
            ? `
                <div class="flex items-start gap-2 bg-emerald-500/10 border border-emerald-500/30 p-2.5 rounded-2xl text-xs">
                    <span class="text-emerald-400 font-bold shrink-0 mt-0.5">✓</span>
                    <div>
                        <span class="text-[10px] uppercase tracking-wider text-emerald-400/80 font-semibold block">Назначена замена:</span>
                        <span class="text-white font-bold leading-snug">${it.newLesson}</span>
                    </div>
                </div>
            `
            : '';

        html += `
            <div class="app-card p-4 rounded-3xl flex gap-3.5 items-start">
                ${iconBox}
                <div class="flex-1 min-w-0 space-y-2">
                    <div class="flex justify-between items-center">
                        ${typeLabel}
                        <span class="text-[11px] pill-bar text-slate-300 px-2.5 py-0.5 rounded-full font-semibold">Гр. ${it.groupRaw} • ${it.pair} пара</span>
                    </div>
                    ${removedBlock}
                    ${replacementBlock}
                    <div class="text-xs text-slate-400 pt-0.5 flex items-center gap-1.5">
                        ${isCancelled ? '<span class="text-red-400 font-medium">🚫 Занятие отменено (Не будет)</span>' : `<span>📍 Ауд. <b>${it.aud || 'по расписанию'}</b></span>`}
                    </div>
                </div>
            </div>
        `;
    });
    container.innerHTML = html;
}

// ================= ЭКРАН 3: ДОМАШНИЕ ЗАДАНИЯ =================
function switchTaskSubTab(tab) {
    taskSubTab = tab;
    const bTasks = document.getElementById('btnSubTabTasks');
    const bMat = document.getElementById('btnSubTabMaterials');
    const vTasks = document.getElementById('tasksSubView');
    const vMat = document.getElementById('materialsSubView');

    if (tab === 'tasks') {
        bTasks.className = "py-2 rounded-xl text-xs font-semibold transition blue-glow";
        bMat.className = "py-2 rounded-xl text-xs font-medium transition text-slate-400";
        vTasks.classList.remove('hidden');
        vMat.classList.add('hidden');
        renderTasksList();
    } else {
        bTasks.className = "py-2 rounded-xl text-xs font-medium transition text-slate-400";
        bMat.className = "py-2 rounded-xl text-xs font-semibold transition blue-glow";
        vTasks.classList.add('hidden');
        vMat.classList.remove('hidden');
        fetchGoogleDriveMaterials();
    }
}

function setTaskFilter(filter) {
    activeTaskFilter = filter;
    const ids = { ALL: 'taskFilterAll', TODAY: 'taskFilterToday', WEEK: 'taskFilterWeek', OVERDUE: 'taskFilterOverdue' };
    Object.keys(ids).forEach(k => {
        document.getElementById(ids[k]).className = (k === filter)
            ? "py-2 rounded-xl text-[11px] font-semibold transition blue-glow"
            : "py-2 rounded-xl text-[11px] font-medium transition text-slate-400";
    });
    renderTasksList();
}

function onTaskDateChanged() {
    const dateVal = document.getElementById('taskDateInput').value;
    const container = document.getElementById('modalDayLessonsContainer');
    const customInput = document.getElementById('taskSubjectInput');
    if (!dateVal || !container) return;

    const [y, m, d] = dateVal.split('-').map(Number);
    const dateObj = new Date(y, m - 1, d);
    const jsDay = dateObj.getDay();
    const dayIdx = jsDay === 0 ? 6 : jsDay - 1;
    const dayName = DAY_NAMES_FULL[dayIdx];
    const weekType = getWeekTypeForDate(dateObj);

    const lessons = getLessonsForDayAndWeek(dayName, weekType);
    container.innerHTML = '';
    selectedSubjectInModal = '';

    if (lessons.length === 0) {
        container.innerHTML = `<span class="text-xs text-slate-400">В этот день (${dayName}) пар по расписанию нет</span>`;
        enableCustomSubjectInput();
        return;
    }

    customInput.classList.add('hidden');
    lessons.forEach((subj, idx) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = idx === 0 
            ? "px-3 py-2 rounded-xl text-xs font-semibold blue-glow transition" 
            : "px-3 py-2 rounded-xl text-xs font-medium pill-bar text-slate-300 hover:text-white transition";
        btn.textContent = subj;
        btn.onclick = () => selectSubjectInModal(subj, btn);
        container.appendChild(btn);

        if (idx === 0) {
            selectedSubjectInModal = subj;
            customInput.value = subj;
        }
    });
}

function selectSubjectInModal(subj, clickedBtn) {
    selectedSubjectInModal = subj;
    document.getElementById('taskSubjectInput').value = subj;
    document.getElementById('taskSubjectInput').classList.add('hidden');

    const container = document.getElementById('modalDayLessonsContainer');
    Array.from(container.children).forEach(child => {
        child.className = "px-3 py-2 rounded-xl text-xs font-medium pill-bar text-slate-300 hover:text-white transition";
    });
    clickedBtn.className = "px-3 py-2 rounded-xl text-xs font-semibold blue-glow transition";
}

function enableCustomSubjectInput() {
    const customInput = document.getElementById('taskSubjectInput');
    customInput.classList.remove('hidden');
    customInput.value = '';
    customInput.focus();
    selectedSubjectInModal = '';

    const container = document.getElementById('modalDayLessonsContainer');
    if (container) {
        Array.from(container.children).forEach(child => {
            child.className = "px-3 py-2 rounded-xl text-xs font-medium pill-bar text-slate-300 hover:text-white transition";
        });
    }
}

function openAddTaskModal() {
    const allSecs = ['scheduleSection', 'changesSection', 'tasksSection', 'marksSection', 'setupScreen', 'setupScheduleScreen', 'addMaterialModal', 'profileSection'];
    allSecs.forEach(id => document.getElementById(id).classList.add('hidden'));
    document.getElementById('addTaskModal').classList.remove('hidden');

    document.getElementById('taskTitleInput').value = '';
    document.getElementById('taskSubjectInput').value = '';
    document.getElementById('taskDateInput').value = new Date().toISOString().slice(0, 10);
    onTaskDateChanged();
}

function saveNewTask() {
    let subject = selectedSubjectInModal || document.getElementById('taskSubjectInput').value.trim();
    const title = document.getElementById('taskTitleInput').value.trim();
    const dueDate = document.getElementById('taskDateInput').value;
    
    if (!subject) subject = 'Общее задание';
    if (!title) { alert("Введите, что нужно сделать!"); return; }

    localTasks.unshift({ id: Date.now(), subject, title, dueDate, status: 'todo' });
    localStorage.setItem(STORAGE_TASKS_KEY, JSON.stringify(localTasks));

    switchSection('tasks');
    loadScheduleForActive();
}

function toggleTaskStatus(id) {
    const t = localTasks.find(x => x.id === id);
    if (!t) return;
    const order = ['todo', 'progress', 'done'];
    t.status = order[(order.indexOf(t.status) + 1) % order.length];
    localStorage.setItem(STORAGE_TASKS_KEY, JSON.stringify(localTasks));
    renderTasksList();
    loadScheduleForActive();
}

function deleteTask(event, id) {
    event.stopPropagation();
    localTasks = localTasks.filter(x => x.id !== id);
    localStorage.setItem(STORAGE_TASKS_KEY, JSON.stringify(localTasks));
    renderTasksList();
    loadScheduleForActive();
}

function renderTasksList() {
    const container = document.getElementById('tasksList');
    const todayStr = new Date().toISOString().slice(0, 10);
    const nowTime = new Date(todayStr).getTime();

    const filtered = localTasks.filter(t => {
        if (!t.dueDate) return true;
        const diffDays = Math.round((new Date(t.dueDate).getTime() - nowTime) / (1000 * 60 * 60 * 24));
        if (activeTaskFilter === 'TODAY') return diffDays === 0;
        if (activeTaskFilter === 'WEEK') return diffDays >= 0 && diffDays <= 7;
        if (activeTaskFilter === 'OVERDUE') return diffDays < 0 && t.status !== 'done';
        return true;
    });

    if (filtered.length === 0) {
        container.innerHTML = `<div class="app-card p-6 rounded-3xl text-center text-slate-400 text-xs">В этой категории заданий нет</div>`;
        return;
    }

    let html = '';
    filtered.forEach(t => {
        const icon = getSubjectIcon(t.subject);
        const diffDays = t.dueDate ? Math.round((new Date(t.dueDate).getTime() - nowTime) / (1000 * 60 * 60 * 24)) : 0;
        const dateFormatted = t.dueDate ? t.dueDate.split('-').reverse().slice(0,2).join('.') : '';
        const daysText = diffDays === 0 ? 'Сегодня' : (diffDays > 0 ? `${diffDays} дн.` : 'Просрочено');

        let badgeHtml = '';
        if (t.status === 'done') {
            badgeHtml = `<span class="bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 px-2.5 py-0.5 rounded-full text-[11px] font-semibold">Готово</span>`;
        } else if (t.status === 'progress') {
            badgeHtml = `<span class="bg-blue-500/20 text-blue-400 border border-blue-500/30 px-2.5 py-0.5 rounded-full text-[11px] font-semibold">В процессе</span>`;
        } else {
            badgeHtml = `<span class="pill-bar text-slate-300 px-2.5 py-0.5 rounded-full text-[11px] font-medium">Не начато</span>`;
        }

        html += `
            <div onclick="toggleTaskStatus(${t.id})" class="app-card p-4 rounded-3xl flex items-center gap-3.5 cursor-pointer active:scale-[0.99] transition">
                <div class="w-11 h-11 rounded-2xl pill-bar flex items-center justify-center text-blue-400 font-bold text-base shrink-0">
                    ${icon}
                </div>
                <div class="flex-1 min-w-0">
                    <div class="text-xs text-slate-400 truncate">${t.subject}</div>
                    <div class="text-sm font-bold text-white truncate ${t.status === 'done' ? 'opacity-50' : ''}">${t.title}</div>
                    <div class="text-[11px] text-slate-400 mt-0.5">До ${dateFormatted} • ${daysText}</div>
                </div>
                <div class="flex flex-col items-end gap-1.5 shrink-0">
                    ${badgeHtml}
                    <button type="button" onclick="deleteTask(event, ${t.id})" class="text-[10px] text-slate-400 hover:text-red-400">Удалить</button>
                </div>
            </div>
        `;
    });
    container.innerHTML = html;
}

// ================= GOOGLE ДИСК МАТЕРИАЛЫ =================
function formatBytes(bytes) {
    if (!bytes || isNaN(bytes)) return '';
    const k = 1024;
    const sizes = ['Б', 'КБ', 'МБ', 'ГБ'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

async function fetchGoogleDriveMaterials() {
    const currentGrp = getActiveGroupName();
    if (!currentGrp || !GOOGLE_SCRIPT_WEBAPP_URL || GOOGLE_SCRIPT_WEBAPP_URL.includes('ВАШ_URL')) {
        renderMaterialsList();
        return;
    }

    try {
        const res = await fetch(`${GOOGLE_SCRIPT_WEBAPP_URL}?action=getMaterials&group=${encodeURIComponent(currentGrp)}`);
        if (res.ok) {
            const data = await res.json();
            if (data.success && Array.isArray(data.materials)) {
                googleDriveMaterials = data.materials;
            }
        }
    } catch (e) {
        console.log('Google Drive sync skipped:', e.message);
    }
    renderMaterialsList();
}

function setMaterialTarget(target) {
    materialTarget = target;
    const btnP = document.getElementById('btnMatTargetPersonal');
    const btnG = document.getElementById('btnMatTargetGroup');
    const modeSelector = document.getElementById('matModeSelector');
    const submitBtn = document.getElementById('submitMaterialBtn');

    if (target === 'personal') {
        btnP.className = "py-2 rounded-xl font-semibold transition blue-glow";
        btnG.className = "py-2 rounded-xl font-medium transition text-slate-400";
        modeSelector.classList.remove('hidden');
        submitBtn.innerText = "Сохранить для себя";
    } else {
        btnP.className = "py-2 rounded-xl font-medium transition text-slate-400";
        btnG.className = "py-2 rounded-xl font-semibold transition blue-glow";
        modeSelector.classList.add('hidden');
        setMaterialMode('file');
        submitBtn.innerText = "Загрузить на Google Диск группы";
    }
}

function setMaterialMode(mode) {
    materialInputMode = mode;
    const btnFile = document.getElementById('btnMatModeFile');
    const btnLink = document.getElementById('btnMatModeLink');
    const boxFile = document.getElementById('matFileUploadBox');
    const boxLink = document.getElementById('matLinkInputBox');

    if (mode === 'file') {
        btnFile.className = "py-2 rounded-xl font-semibold transition blue-glow";
        btnLink.className = "py-2 rounded-xl font-medium transition text-slate-400";
        boxFile.classList.remove('hidden');
        boxLink.classList.add('hidden');
    } else {
        btnFile.className = "py-2 rounded-xl font-medium transition text-slate-400";
        btnLink.className = "py-2 rounded-xl font-semibold transition blue-glow";
        boxFile.classList.add('hidden');
        boxLink.classList.remove('hidden');
    }
}

function openAddMaterialModal() {
    const allSecs = ['scheduleSection', 'changesSection', 'tasksSection', 'marksSection', 'setupScreen', 'setupScheduleScreen', 'addTaskModal', 'profileSection'];
    allSecs.forEach(id => document.getElementById(id).classList.add('hidden'));
    document.getElementById('addMaterialModal').classList.remove('hidden');

    document.getElementById('matSubjectInput').value = '';
    document.getElementById('matTitleInput').value = '';
    document.getElementById('matLinkInput').value = '';
    document.getElementById('matFileInput').value = '';
    document.getElementById('matFileSelectLabel').innerText = "Нажмите, чтобы выбрать файл";
    document.getElementById('matFileSelectSub').innerText = "PDF, DOCX, ZIP, учебники";
    document.getElementById('matUploadStatus').classList.add('hidden');
    document.getElementById('matSubjectSuggestions').classList.add('hidden');

    selectedFileBase64 = null;
    selectedFileName = '';
    selectedFileSize = '';
    selectedFileType = '';

    const isStarosta = Boolean(starostaAuth && starostaAuth.sessionToken);
    setMaterialTarget(isStarosta ? 'group' : 'personal');
}

function closeAddMaterialModal() {
    switchSection('tasks');
}

function handleMaterialFileSelected(event) {
    const file = event.target.files[0];
    if (!file) return;

    selectedFileName = file.name;
    selectedFileSize = formatBytes(file.size);
    selectedFileType = file.type || 'application/octet-stream';

    document.getElementById('matFileSelectLabel').innerText = file.name;
    document.getElementById('matFileSelectSub').innerText = selectedFileSize;
    if (!document.getElementById('matTitleInput').value) {
        document.getElementById('matTitleInput').value = file.name.replace(/\.[^/.]+$/, '');
    }

    const reader = new FileReader();
    reader.onload = function(e) {
        selectedFileBase64 = e.target.result;
    };
    reader.readAsDataURL(file);
}

async function saveNewMaterial() {
    const subject = document.getElementById('matSubjectInput').value.trim() || 'Общий материал';
    const title = document.getElementById('matTitleInput').value.trim();
    const manualLink = document.getElementById('matLinkInput').value.trim();

    if (!title) { alert("Введите название материала!"); return; }

    // Личный материал
    if (materialTarget === 'personal') {
        if (materialInputMode === 'file' && !selectedFileBase64) {
            alert("Выберите файл!");
            return;
        }
        if (materialInputMode === 'link' && !manualLink) {
            alert("Укажите ссылку на материал!");
            return;
        }

        personalMaterials.unshift({
            id: Date.now(),
            subject,
            title,
            fileUrl: manualLink || selectedFileBase64,
            fileName: selectedFileName || 'Ссылка',
            fileSize: selectedFileSize || '',
            isGroup: false,
            createdAt: new Date().toISOString()
        });
        localStorage.setItem(STORAGE_PERSONAL_MATS_KEY, JSON.stringify(personalMaterials));
        closeAddMaterialModal();
        switchTaskSubTab('materials');
        return;
    }

    // Загрузка на Google Диск группы (для старосты)
    const currentGrp = getActiveGroupName();
    if (!currentGrp) { alert("Не выбрана группа в расписании!"); return; }
    if (!starostaAuth || !starostaAuth.sessionToken || starostaAuth.group !== currentGrp) {
        alert("Загружать материалы на Google Диск группы может только староста (активируйте одноразовый ключ в профиле)!");
        return;
    }
    if (!selectedFileBase64) {
        alert("Выберите файл с устройства для загрузки!");
        return;
    }

    const statusEl = document.getElementById('matUploadStatus');
    const submitBtn = document.getElementById('submitMaterialBtn');
    statusEl.classList.remove('hidden');
    statusEl.innerText = "⏳ Загружаем файл на Google Диск группы...";
    submitBtn.disabled = true;

    try {
        const payload = {
            action: 'uploadMaterial',
            group: currentGrp,
            sessionToken: starostaAuth.sessionToken,
            subject: subject,
            title: title,
            fileName: selectedFileName,
            mimeType: selectedFileType,
            base64Data: selectedFileBase64
        };

        const res = await fetch(GOOGLE_SCRIPT_WEBAPP_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Ошибка загрузки в Google Диск');

        alert("✓ Файл успешно сохранён на Google Диске группы!");
        closeAddMaterialModal();
        fetchGoogleDriveMaterials();
    } catch (err) {
        alert("Ошибка: " + err.message);
        statusEl.innerText = "⚠️ Ошибка загрузки: " + err.message;
    } finally {
        submitBtn.disabled = false;
    }
}

async function deleteMaterialItem(item) {
    if (!item.isGroup) {
        personalMaterials = personalMaterials.filter(m => m.id !== item.id);
        localStorage.setItem(STORAGE_PERSONAL_MATS_KEY, JSON.stringify(personalMaterials));
        renderMaterialsList();
        return;
    }

    const currentGrp = getActiveGroupName();
    if (!starostaAuth || !starostaAuth.sessionToken || starostaAuth.group !== currentGrp) {
        alert("Удалять файлы с Google Диска группы может только староста.");
        return;
    }

    if (confirm(`Удалить «${item.title}» с Google Диска группы?`)) {
        try {
            const res = await fetch(GOOGLE_SCRIPT_WEBAPP_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                body: JSON.stringify({
                    action: 'deleteMaterial',
                    group: currentGrp,
                    sessionToken: starostaAuth.sessionToken,
                    fileId: item.id
                })
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error || "Не удалось удалить");
            googleDriveMaterials = googleDriveMaterials.filter(m => m.id !== item.id);
            renderMaterialsList();
        } catch (e) {
            alert("Ошибка: " + e.message);
        }
    }
}

function renderMaterialsList() {
    const container = document.getElementById('materialsList');
    const filterContainer = document.getElementById('materialsSubjectFilter');
    if (!container) return;

    const allCombined = [...personalMaterials, ...googleDriveMaterials];

    const allSubjs = new Set(['ALL']);
    allCombined.forEach(m => { if (m.subject) allSubjs.add(m.subject); });

    if (filterContainer) {
        filterContainer.innerHTML = '';
        allSubjs.forEach(s => {
            const isSel = activeMaterialSubjectFilter === s;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `px-3 py-1.5 rounded-xl text-xs font-medium shrink-0 transition ${isSel ? 'blue-glow' : 'pill-bar text-slate-400'}`;
            btn.textContent = s === 'ALL' ? 'Все предметы' : s;
            btn.onclick = () => { activeMaterialSubjectFilter = s; renderMaterialsList(); };
            filterContainer.appendChild(btn);
        });
    }

    const filtered = allCombined.filter(m => {
        if (activeMaterialSubjectFilter === 'ALL') return true;
        return m.subject === activeMaterialSubjectFilter;
    });

    if (filtered.length === 0) {
        container.innerHTML = `
            <div class="app-card p-6 rounded-3xl text-center space-y-2">
                <div class="text-2xl">📚</div>
                <div class="text-sm font-semibold text-white">Учебных материалов пока нет</div>
                <div class="text-xs text-slate-400">Нажмите «➕ Добавить материал», чтобы загрузить учебник на Google Диск группы или сохранить для себя</div>
            </div>
        `;
        return;
    }

    let html = '';
    filtered.forEach(m => {
        const icon = getSubjectIcon(m.subject);
        const badge = m.isGroup 
            ? `<span class="bg-blue-500/20 text-blue-400 border border-blue-500/30 px-2 py-0.5 rounded-md text-[10px] font-bold">👥 Google Диск</span>`
            : `<span class="bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded-md text-[10px] font-bold">👤 Личный</span>`;

        const linkUrl = m.viewUrl || m.fileUrl;
        const canDelete = !m.isGroup || (starostaAuth && starostaAuth.sessionToken);

        html += `
            <div class="app-card p-4 rounded-3xl space-y-2.5">
                <div class="flex items-start justify-between gap-3">
                    <div class="flex items-center gap-3 min-w-0">
                        <div class="w-10 h-10 rounded-2xl pill-bar flex items-center justify-center text-blue-400 font-bold text-base shrink-0">
                            ${icon}
                        </div>
                        <div class="min-w-0">
                            <div class="flex items-center gap-1.5">
                                <span class="text-[10px] text-slate-400 font-semibold truncate">${m.subject}</span>
                                ${badge}
                            </div>
                            <div class="text-sm font-bold text-white mt-0.5 leading-snug">${m.title}</div>
                        </div>
                    </div>
                    ${canDelete ? `<button type="button" onclick='deleteMaterialItem(${JSON.stringify(m).replace(/'/g, "&apos;")})' class="text-slate-400 hover:text-red-400 text-xs shrink-0 p-1">✕</button>` : ''}
                </div>

                <div class="flex items-center justify-between pt-1 text-xs border-t border-slate-700/50">
                    <span class="text-slate-400 text-[11px]">${m.fileSize ? `Файл • ${m.fileSize}` : 'Ссылка'}</span>
                    <a href="${linkUrl}" target="_blank" download="${m.fileName || m.title}" class="blue-glow px-3.5 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1 active:scale-95 transition">
                        <span>Открыть</span>
                        <span>↗</span>
                    </a>
                </div>
            </div>
        `;
    });
    container.innerHTML = html;
}

// ================= ЭКРАН 4: ОЦЕНКИ =================
function setMarksViewMode(mode) {
    marksViewMode = mode;
    document.getElementById('btnMarksBySubj').className = mode === 'subjects' ? "py-2 rounded-xl text-xs font-semibold transition blue-glow" : "py-2 rounded-xl text-xs font-medium transition text-slate-400";
    document.getElementById('btnMarksAll').className = mode === 'all' ? "py-2 rounded-xl text-xs font-semibold transition blue-glow" : "py-2 rounded-xl text-xs font-medium transition text-slate-400";
    loadMarksForActiveSubject();
}

function isSummaryGradeColumn(headerText) {
    const h = String(headerText || '').trim();
    return /^(итог|итог\s+практика|итог\s+1\s*семестр|итог\s+дм|средний\s+балл|в\s+зач[её]тку)(\s*•.*)?$/i.test(h);
}

function updateAverageSummaryCard(finalAvgValue, displayStr) {
    const bigEl = document.getElementById('avgGradeBig');
    const pctEl = document.getElementById('avgPercentText');
    const circleEl = document.getElementById('avgCircleStroke');
    const barEl = document.getElementById('avgHorizontalBar');

    if (finalAvgValue === null || isNaN(finalAvgValue)) {
        bigEl.innerText = displayStr || '—';
        pctEl.innerText = '0%';
        circleEl.setAttribute('stroke-dasharray', '0, 100');
        barEl.style.width = '0%';
        return;
    }

    const pct = Math.min(100, Math.max(0, Math.round((finalAvgValue / 5) * 100)));
    bigEl.innerText = displayStr || finalAvgValue.toFixed(2).replace('.', ',');
    pctEl.innerText = `${pct}%`;
    circleEl.setAttribute('stroke-dasharray', `${pct}, 100`);
    barEl.style.width = `${pct}%`;
}

function extractSheetId(link) {
    const match = String(link || '').match(/\/d\/([a-zA-Z0-9-_]+)/);
    return match ? match[1] : null;
}

async function fetchGroupsList() {
    const link = document.getElementById('sheetLinkInput').value.trim();
    const sheetId = extractSheetId(link);
    if (!sheetId) { alert("Вставьте ссылку на Google Таблицу!"); return; }
    const btn = document.getElementById('scanTabsBtn');
    btn.innerText = "⏳ Ищем...";
    document.getElementById('groupSelectBlock').classList.add('hidden');
    document.getElementById('studentSelectBlock').classList.add('hidden');
    try {
        const res = await fetch(`https://docs.google.com/spreadsheets/d/${sheetId}/export?format=xlsx`);
        if (!res.ok) throw new Error("Проверьте доступ к таблице");
        const arrayBuffer = await res.arrayBuffer();
        tempMarksWorkbook = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array' });
        renderSheetGroupButtons(tempMarksWorkbook.SheetNames || []);
        document.getElementById('groupSelectBlock').classList.remove('hidden');
    } catch (e) { alert("Ошибка: " + e.message); } finally { btn.innerText = "Найти группы"; }
}

function renderSheetGroupButtons(tabs) {
    const container = document.getElementById('groupsButtonsContainer');
    container.innerHTML = '';
    tabs.forEach(tabName => {
        const isSelected = selectedGroupForMarks === tabName;
        const cls = isSelected ? "blue-glow" : "pill-bar text-slate-200";
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `px-3.5 py-2 rounded-xl text-xs font-bold transition ${cls}`;
        btn.textContent = `👥 ${tabName}`;
        btn.onclick = () => selectGroupForMarks(tabName);
        container.appendChild(btn);
    });
}

function analyzeMatrix(matrix) {
    let bestCol = 1, maxNamesCount = 0;
    const maxCols = Math.min(10, matrix[0] ? matrix[0].length : 0);
    for (let col = 0; col < maxCols; col++) {
        let count = 0;
        for (let row = 0; row < matrix.length; row++) {
            let cell = String(matrix[row][col] || '').trim();
            if (/[а-яёА-ЯЁ]{2,}\s+[а-яёА-ЯЁ]{2,}/.test(cell) && !/(задание|лекция|практика|модуль|вопрос|итог|экзамен|фамилия)/i.test(cell)) count++;
        }
        if (count > maxNamesCount) { maxNamesCount = count; bestCol = col; }
    }
    let firstStudRow = 1;
    for (let row = 0; row < matrix.length; row++) {
        let cell = String(matrix[row][bestCol] || '').trim();
        if (/[а-яёА-ЯЁ]{2,}\s+[а-яёА-ЯЁ]{2,}/.test(cell) && !/(фио|студент|фамилия|список)/i.test(cell)) { firstStudRow = row; break; }
    }
    return { nameColIdx: bestCol, firstStudentRow: firstStudRow };
}

async function selectGroupForMarks(groupName) {
    if (!groupName) return;
    selectedGroupForMarks = groupName;
    if (tempMarksWorkbook) renderSheetGroupButtons(tempMarksWorkbook.SheetNames);
    try {
        let matrix = [];
        if (tempMarksWorkbook && tempMarksWorkbook.Sheets[groupName]) {
            matrix = XLSX.utils.sheet_to_json(tempMarksWorkbook.Sheets[groupName], { header: 1, defval: "", raw: false });
        } else {
            const sheetId = extractSheetId(document.getElementById('sheetLinkInput').value.trim());
            const res = await fetch(`https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(groupName)}&_t=${Date.now()}`);
            matrix = Papa.parse(await res.text(), { skipEmptyLines: true }).data;
        }
        const { nameColIdx, firstStudentRow } = analyzeMatrix(matrix);
        const select = document.getElementById('studentSelect');
        select.innerHTML = '<option value="">-- Выберите своё ФИО --</option>';
        for (let r = firstStudentRow; r < matrix.length; r++) {
            let name = String(matrix[r][nameColIdx] || '').trim();
            if (name && /[а-яёА-ЯЁ]{2,}/.test(name) && isNaN(name) && !/(фамилия|фио|студент)/i.test(name)) {
                const opt = document.createElement('option');
                opt.value = name; opt.textContent = name; select.appendChild(opt);
            }
        }
        document.getElementById('studentSelectBlock').classList.remove('hidden');
    } catch (err) { alert("Ошибка: " + err.message); }
}

function saveSubjectProfile() {
    let subjName = document.getElementById('subjectNameInput').value.trim();
    const link = document.getElementById('sheetLinkInput').value.trim();
    const studentName = document.getElementById('studentSelect').value;
    if (!studentName) { alert("Выберите свое ФИО!"); return; }
    if (!subjName) subjName = "Предмет " + (subjects.length + 1);
    subjects.push({ subjectName: subjName, sheetId: extractSheetId(link), groupName: selectedGroupForMarks, studentName });
    localStorage.setItem(STORAGE_MARKS_KEY, JSON.stringify(subjects));
    activeSubjectIndex = subjects.length - 1;
    openProfileModal();
}

function openAddSubject() {
    const allSecs = ['scheduleSection', 'changesSection', 'tasksSection', 'marksSection', 'setupScheduleScreen', 'addTaskModal', 'addMaterialModal', 'profileSection'];
    allSecs.forEach(id => document.getElementById(id).classList.add('hidden'));
    document.getElementById('setupScreen').classList.remove('hidden');
    document.getElementById('groupSelectBlock').classList.add('hidden');
    document.getElementById('studentSelectBlock').classList.add('hidden');
    document.getElementById('subjectNameInput').value = '';
    document.getElementById('sheetLinkInput').value = '';
    selectedGroupForMarks = '';
    tempMarksWorkbook = null;
}

function renderSubjectTabs() {
    const container = document.getElementById('subjectsTabs');
    container.innerHTML = '';
    if (subjects.length === 0) return;
    subjects.forEach((subj, idx) => {
        const isActive = idx === activeSubjectIndex;
        container.innerHTML += `
            <div onclick="switchSubject(${idx})" class="flex items-center rounded-xl px-3.5 py-1.5 text-xs font-semibold shrink-0 cursor-pointer transition ${isActive ? 'blue-glow' : 'app-card text-slate-400'}">
                <span>${subj.subjectName}</span>
            </div>
        `;
    });
}

function switchSubject(idx) {
    activeSubjectIndex = idx;
    marksViewMode = 'all';
    setMarksViewMode('all');
}

function renderProfileSubjectsList() {
    const container = document.getElementById('profileSubjectsList');
    if (!container) return;
    container.innerHTML = '';

    if (subjects.length === 0) {
        container.innerHTML = `<div class="pill-bar p-3.5 rounded-2xl text-center text-xs text-slate-400">Ни одного дневника оценок ещё не подключено</div>`;
        return;
    }

    subjects.forEach((subj, idx) => {
        const icon = getSubjectIcon(subj.subjectName);
        const div = document.createElement('div');
        div.className = "pill-bar p-3 rounded-2xl flex items-center justify-between gap-2";
        div.innerHTML = `
            <div class="flex items-center gap-3 min-w-0">
                <div class="w-9 h-9 rounded-xl app-card flex items-center justify-center text-blue-400 font-bold text-sm shrink-0">${icon}</div>
                <div class="min-w-0">
                    <div class="text-xs font-bold text-white truncate">${subj.subjectName}</div>
                    <div class="text-[11px] text-slate-400 truncate">${subj.studentName} • Гр. ${subj.groupName}</div>
                </div>
            </div>
            <button type="button" onclick="deleteSubjectFromProfile(${idx})" class="bg-red-500/15 hover:bg-red-500/25 text-red-400 border border-red-500/30 px-3 py-1.5 rounded-xl text-xs font-semibold shrink-0 transition">
                Удалить
            </button>
        `;
        container.appendChild(div);
    });
}

function deleteSubjectFromProfile(idx) {
    if (confirm(`Удалить дневник оценок «${subjects[idx].subjectName}»?`)) {
        subjects.splice(idx, 1);
        localStorage.setItem(STORAGE_MARKS_KEY, JSON.stringify(subjects));
        if (activeSubjectIndex >= subjects.length) activeSubjectIndex = Math.max(0, subjects.length - 1);
        renderProfileSubjectsList();
    }
}

async function loadMarksForActiveSubject() {
    const current = subjects[activeSubjectIndex];
    const container = document.getElementById('marksList');
    renderSubjectTabs();

    if (!current) {
        updateAverageSummaryCard(null, '—');
        container.innerHTML = `
            <div class="app-card rounded-3xl p-6 text-center space-y-3">
                <div class="text-slate-300 text-sm font-semibold">Дневники оценок не подключены</div>
                <div class="text-slate-400 text-xs">Добавление и удаление таблиц доступно в Личном кабинете</div>
                <button type="button" onclick="openProfileModal()" class="blue-glow text-xs font-semibold px-5 py-2.5 rounded-xl">👤 Перейти в профиль</button>
            </div>
        `;
        return;
    }

    document.getElementById('marksUpdatedTime').innerText = `${current.studentName} • Гр. ${current.groupName}`;
    container.innerHTML = '<div class="app-card p-8 rounded-3xl text-center text-slate-400 animate-pulse text-xs">Синхронизация с Google Таблицами...</div>';

    try {
        const url = `https://docs.google.com/spreadsheets/d/${current.sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(current.groupName)}&_t=${Date.now()}`;
        const csvText = await (await fetch(url)).text();

        Papa.parse(csvText, {
            skipEmptyLines: true,
            complete: function(results) {
                const matrix = results.data;
                const { nameColIdx, firstStudentRow } = analyzeMatrix(matrix);
                let studentRow = matrix.slice(firstStudentRow).find(r => String(r[nameColIdx] || '').trim() === current.studentName);
                if (!studentRow) {
                    container.innerHTML = '<div class="app-card p-6 rounded-3xl text-center text-red-400 text-xs">Студент не найден в таблице</div>';
                    return;
                }

                const headers = [];
                for (let c = 0; c < studentRow.length; c++) {
                    let parts = [];
                    for (let r = 0; r < firstStudentRow; r++) {
                        let cell = String(matrix[r][c] || '').replace(/\s+/g, ' ').trim();
                        if (cell && !parts.includes(cell)) parts.push(cell);
                    }
                    headers[c] = parts.join(' • ') || `Колонка ${c + 1}`;
                }

                const gradeItems = [];
                const regularGrades = [];
                let officialFinalNum = null;
                let officialFinalStr = null;

                for (let c = 0; c < studentRow.length; c++) {
                    if (c === nameColIdx || c === 0) continue;
                    let rawHeader = headers[c];
                    let val = String(studentRow[c] || '').trim();
                    if (!val || val === '—' || val === '-' || /#(DIV|ДЕЛ|VALUE|ЗНАЧ|REF|Н\/Д)/i.test(val)) continue;
                    if (/^(№|п\/п|№\s*п\/п)$/i.test(rawHeader)) continue;
                    if (/посещаем/i.test(rawHeader) || /^\d{1,2}\.\d{1,2}(\.\d{2,4})?$/.test(rawHeader)) continue;

                    const isSummaryCol = isSummaryGradeColumn(rawHeader);
                    const num = parseFloat(val.replace(',', '.'));

                    if (!isNaN(num) && !val.includes('%')) {
                        if (isSummaryCol) {
                            officialFinalNum = num;
                            officialFinalStr = val.replace('.', ',');
                        } else if (num >= 0 && num <= 10) {
                            regularGrades.push(num);
                        }
                    } else if (isSummaryCol && val) {
                        officialFinalStr = val;
                    }
                    gradeItems.push({ header: rawHeader, val: val.replace('.', ','), isSummary: isSummaryCol });
                }

                let finalAvgNum = officialFinalNum;
                let finalAvgStr = officialFinalStr;

                if (finalAvgNum === null && regularGrades.length > 0) {
                    finalAvgNum = regularGrades.reduce((a, b) => a + b, 0) / regularGrades.length;
                    if (!finalAvgStr) finalAvgStr = finalAvgNum.toFixed(2).replace(/\.?0+$/, '').replace('.', ',');
                }

                updateAverageSummaryCard(finalAvgNum, finalAvgStr);
                cachedSubjectSummaries[activeSubjectIndex] = {
                    avg: finalAvgStr || '—',
                    count: regularGrades.length || gradeItems.length
                };

                if (marksViewMode === 'subjects') {
                    let subjHtml = '';
                    subjects.forEach((s, idx) => {
                        const summary = cachedSubjectSummaries[idx] || { avg: '•', count: '' };
                        const icon = getSubjectIcon(s.subjectName);
                        subjHtml += `
                            <div onclick="switchSubject(${idx})" class="app-card p-4 rounded-3xl flex items-center justify-between cursor-pointer transition">
                                <div class="flex items-center gap-3.5">
                                    <div class="w-11 h-11 rounded-2xl pill-bar flex items-center justify-center text-blue-400 font-bold text-base">${icon}</div>
                                    <div>
                                        <div class="font-bold text-sm text-white">${s.subjectName}</div>
                                        <div class="text-xs text-slate-400 mt-0.5">Гр. ${s.groupName} ${summary.count ? `• Работ: ${summary.count}` : ''}</div>
                                    </div>
                                </div>
                                <div class="flex items-center gap-2">
                                    <span class="text-xl font-extrabold text-white">${summary.avg}</span>
                                    <span class="text-slate-400">›</span>
                                </div>
                            </div>
                        `;
                    });
                    container.innerHTML = subjHtml;
                } else {
                    let html = '';
                    gradeItems.forEach(item => {
                        const cardBorder = item.isSummary ? 'border-blue-500/60' : '';
                        const badgeCls = item.isSummary ? 'blue-glow' : 'pill-bar text-blue-400';
                        html += `
                            <div class="app-card p-3.5 rounded-2xl flex justify-between items-center gap-3 ${cardBorder}">
                                <span class="text-xs ${item.isSummary ? 'font-bold text-blue-400 uppercase' : 'text-slate-200'} leading-snug">${item.header}</span>
                                <span class="${badgeCls} font-extrabold px-3 py-1.5 rounded-xl text-sm shrink-0">${item.val}</span>
                            </div>
                        `;
                    });
                    container.innerHTML = html || '<div class="app-card p-6 rounded-3xl text-center text-slate-400 text-xs">Выставленных оценок пока нет</div>';
                }
            }
        });
    } catch (e) {
        container.innerHTML = `<div class="app-card p-6 rounded-3xl text-center text-red-400 text-xs">Ошибка: ${e.message}</div>`;
    }
}

function hardReset() {
    if (confirm("Сбросить все оценки, расписание, задания и замены?")) {
        localStorage.clear();
        location.reload();
    }
}
