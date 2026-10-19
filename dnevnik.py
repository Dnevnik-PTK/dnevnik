import asyncio
import logging
import re
import urllib.parse
import pandas as pd
from aiogram import Bot, Dispatcher, F, types
from aiogram.filters import Command
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.utils.keyboard import InlineKeyboardBuilder, ReplyKeyboardBuilder

API_TOKEN = '8966187302:AAFtVDy98EZRhaKBmc8iOO8fFAc56J86Mhg'

bot = Bot(token=API_TOKEN)
dp = Dispatcher()


class AuthState(StatesGroup):
    waiting_for_sheet_link = State()
    waiting_for_subject_name = State()
    waiting_for_group = State()
    waiting_for_student = State()


# { telegram_id: { "subject_name": { "sheet_id": "...", "group": "...", "name": "..." }, ... } }
user_sessions = {}


def get_main_keyboard():
    builder = ReplyKeyboardBuilder()
    builder.button(text="📚 Мои оценки")
    builder.button(text="🔗 Добавить таблицу")
    builder.button(text="🔄 Сбросить настройки")
    builder.adjust(1, 2)
    return builder.as_markup(resize_keyboard=True)


@dp.message(Command("start"))
async def cmd_start(message: types.Message):
    await message.answer(
        "👋 Йоу! Я твой бот-дневник.\n\n"
        "Я умею собирать оценки из твоих Google Таблиц и показывать только твои данные.\n"
        "Используй кнопки внизу для управления 👇",
        reply_markup=get_main_keyboard()
    )


@dp.message(F.text == "🔗 Добавить таблицу")
@dp.message(Command("link"))
async def cmd_link(message: types.Message, state: FSMContext):
    await message.answer(
        "🔗 Отправь ссылку на новую Google Таблицу:\n"
        "*(Убедись, что таблица доступна всем по ссылке)*",
        reply_markup=get_main_keyboard()
    )
    await state.set_state(AuthState.waiting_for_sheet_link)


@dp.message(AuthState.waiting_for_sheet_link)
async def process_sheet_link(message: types.Message, state: FSMContext):
    link = message.text.strip()
    match = re.search(r"/d/([a-zA-Z0-9-_]+)", link)
    if not match:
        await message.answer("❌ Ссылка не похожа на Google Таблицу. Попробуй еще раз.")
        return

    sheet_id = match.group(1)

    try:
        csv_url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=csv"
        pd.read_csv(csv_url)

        await state.update_data(sheet_id=sheet_id)

        await message.answer(
            "✅ Таблица найдена!\n\n"
            "Как назовем этот предмет или категорию? (например: *Информатика*, *Матанализ* и т.д.):"
        )
        await state.set_state(AuthState.waiting_for_subject_name)

    except Exception as e:
        await message.answer(f"❌ Не удалось открыть таблицу. Убедись, что у неё открыт публичный доступ.\nОшибка: {e}")


@dp.message(AuthState.waiting_for_subject_name)
async def process_subject_name(message: types.Message, state: FSMContext):
    subject_name = message.text.strip()
    await state.update_data(subject_name=subject_name)

    await message.answer(
        f"📚 Предмет: **{subject_name}**\n\n"
        "Теперь напиши название своей группы (вкладки) **точно так же, как внизу в таблице** (например: `5952`):",
        parse_mode="Markdown"
    )
    await state.set_state(AuthState.waiting_for_group)


@dp.message(AuthState.waiting_for_group)
async def process_group_text(message: types.Message, state: FSMContext):
    group_name = message.text.strip()
    await state.update_data(group=group_name)

    data = await state.get_data()
    sheet_id = data['sheet_id']

    try:
        encoded_group = urllib.parse.quote(group_name)
        csv_url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/gviz/tq?tqx=out:csv&sheet={encoded_group}"
        df = pd.read_csv(csv_url)

        name_key = None
        for col in df.columns:
            if any(word in str(col).lower() for word in ['name', 'фио', 'студент', 'ф.и.о.']):
                name_key = col
                break
        if not name_key and len(df.columns) > 0:
            name_key = df.columns[0]

        students = df[name_key].dropna().astype(str).tolist()

        if not students:
            await message.answer(f"⚠️ В группе **{group_name}** не найдено студентов. Проверь название группы.")
            return

        # Сохраняем список студентов во временное состояние для безопасной индексации
        await state.update_data(students_list=students, name_key=name_key)

        builder = InlineKeyboardBuilder()
        for idx, student in enumerate(students):
            # Передаем только индекс (защита от лимита Telegram BUTTON_DATA_INVALID)
            builder.button(text=student, callback_data=f"student_{idx}")
        builder.adjust(1)

        await message.answer(
            f"Группа: **{group_name}**\n\nТеперь выбери **своё ФИО** из списка ниже:",
            reply_markup=builder.as_markup(),
            parse_mode="Markdown"
        )
        await state.set_state(AuthState.waiting_for_student)

    except Exception as e:
        await message.answer(
            f"❌ Не удалось загрузить вкладку '{group_name}'. Убедись, что название указано верно.\nОшибка: {e}")


@dp.callback_query(F.data.startswith("student_"), AuthState.waiting_for_student)
async def process_student(callback: types.CallbackQuery, state: FSMContext):
    idx = int(callback.data.split("_")[1])
    user_data = await state.get_data()

    students_list = user_data.get("students_list", [])
    if idx >= len(students_list):
        await callback.message.answer("❌ Ошибка выбора. Попробуй заново.")
        return

    student_name = students_list[idx]
    user_id = callback.from_user.id
    subject_name = user_data["subject_name"]

    if user_id not in user_sessions:
        user_sessions[user_id] = {}

    user_sessions[user_id][subject_name] = {
        "sheet_id": user_data["sheet_id"],
        "group": user_data["group"],
        "name": student_name
    }

    await state.clear()

    await callback.message.edit_text(
        f"✅ Предмет **«{subject_name}»** успешно настроен!\n"
        f"👤 {student_name} (Группа: {user_data['group']})\n\n"
        f"Теперь ты можешь в любой момент нажать кнопку «📚 Мои оценки»."
    )


@dp.message(F.text == "📚 Мои оценки")
@dp.message(Command("marks"))
async def cmd_marks(message: types.Message):
    user_id = message.from_user.id
    user_subjects = user_sessions.get(user_id)

    if not user_subjects:
        await message.answer("Ты еще не добавил ни одной таблицы! Нажми «🔗 Добавить таблицу» внизу.",
                             reply_markup=get_main_keyboard())
        return

    if len(user_subjects) > 1:
        builder = InlineKeyboardBuilder()
        for subj in user_subjects.keys():
            builder.button(text=subj, callback_data=f"show_subj_{subj}")
        builder.adjust(1)
        await message.answer("📚 Выбери предмет, по которому хочешь посмотреть оценки:",
                             reply_markup=builder.as_markup())
        return

    subject_name = list(user_subjects.keys())[0]
    await send_marks_for_subject(message, user_id, subject_name)


@dp.callback_query(F.data.startswith("show_subj_"))
async def process_show_subject(callback: types.CallbackQuery):
    subject_name = callback.data.split("_", 2)[2]
    await callback.message.delete()
    await send_marks_for_subject(callback.message, callback.from_user.id, subject_name)


async def send_marks_for_subject(message: types.Message, user_id: int, subject_name: str):
    user_data = user_sessions[user_id][subject_name]

    try:
        encoded_group = urllib.parse.quote(user_data['group'])
        csv_url = f"https://docs.google.com/spreadsheets/d/{user_data['sheet_id']}/gviz/tq?tqx=out:csv&sheet={encoded_group}"
        df = pd.read_csv(csv_url)

        name_key = None
        for col in df.columns:
            if any(word in str(col).lower() for word in ['name', 'фио', 'студент', 'ф.и.о.']):
                name_key = col
                break
        if not name_key:
            name_key = df.columns[0]

        student_row = df[df[name_key].astype(str) == user_data['name']]

        if student_row.empty:
            await message.answer(f"❌ Не удалось найти твои данные в таблице предмета «{subject_name}».",
                                 reply_markup=get_main_keyboard())
            return

        row_dict = student_row.iloc[0].to_dict()

        response = f"📊 **Оценки по предмету: {subject_name}**\n👤 {user_data['name']}\n\n"
        count = 0

        for key, value in row_dict.items():
            if key == name_key:
                continue
            if pd.isna(value) or str(value).strip() in ['', '—', '-']:
                continue
            if 'Unnamed' in str(key) or '№' in str(key):
                continue

            response += f"• **{key}**: {value}\n"
            count += 1

        if count == 0:
            response += "Пока нет выставленных оценок."

        await message.answer(response, parse_mode="Markdown", reply_markup=get_main_keyboard())

    except Exception as e:
        await message.answer(f"❌ Ошибка при получении оценок для «{subject_name}»: {e}",
                             reply_markup=get_main_keyboard())


@dp.message(F.text == "🔄 Сбросить настройки")
@dp.message(Command("reset"))
async def cmd_reset(message: types.Message, state: FSMContext):
    user_id = message.from_user.id
    if user_id in user_sessions:
        del user_sessions[user_id]
    await state.clear()
    await message.answer("🔄 Все настройки и таблицы сброшены.", reply_markup=get_main_keyboard())


async def main():
    await dp.start_polling(bot)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())