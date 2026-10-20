import asyncio
import logging
from aiogram import Bot, Dispatcher, types
from aiogram.filters import Command
from aiogram.utils.keyboard import InlineKeyboardBuilder

API_TOKEN = '8789843979:AAEKRzTP8Fpas-TBEHvg7m9Ek0bQPOzegEM' # Твой токен от BotFather
WEB_APP_URL = 'https://dnevnik-ptk.github.io/dnevnik/' # Сюда укажешь ссылку на хостинг, где будет лежать index.html

bot = Bot(token=API_TOKEN)
dp = Dispatcher()

@dp.message(Command("start"))
async def cmd_start(message: types.Message):
    builder = InlineKeyboardBuilder()
    # Кнопка, открывающая Mini App
    builder.button(text="📖 Открыть дневник оценок", web_app=types.WebAppInfo(url=WEB_APP_URL))
    builder.adjust(1)
    
    await message.answer(
        "👋 Привет! Это твой личный дневник.\n\n"
        "Нажми на кнопку ниже, чтобы открыть приложение:",
        reply_markup=builder.as_markup()
    )

async def main():
    await dp.start_polling(bot)

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())
