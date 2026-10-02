import Anthropic from "@anthropic-ai/sdk";

function client() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

export async function sendMessage(messages: Anthropic.MessageParam[], system = "Ты - ИИ-помощник для логистической платформы грузоперевозок.") {
  try {
    const response = await client().messages.create({
      model: "claude-opus-4-1-20250805",
      max_tokens: 1500,
      temperature: 0.7,
      system,
      messages,
    });
    const block = response.content[0];
    return {
      success: true,
      message: block && block.type === "text" ? block.text : "",
      usage: response.usage,
      timestamp: new Date(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, message: "Ошибка при обработке запроса к AI", error: message };
  }
}

export async function analyzeCargo(cargo: Record<string, unknown>, action: string) {
  let prompt = "";
  if (action === "optimize_route") {
    prompt = `Проанализируй маршрут доставки груза и предложи оптимизацию:
От: ${cargo.address}
До: ${cargo.destiny}
Груз: ${cargo.name}
Вес: ${cargo.weight} кг
Объем: ${cargo.volume} м³`;
  } else if (action === "calculate_price") {
    prompt = `Рассчитай рекомендуемую стоимость перевозки:
От: ${cargo.address}
До: ${cargo.destiny}
Вес: ${cargo.weight} кг`;
  } else {
    prompt = String(cargo.question ?? action);
  }
  return sendMessage([{ role: "user", content: prompt }]);
}
