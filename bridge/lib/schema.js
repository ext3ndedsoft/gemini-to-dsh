/**
 * OpenAI tool declarations -> Gemini function declarations.
 *
 * The mapping used to be lossy in ways that changed behaviour: integer enums were
 * stringified (so the model sent "3" where the tool wanted 3), `type: ["string",
 * "null"]` became STRING (nullable arguments lost their shape) and any tool that
 * was not wrapped in `{type:"function"}` was dropped without a word. Tools are the
 * whole point of an agent bridge, so this file keeps every field Gemini accepts
 * and refuses to guess silently.
 */

import { log } from './config.js';

const TYPE_MAP = {
  object: 'OBJECT',
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
  array: 'ARRAY',
  null: 'NULL',
};

const THINKING_BUDGETS = { minimal: 128, low: 1024, medium: 8192, high: 24576, xhigh: 32768 };

/** Gemini has no union types: a nullable field is just its non-null half. */
function baseType(schema) {
  const type = schema.type;
  if (Array.isArray(type)) {
    const named = type.map((entry) => String(entry).toLowerCase()).filter((entry) => entry !== 'null');
    return named[0] || 'null';
  }
  if (type) return String(type).toLowerCase();
  if (schema.properties || schema.additionalProperties) return 'object';
  if (schema.items) return 'array';
  if (schema.enum && schema.enum.length) {
    const first = schema.enum[0];
    if (typeof first === 'number') return Number.isInteger(first) ? 'integer' : 'number';
    if (typeof first === 'boolean') return 'boolean';
  }
  return 'string';
}

/** Enum entries must keep their primitive type, or the model answers out of type. */
function enumValues(values, type) {
  return values.map((value) => {
    if (type === 'integer' || type === 'number') return Number(value);
    if (type === 'boolean') return value === true || value === 'true';
    return String(value);
  });
}

/** Keeps a caller's description when a union was collapsed into its first real branch. */
function withOuterDescription(out, schema) {
  if (schema.description && !out.description) out.description = schema.description;
  return out;
}

export function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'OBJECT', properties: {} };

  if (Array.isArray(schema.anyOf) && schema.anyOf.length) {
    const nonNull = schema.anyOf.find((entry) => entry && String(entry.type).toLowerCase() !== 'null');
    return withOuterDescription(toGeminiSchema(nonNull || schema.anyOf[0]), schema);
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length) {
    const nonNull = schema.oneOf.find((entry) => entry && String(entry.type).toLowerCase() !== 'null');
    return withOuterDescription(toGeminiSchema(nonNull || schema.oneOf[0]), schema);
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length) {
    return withOuterDescription(toGeminiSchema(Object.assign({}, ...schema.allOf)), schema);
  }

  const type = baseType(schema);
  const out = { type: TYPE_MAP[type] || 'STRING' };
  if (schema.description) out.description = schema.description;
  if (schema.title) out.title = schema.title;
  if (Array.isArray(schema.enum) && schema.enum.length) out.enum = enumValues(schema.enum, type);
  if (schema.format === 'date-time' || schema.format === 'date' || schema.format === 'time') {
    out.format = schema.format;
  }
  if (typeof schema.minimum === 'number') out.minimum = schema.minimum;
  if (typeof schema.maximum === 'number') out.maximum = schema.maximum;
  if (typeof schema.minItems === 'number') out.minItems = schema.minItems;
  if (typeof schema.maxItems === 'number') out.maxItems = schema.maxItems;
  // Gemini's Schema accepts these as well; dropping them made the model guess at
  // constraints the caller had already stated.
  if (typeof schema.minLength === 'number') out.minLength = schema.minLength;
  if (typeof schema.maxLength === 'number') out.maxLength = schema.maxLength;
  if (typeof schema.minProperties === 'number') out.minProperties = schema.minProperties;
  if (typeof schema.maxProperties === 'number') out.maxProperties = schema.maxProperties;
  if (typeof schema.pattern === 'string') out.pattern = schema.pattern;
  if (schema.nullable === true) out.nullable = true;
  if (schema.default !== undefined) out.default = schema.default;
  if (schema.example !== undefined) out.example = schema.example;

  if (out.type === 'OBJECT') {
    out.properties = {};
    for (const [key, value] of Object.entries(schema.properties || {})) {
      out.properties[key] = toGeminiSchema(value);
    }
    if (Array.isArray(schema.required) && schema.required.length) out.required = schema.required;
  }
  if (out.type === 'ARRAY') {
    out.items = toGeminiSchema(schema.items || { type: 'string' });
  }
  return out;
}

/**
 * Accepts both shapes in the wild: OpenAI's `{type:"function", function:{...}}`
 * and the bare `{name, description, parameters}` that DSH's own request headers
 * carry. Returns null when there is nothing to declare.
 */
export function toolDeclarations(tools) {
  if (!Array.isArray(tools) || !tools.length) return null;
  const declarations = [];
  const skipped = [];

  for (const tool of tools) {
    const fn = tool && ((tool.type === 'function' && tool.function) || (tool.name ? tool : null));
    if (!fn || !fn.name) {
      skipped.push(tool && (tool.name || tool.type) ? String(tool.name || tool.type) : 'unnamed');
      continue;
    }
    const declaration = { name: fn.name };
    if (fn.description) declaration.description = fn.description;
    const parameters = toGeminiSchema(fn.parameters || {});
    // Function declarations must be OBJECT-shaped; hanging `properties` on a
    // STRING schema produced a declaration upstream refuses.
    declaration.parameters = parameters.type === 'OBJECT' ? parameters : { type: 'OBJECT', properties: {} };
    if (!declaration.parameters.properties) declaration.parameters.properties = {};
    declarations.push(declaration);
  }

  if (skipped.length) {
    log(`skipped ${skipped.length} tool declaration(s) without a name: ${skipped.slice(0, 5).join(', ')}`);
  }
  return declarations.length ? [{ functionDeclarations: declarations }] : null;
}

/**
 * OpenAI `tool_choice` -> Gemini `functionCallingConfig`. Without this every value
 * collapsed into upstream's AUTO default: `none` still called tools, and a forced
 * function could not be forced.
 */
export function functionCallingConfig(toolChoice) {
  if (toolChoice === undefined || toolChoice === null) return null;
  if (typeof toolChoice === 'string') {
    const mode = { auto: 'AUTO', none: 'NONE', required: 'ANY', any: 'ANY' }[toolChoice];
    return mode ? { functionCallingConfig: { mode } } : null;
  }
  if (typeof toolChoice !== 'object') return null;
  const name = (toolChoice.function && toolChoice.function.name) || toolChoice.name;
  if (name) return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [String(name)] } };
  const mode = toolChoice.type === 'none' ? 'NONE' : toolChoice.type === 'any' || toolChoice.type === 'required' ? 'ANY' : null;
  return mode ? { functionCallingConfig: { mode } } : null;
}

/**
 * Gemini keeps thinking and the answer in one output window, so a budget that
 * eats the window leaves the model with nothing to answer with. Always leave room
 * for the reply, and let a caller force thinking off on a retry.
 */
export function thinkingConfig(effort, maxTokens, mode) {
  if (mode === 'off') return { thinkingBudget: 0, includeThoughts: false };
  if (mode === 'minimal') return { thinkingBudget: THINKING_BUDGETS.minimal, includeThoughts: false };

  const cap = typeof maxTokens === 'number' ? maxTokens : 32768;
  // Thinking and the answer share one window: a 32-token probe with a 256-token
  // thought comes back empty, so a tiny window gets no thinking at all.
  if (cap < 1024) return { thinkingBudget: 0, includeThoughts: true };
  const room = Math.max(256, cap - 1024);
  const key = String(effort || '').toLowerCase();
  const budget = Math.min(THINKING_BUDGETS[key] || THINKING_BUDGETS.medium, room);
  if (budget < THINKING_BUDGETS.minimal) return { includeThoughts: true };
  return { thinkingBudget: budget, includeThoughts: true };
}
