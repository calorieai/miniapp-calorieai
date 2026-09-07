import { analyzeFoodImageGemini, FoodAnalysis } from './gemini';

export { FoodAnalysis };

export async function analyzeFoodImage(imageUrl: string): Promise<FoodAnalysis> {
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  // Use Gemini by default if key is available or if OpenAI key is not provided
  if (geminiKey || !openaiKey) {
    try {
      console.log('🤖 Analyzing food image with Google Gemini...');
      return await analyzeFoodImageGemini(imageUrl);
    } catch (geminiError: any) {
      console.error('❌ Gemini Analysis Failed:', geminiError.message);
      if (!openaiKey) {
        throw new Error(`Food analysis failed (Gemini): ${geminiError.message}`);
      }
      console.warn('⚠️ Gemini failed, trying OpenAI as fallback...');
    }
  }

  // OpenAI Provider (only if OPENAI_API_KEY is explicitly set)
  if (!openaiKey) {
    throw new Error('GEMINI_API_KEY is missing in environment variables');
  }

  try {
    console.log('🤖 Analyzing food image with OpenAI...');
    const OpenAIModule = await import('openai');
    const OpenAI = (OpenAIModule as any).default || OpenAIModule;
    const openai = new OpenAI({ apiKey: openaiKey });

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: "json_object" },
      messages: [{
        role: 'system',
        content: 'You are a nutritionist API. You strictly output JSON. Analyze the food image. Estimate weight in grams (weightG), confidence (0.0 to 1.0), and list main ingredients. If not food, return {"name": "Не еда", "calories": 0, "protein": 0, "fat": 0, "carbs": 0, "ingredients": [], "weightG": 0, "confidence": 0}.'
      }, {
        role: 'user',
        content: [
          { type: 'text', text: 'Analyze this image and return JSON: { "name": "Food Name (start with uppercase, in Russian)", "calories": number, "protein": number, "fat": number, "carbs": number, "ingredients": ["ing1", "ing2"], "weightG": number, "confidence": number }' },
          { type: 'image_url', image_url: { url: imageUrl } }
        ]
      }],
      max_tokens: 400
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('No response from OpenAI');

    const jsonString = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const result: FoodAnalysis = JSON.parse(jsonString);

    const rawIngredients = (result as any).ingredients;
    const ingredients = Array.isArray(rawIngredients)
      ? rawIngredients.map((item) => String(item)).filter(Boolean)
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
  } catch (error: any) {
    console.error('❌ OpenAI Analysis Failed:', error.message);
    throw new Error(`AI Analysis Failed: ${error.message}`);
  }
}
