import { render } from "./template.js";
import type {
  ControllerNode,
  ControllerDecision,
  TemplateContext,
} from "./types.js";

const DEEPSEEK_BASE = "https://api.deepseek.com/v1";

export class ControllerRunner {
  static async evaluate(
    node: ControllerNode,
    context: TemplateContext
  ): Promise<ControllerDecision> {
    // 1. Render the controller prompt
    const prompt = render(node.promptTemplate, context);

    // 2. Call the model
    const rawResponse = await ControllerRunner.callModel(
      node.model,
      prompt,
      node.apiKey
    );

    // 3. Parse the JSON decision
    const decision = ControllerRunner.parseDecision(rawResponse, node);

    // 4. Validate against output guards
    ControllerRunner.validateOutputGuard(decision, node, context);

    // 5. Check confidence
    const minConf = node.limits?.minConfidence ?? 0.5;
    if (decision.confidence < minConf) {
      console.warn(
        `Controller "${node.id}" confidence ${decision.confidence} below minimum ${minConf}`
      );
    }

    return decision;
  }

  private static async callModel(
    model: string,
    prompt: string,
    apiKey?: string
  ): Promise<string> {
    const key =
      apiKey ||
      process.env.DEEPSEEK_API_KEY ||
      process.env.OPENAI_API_KEY;

    if (!key) {
      throw new Error(
        `No API key found for controller model "${model}". ` +
        `Set DEEPSEEK_API_KEY environment variable or configure apiKey on the node.`
      );
    }

    const response = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content:
              "You are a graph controller. You must respond with valid JSON only, no other text.",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 1024,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(
        `DeepSeek API error (${response.status}): ${errText.slice(0, 300)}`
      );
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error(
        `DeepSeek API returned no content: ${JSON.stringify(data).slice(0, 200)}`
      );
    }

    return content;
  }

  private static parseDecision(
    raw: string,
    node: ControllerNode
  ): ControllerDecision {
    // Extract JSON from response (handle markdown code blocks)
    let jsonStr = raw.trim();
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      throw new Error(
        `Controller "${node.id}" returned invalid JSON:\n${raw.slice(0, 300)}`
      );
    }

    if (!parsed.selected_output || typeof parsed.selected_output !== "string") {
      throw new Error(
        `Controller "${node.id}" decision missing "selected_output":\n${jsonStr.slice(0, 200)}`
      );
    }

    // Validate selected_output exists
    if (!(parsed.selected_output in (node.outputs || {}))) {
      throw new Error(
        `Controller "${node.id}" selected unknown output "${parsed.selected_output}". ` +
        `Available: ${Object.keys(node.outputs || {}).join(", ")}`
      );
    }

    return {
      selected_output: parsed.selected_output as string,
      reason:
        typeof parsed.reason === "string"
          ? parsed.reason
          : "No reason provided",
      confidence:
        typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      payload: parsed.payload,
    };
  }

  private static validateOutputGuard(
    decision: ControllerDecision,
    node: ControllerNode,
    context: TemplateContext
  ): void {
    const guardExpr = node.outputGuards?.[decision.selected_output];
    if (!guardExpr) return;

    const result = evaluateGuard(guardExpr, context);
    if (!result) {
      throw new Error(
        `Controller "${node.id}" output guard failed for "${decision.selected_output}". ` +
        `Expression: ${guardExpr}`
      );
    }
  }
}

// ─── Simple guard expression evaluator ─────────────────────────────

function evaluateGuard(
  expr: string,
  context: TemplateContext
): boolean {
  // Replace all {{...}} expressions with their literal values
  let resolved = expr;

  // Match {{path.to.value}} patterns
  const templateRegex = /\{\{([^}]+)\}\}/g;
  let match;
  while ((match = templateRegex.exec(expr)) !== null) {
    const path = match[1].trim();
    const value = resolvePath(path, context);
    resolved = resolved.replace(match[0], JSON.stringify(value));
  }

  // Now evaluate the resolved expression safely
  return safeEvalBool(resolved);
}

function resolvePath(
  path: string,
  context: TemplateContext
): unknown {
  const parts = path.split(".");
  let current: unknown = context;

  for (const part of parts) {
    if (current === null || current === undefined) return null;
    if (typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
    } else {
      return null;
    }
  }

  return current;
}

function safeEvalBool(expr: string): boolean {
  const trimmed = expr.trim();

  // Handle boolean literals
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;

  // Handle numeric comparisons: 0 == 0, 1 < 3, etc.
  const compMatch = trimmed.match(
    /^([\d.]+|true|false|null)\s*(==|!=|>=|<=|>|<)\s*([\d.]+|true|false|null)$/
  );
  if (compMatch) {
    const left = parseValue(compMatch[1]);
    const op = compMatch[2];
    const right = parseValue(compMatch[3]);

    switch (op) {
      case "==": return left === right;
      case "!=": return left !== right;
      case ">=": return left >= right;
      case "<=": return left <= right;
      case ">":  return left > right;
      case "<":  return left < right;
    }
  }

  // Handle logical operators: a && b, a || b
  const andMatch = trimmed.match(/^(.*?)\s*&&\s*(.*)$/);
  if (andMatch) {
    return safeEvalBool(andMatch[1]) && safeEvalBool(andMatch[2]);
  }

  const orMatch = trimmed.match(/^(.*?)\s*\|\|\s*(.*)$/);
  if (orMatch) {
    return safeEvalBool(orMatch[1]) || safeEvalBool(orMatch[2]);
  }

  // Fallback: treat as truthy
  console.warn(`Guard expression couldn't be evaluated: "${trimmed}", treating as true`);
  return true;
}

function parseValue(v: string): number | boolean {
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return 0;
  const n = Number(v);
  if (!isNaN(n)) return n;
  return 0;
}
