export interface FoodAnalysis {
  name: string;
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
  ingredients: string[];
  weightG: number;
  confidence: number;
}

const CANDIDATE_MODELS = [
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
  'gemini-flash-latest'
];

export async function analyzeFoodImageGemini(imageInput: string): Promise<FoodAnalysis> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY (or GOOGLE_API_KEY) is missing in environment variables');
  }

  let mimeType = 'image/jpeg';
  let base64Data = '';

  if (imageInput.startsWith('http://') || imageInput.startsWith('https://')) {
    const res = await fetch(imageInput);
    if (!res.ok) {
      throw new Error(`Failed to download image from URL: ${res.status} ${res.statusText}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    mimeType = res.headers.get('content-type') || 'image/jpeg';
    base64Data = buf.toString('base64');
  } else if (imageInput.startsWith('data:')) {
    const match = imageInput.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      mimeType = match[1];
      base64Data = match[2];
    } else {
      throw new Error('Invalid data URL format for image');
    }
  } else {
    base64Data = imageInput;
  }

  const prompt = `Ты — профессиональный ИИ-нутрициолог и эксперт по визуальному анализу блюд по фото.
Твоя цель — максимально точно определить блюдо на фотографии, оценить реальный размер порции в граммах, рассчитать калорийность, БЖУ и выделить основные ингредиенты.

Строгие правила анализа:
1. НАЗВАНИЕ БЛЮДА ("name"):
   - Всегда на русском языке с заглавной буквы.
   - Максимально точное, естественное и аппетитное название.
   - Безупречно распознавай блюда среднеазиатской/таджикской кухни: Плов/Ош (с говядиной, бараниной, нутом), Курутоб (со слоёным фатиром, зеленью и льняным маслом), Самса (с мясом, тыквой), Манты, Лагман, Шурпа, Мастова, Шакароб/Ачик-чучук, Шашлык (из баранины, говядины, курицы, люля), Тандырный нон/лепёшка, Чакка, Казан-кабоб, Димлама.
   - Также точно распознавай блюда славянской кухни (борщ, сырники, гречка с мясом, пельмени), кавказской (хинкали, хачапури) и мировой кухни (пицца, бургеры, суши, паста, стейки, шаурма/донер, салаты, десерты).
   - Если на тарелке комбо из гарнира и основного блюда — назови полно: например, "Картофельное пюре с куриной котлетой и овощами" или "Гречка с тушеной говядиной".
   - Никогда не используй абстрактные слова вроде "Еда", "Тарелка", "Блюдо".

2. ОЦЕНКА ВЕСА ПОРЦИИ ("weightG"):
   - Оценивай вес видимой порции в граммах с учетом посуды и визуального масштаба.
   - Примеры: стандартная тарелка плова ~350-450г, порция супа/шурпы ~350-400г, 1 яблоко ~150-180г, 1 самса ~120-150г, кусок пиццы ~120-150г, порция пасты ~300-350г.

3. КАЛОРИИ И БЖУ ("calories", "protein", "fat", "carbs"):
   - Рассчитай пищевую ценность ИМЕННО ДЛЯ УКАЗАННОГО ВЕСА ПОРЦИИ ("weightG").
   - Правило баланса: Calories ≈ (Protein * 4) + (Fat * 9) + (Carbs * 4). Данные должны быть физиологически точными и непротиворечивыми.

4. ИНГРЕДИЕНТЫ ("ingredients"):
   - Массив из 3-8 основных ингредиентов на русском языке с заглавной буквы.

5. ЕСЛИ НА ФОТО НЕ ЕДА (люди, интерьер, предметы, пустая посуда, животные):
   - Верни: {"name": "Не еда", "calories": 0, "protein": 0, "fat": 0, "carbs": 0, "ingredients": [], "weightG": 0, "confidence": 0}

Верни результат строго в формате JSON:
{
  "name": "Название блюда",
  "calories": number,
  "protein": number,
  "fat": number,
  "carbs": number,
  "ingredients": ["Ингредиент 1", "Ингредиент 2"],
  "weightG": number,
  "confidence": number
}`;

  let lastError: Error | null = null;

  for (const model of CANDIDATE_MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const body = {
      contents: [{
        parts: [
          { text: prompt },
          { inlineData: { mimeType, data: base64Data } }
        ]
      }],
      generationConfig: {
        responseMimeType: 'application/json',
        maxOutputTokens: 2048
      }
    };

    try {
      console.log(`[Gemini] Sending image analysis request to model: ${model}`);
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const errText = await response.text();
        if (model !== CANDIDATE_MODELS[CANDIDATE_MODELS.length - 1]) {
          console.warn(`[Gemini] Model ${model} returned ${response.status}, trying fallback model...`);
          lastError = new Error(`Gemini model ${model} error (${response.status}): ${errText}`);
          continue;
        }
        throw new Error(`Gemini API error (${response.status}): ${errText}`);
      }

      const data: any = await response.json();
      const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!content) {
        throw new Error('Empty response received from Gemini');
      }

      // Safe JSON extraction even if wrapped in markdown codeblocks or text
      const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const jsonStart = cleanContent.indexOf('{');
      const jsonEnd = cleanContent.lastIndexOf('}');
      if (jsonStart === -1 || jsonEnd === -1) {
        throw new Error('Valid JSON object not found in Gemini response');
      }
      const jsonString = cleanContent.substring(jsonStart, jsonEnd + 1);
      const result = JSON.parse(jsonString);

      const rawIngredients = result.ingredients;
      const ingredients = Array.isArray(rawIngredients)
        ? rawIngredients.map((item: any) => String(item).trim()).filter(Boolean)
        : rawIngredients
          ? [String(rawIngredients).trim()]
          : [];

      return {
        name: result.name ? String(result.name).trim() : 'Неизвестное блюдо',
        calories: Math.round(Number(result.calories) || 0),
        protein: Math.round((Number(result.protein) || 0) * 10) / 10,
        fat: Math.round((Number(result.fat) || 0) * 10) / 10,
        carbs: Math.round((Number(result.carbs) || 0) * 10) / 10,
        ingredients,
        weightG: Math.round(Number(result.weightG) || 0),
        confidence: Math.min(1, Math.max(0, Number(result.confidence) || 0.95))
      };
    } catch (err: any) {
      lastError = err;
      if (model !== CANDIDATE_MODELS[CANDIDATE_MODELS.length - 1]) {
        console.warn(`[Gemini] Model ${model} failed: ${err.message}. Trying next fallback...`);
        continue;
      }
    }
  }

  throw lastError || new Error('All Gemini candidate models failed');
}
