import { METHODS, type JsonSchema, type OpenApiDocument, type SpecOperation } from "./openapi";

export interface BreakingChange {
  rule: string;
  location: string;
  detail: string;
}

type Direction = "request" | "response";

function resolver(doc: OpenApiDocument) {
  return function resolve(schema: JsonSchema | undefined): JsonSchema {
    if (!schema) return {};
    const ref = schema.$ref;
    if (typeof ref !== "string") return schema;
    return resolve(doc.components.schemas[ref.replace("#/components/schemas/", "")]);
  };
}

const isNull = (schema: JsonSchema) => schema.type === "null";

/** Split `X | null` into X and a nullable flag. Real unions stay as written. */
function unwrapNullable(schema: JsonSchema): { schema: JsonSchema; nullable: boolean } {
  const variants = schema.anyOf as JsonSchema[] | undefined;
  if (!variants?.some(isNull)) return { schema, nullable: false };
  const rest = variants.filter((variant) => !isNull(variant));
  return { schema: rest.length === 1 && rest[0] ? rest[0] : { anyOf: rest }, nullable: true };
}

function properties(schema: JsonSchema): Record<string, JsonSchema> {
  return (schema.properties as Record<string, JsonSchema> | undefined) ?? {};
}

function required(schema: JsonSchema): string[] {
  return (schema.required as string[] | undefined) ?? [];
}

/**
 * Finds changes that would break an existing client. Tightening what the API accepts breaks
 * callers; loosening what it returns breaks readers. Additive changes are deliberately not reported.
 * It covers what this API's generated spec uses, and is not a general OpenAPI diff tool.
 */
export function findBreakingChanges(base: OpenApiDocument, head: OpenApiDocument): BreakingChange[] {
  const changes: BreakingChange[] = [];
  const resolveBase = resolver(base);
  const resolveHead = resolver(head);
  const report = (rule: string, location: string, detail: string) => changes.push({ rule, location, detail });

  function compare(direction: Direction, location: string, rawBase: JsonSchema, rawHead: JsonSchema): void {
    const before = unwrapNullable(resolveBase(rawBase));
    const after = unwrapNullable(resolveHead(rawHead));
    const oldSchema = resolveBase(before.schema);
    const newSchema = resolveHead(after.schema);

    if (direction === "request" && before.nullable && !after.nullable) {
      report("request-no-longer-nullable", location, "null was accepted and is now rejected");
    }
    if (direction === "response" && !before.nullable && after.nullable) {
      report("response-became-nullable", location, "clients may now receive null");
    }
    if (oldSchema.type !== newSchema.type || oldSchema.format !== newSchema.format) {
      const describe = (schema: JsonSchema) => JSON.stringify([schema.type, schema.format]);
      report("type-changed", location, `${describe(oldSchema)} became ${describe(newSchema)}`);
      return;
    }

    const oldEnum = (oldSchema.enum ?? (oldSchema.const !== undefined ? [oldSchema.const] : undefined)) as unknown[] | undefined;
    const newEnum = (newSchema.enum ?? (newSchema.const !== undefined ? [newSchema.const] : undefined)) as unknown[] | undefined;
    if (oldEnum && newEnum) {
      if (direction === "request") {
        for (const value of oldEnum.filter((item) => !newEnum.includes(item))) {
          report("request-enum-value-removed", location, `${String(value)} is no longer accepted`);
        }
      } else {
        for (const value of newEnum.filter((item) => !oldEnum.includes(item))) {
          report("response-enum-value-added", location, `clients may now receive ${String(value)}`);
        }
      }
    }

    if (direction === "request") {
      for (const key of ["maxLength", "maximum", "maxItems"]) {
        const [from, to] = [oldSchema[key], newSchema[key]] as (number | undefined)[];
        if (to !== undefined && (from === undefined || to < from)) report("request-constraint-tightened", location, `${key} ${String(from)} became ${to}`);
      }
      for (const key of ["minLength", "minimum", "minItems"]) {
        const [from, to] = [oldSchema[key], newSchema[key]] as (number | undefined)[];
        if (to !== undefined && (from === undefined || to > from)) report("request-constraint-tightened", location, `${key} ${String(from)} became ${to}`);
      }
      if (newSchema.pattern !== undefined && newSchema.pattern !== oldSchema.pattern) {
        report("request-constraint-tightened", location, `pattern became ${JSON.stringify(newSchema.pattern)}`);
      }
    }

    const oldProps = properties(oldSchema);
    const newProps = properties(newSchema);
    for (const [name, schema] of Object.entries(oldProps)) {
      const replacement = newProps[name];
      if (replacement) compare(direction, `${location}.${name}`, schema, replacement);
      else report(direction === "request" ? "request-property-removed" : "response-property-removed", `${location}.${name}`, "property no longer exists");
    }
    if (direction === "request") {
      for (const name of required(newSchema).filter((item) => !required(oldSchema).includes(item))) {
        report("request-property-became-required", `${location}.${name}`, "existing callers do not send it");
      }
    } else {
      for (const name of required(oldSchema).filter((item) => !required(newSchema).includes(item) && newProps[item])) {
        report("response-property-became-optional", `${location}.${name}`, "clients may rely on it being present");
      }
    }
    if (oldSchema.items && newSchema.items) {
      compare(direction, `${location}[]`, oldSchema.items as JsonSchema, newSchema.items as JsonSchema);
    }
  }

  function compareOperation(location: string, before: SpecOperation, after: SpecOperation): void {
    const newParameters = after.parameters ?? [];
    for (const parameter of before.parameters ?? []) {
      const match = newParameters.find((item) => item.name === parameter.name && item.in === parameter.in);
      const at = `${location} ${parameter.in}.${parameter.name}`;
      if (!match) report("parameter-removed", at, "callers may still send it");
      else {
        if (match.required && !parameter.required) report("parameter-became-required", at, "existing callers may not send it");
        compare("request", at, parameter.schema, match.schema);
      }
    }
    const existing = before.parameters ?? [];
    for (const parameter of newParameters) {
      const known = existing.some((item) => item.name === parameter.name && item.in === parameter.in);
      if (!known && parameter.required) report("required-parameter-added", `${location} ${parameter.in}.${parameter.name}`, "existing callers do not send it");
    }

    const oldBody = before.requestBody?.content["application/json"]?.schema;
    const newBody = after.requestBody?.content["application/json"]?.schema;
    if (oldBody && newBody) compare("request", `${location} body`, oldBody, newBody);
    else if (oldBody) report("request-body-removed", location, "the body is no longer accepted");
    else if (newBody && after.requestBody?.required) report("required-request-body-added", location, "existing callers send no body");

    for (const [status, response] of Object.entries(before.responses)) {
      const replacement = after.responses[status];
      const at = `${location} ${status}`;
      if (!replacement) {
        report("response-status-removed", at, "clients may handle this status");
        continue;
      }
      for (const [media, content] of Object.entries(response.content ?? {})) {
        const match = replacement.content?.[media];
        if (!match) report("response-media-type-removed", `${at} ${media}`, "clients may expect this content type");
        else compare("response", `${at} ${media}`, content.schema, match.schema);
      }
    }
  }

  for (const [path, item] of Object.entries(base.paths)) {
    for (const method of METHODS) {
      const before = item[method];
      if (!before) continue;
      const location = `${method.toUpperCase()} ${path}`;
      const after = head.paths[path]?.[method];
      if (after) compareOperation(location, before, after);
      else report("operation-removed", location, "clients may still call it");
    }
  }
  return changes;
}
