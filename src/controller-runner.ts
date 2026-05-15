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
    const prompt = renderControllerPrompt(node, context);

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
      throw new Error(
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
    if (typeof parsed.confidence !== "number") {
      throw new Error(
        `Controller "${node.id}" decision missing numeric "confidence":\n${jsonStr.slice(0, 200)}`
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
      confidence: parsed.confidence,
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

export function renderControllerPrompt(
  node: ControllerNode,
  context: TemplateContext
): string {
  return render(node.promptTemplate, context);
}

// ─── Simple guard expression evaluator ─────────────────────────────

function evaluateGuard(
  expr: string,
  context: TemplateContext
): boolean {
  const trimmed = expr.trim();
  const templateOnly = trimmed.match(/^\{\{([\s\S]+)\}\}$/);
  if (templateOnly) {
    return Boolean(evaluateExpression(templateOnly[1].trim(), context));
  }

  return Boolean(evaluateExpression(trimmed, context));
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

function evaluateExpression(
  expr: string,
  context: TemplateContext
): unknown {
  const trimmed = expr.trim();

  // Handle boolean literals
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;

  const orParts = splitByOperator(trimmed, "||");
  if (orParts.length > 1) {
    return orParts.some((part) => Boolean(evaluateExpression(part, context)));
  }

  const andParts = splitByOperator(trimmed, "&&");
  if (andParts.length > 1) {
    return andParts.every((part) => Boolean(evaluateExpression(part, context)));
  }

  const compMatch = trimmed.match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (compMatch) {
    const left = resolveOperand(compMatch[1], context);
    const op = compMatch[2];
    const right = resolveOperand(compMatch[3], context);

    switch (op) {
      case "==": return left === right;
      case "!=": return left !== right;
      case ">=": return toComparable(left) >= toComparable(right);
      case "<=": return toComparable(left) <= toComparable(right);
      case ">":  return toComparable(left) > toComparable(right);
      case "<":  return toComparable(left) < toComparable(right);
    }
  }

  return resolveOperand(trimmed, context);
}

function splitByOperator(expr: string, operator: "&&" | "||"): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote: string | null = null;

  for (let i = 0; i < expr.length - 1; i++) {
    const char = expr[i];
    if ((char === "'" || char === '"') && expr[i - 1] !== "\\") {
      quote = quote === char ? null : quote ?? char;
    }
    if (!quote && expr.slice(i, i + 2) === operator) {
      parts.push(expr.slice(start, i).trim());
      start = i + 2;
      i++;
    }
  }

  if (parts.length === 0) return [expr];
  parts.push(expr.slice(start).trim());
  return parts;
}

function resolveOperand(
  raw: string,
  context: TemplateContext
): unknown {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;

  const numeric = Number(value);
  if (!Number.isNaN(numeric) && value !== "") {
    return numeric;
  }

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return resolvePath(value, context);
}

function toComparable(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}
