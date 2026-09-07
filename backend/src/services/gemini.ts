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
  'gemini-3.6-flash',
  'gemini-flash-latest',
  'gemini-2.5-flash-lite'
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

  const prompt = `You are an expert nutritionist API. You strictly output JSON.
Analyze the food image.
Return JSON with the following structure:
{
  "name": "Food Name in Russian (start with uppercase)",
  "calories": number,
  "protein": number,
  "fat": number,
  "carbs": number,
  "ingredients": ["ingredient1 in Russian", "ingredient2 in Russian"],
  "weightG": number,
  "confidence": number
}
If the image does not contain food, return:
{
  "name": "Не еда",
  "calories": 0,
  "protein": 0,
  "fat": 0,
  "carbs": 0,
  "ingredients": [],
  "weightG": 0,
  "confidence": 0
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
        // If high demand/temporary unavailable (503/429/404), try next model
        if ([404, 429, 503].includes(response.status) && model !== CANDIDATE_MODELS[CANDIDATE_MODELS.length - 1]) {
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

      const jsonString = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const result = JSON.parse(jsonString);

      const rawIngredients = result.ingredients;
      const ingredients = Array.isArray(rawIngredients)
        ? rawIngredients.map((item: any) => String(item)).filter(Boolean)
        : rawIngredients
          ? [String(rawIngredients)]
          : [];

      return {
        name: result.name || 'Неизвестное блюдо',
        calories: Math.round(Number(result.calories) || 0),
        protein: Math.round((Number(result.protein) || 0) * 10) / 10,
        fat: Math.round((Number(result.fat) || 0) * 10) / 10,
        carbs: Math.round((Number(result.carbs) || 0) * 10) / 10,
        ingredients,
        weightG: Math.round(Number(result.weightG) || 0),
        confidence: Math.min(1, Math.max(0, Number(result.confidence) || 0.9))
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
