import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";

export type JsonSchema = Record<string, unknown>;
export const METHODS = ["get", "post", "patch", "put", "delete"] as const;
export type SpecMethod = (typeof METHODS)[number];

export interface SpecParameter {
  name: string;
  in: "query" | "path" | "header" | "cookie";
  required?: boolean;
  schema: JsonSchema;
}

export interface SpecOperation {
  parameters?: SpecParameter[];
  requestBody?: { required?: boolean; content: Record<string, { schema: JsonSchema }> };
  responses: Record<string, { content?: Record<string, { schema: JsonSchema }> }>;
}

export interface OpenApiDocument {
  paths: Record<string, Partial<Record<SpecMethod, SpecOperation>>>;
  components: { schemas: Record<string, JsonSchema> };
}

export interface Operation {
  /** "GET /api/v1/orders/{order_id}" */
  key: string;
  method: SpecMethod;
  path: string;
  definition: SpecOperation;
}

export interface ObservedResponse {
  method: string;
  path: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

const SPEC_PATH = path.resolve(__dirname, "../../apps/api/openapi.json");
const SPEC_ID = "testforge-openapi";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The committed spec is generated from the API code. Nothing here restates what the API does. */
export function loadCommittedSpec(): OpenApiDocument {
  return JSON.parse(readFileSync(SPEC_PATH, "utf8")) as OpenApiDocument;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Point local refs at the registered spec, so an inline schema can be compiled on its own. */
function qualifyRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(qualifyRefs);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === "$ref" && typeof item === "string" ? `${SPEC_ID}${item}` : qualifyRefs(item),
    ]),
  );
}

/**
 * FastAPI leaves output objects open, so an extra field such as password_hash would still validate.
 * Closing every object means a field the spec does not declare is reported as a violation.
 */
function closeObjects(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(closeObjects);
  if (!isRecord(value)) return value;
  const closed = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, closeObjects(item)]));
  const describesObject = value.type === "object" && isRecord(value.properties);
  return describesObject && value.additionalProperties === undefined ? { ...closed, additionalProperties: false } : closed;
}

function describeErrors(validate: ValidateFunction): string {
  return (validate.errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"} ${JSON.stringify(error.params)}`)
    .join("; ");
}

/** Validates real traffic against the generated spec, using strict JSON Schema 2020-12 validation. */
export class OpenApiContract {
  readonly operations: Operation[];
  private readonly ajv: Ajv2020;
  private readonly compiled = new Map<JsonSchema, ValidateFunction>();
  private readonly matchers: { method: SpecMethod; pattern: RegExp; operation: Operation }[];

  constructor(readonly spec: OpenApiDocument = loadCommittedSpec()) {
    this.ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(this.ajv);
    this.ajv.addSchema({ $id: SPEC_ID, components: closeObjects(spec.components) });

    this.operations = Object.entries(spec.paths).flatMap(([specPath, item]) =>
      METHODS.flatMap((method) => {
        const definition = item[method];
        return definition ? [{ key: `${method.toUpperCase()} ${specPath}`, method, path: specPath, definition }] : [];
      }),
    );
    // Literal segments win over parameters: /orders/export.csv is not /orders/{order_id}.
    this.matchers = this.operations
      .map((operation) => ({
        method: operation.method,
        operation,
        pattern: new RegExp(`^${operation.path.replace(/\./g, "\\.").replace(/\{[^}]+\}/g, "[^/]+")}$`),
      }))
      .sort((a, b) => a.operation.path.split("{").length - b.operation.path.split("{").length);
  }

  find(method: string, concretePath: string): Operation | undefined {
    const wanted = method.toLowerCase();
    return this.matchers.find((item) => item.method === wanted && item.pattern.test(concretePath))?.operation;
  }

  get(key: string): Operation {
    const operation = this.operations.find((item) => item.key === key);
    if (!operation) throw new Error(`The OpenAPI spec has no operation ${key}`);
    return operation;
  }

  resolve(schema: JsonSchema): JsonSchema {
    const ref = schema.$ref;
    if (typeof ref !== "string") return schema;
    const resolved = this.spec.components.schemas[ref.replace("#/components/schemas/", "")];
    if (!resolved) throw new Error(`Unresolvable reference ${ref}`);
    return this.resolve(resolved);
  }

  private validator(schema: JsonSchema): ValidateFunction {
    let validate = this.compiled.get(schema);
    if (!validate) {
      validate = this.ajv.compile(qualifyRefs(closeObjects(schema)) as JsonSchema);
      this.compiled.set(schema, validate);
    }
    return validate;
  }

  /** Empty when the body is valid for this operation's request schema. */
  checkRequestBody(operation: Operation, body: unknown): string {
    const schema = operation.definition.requestBody?.content["application/json"]?.schema;
    if (!schema) return `${operation.key} does not declare a JSON request body`;
    const validate = this.validator(schema);
    return validate(body) ? "" : describeErrors(validate);
  }

  /** Every way this response breaks the contract. Empty means it complies. */
  checkResponse(response: ObservedResponse): string[] {
    const label = `${response.method} ${response.path} -> ${response.status}`;
    const operation = this.find(response.method, response.path);
    if (!operation) return [`${label}: path is not in the OpenAPI spec`];

    const problems: string[] = [];
    const requestId = response.headers["x-request-id"];
    if (!requestId || !UUID.test(requestId)) problems.push(`${label}: missing or malformed X-Request-ID`);

    const documented = operation.definition.responses[String(response.status)];
    if (!documented) return [...problems, `${label}: status is not documented for ${operation.key}`];

    const media = (response.headers["content-type"] ?? "").split(";")[0]?.trim() ?? "";
    const declared = documented.content;
    if (!declared) {
      if (response.body !== "") problems.push(`${label}: documented with no content, but has a body`);
      return problems;
    }
    const schema = declared[media]?.schema;
    if (!schema) return [...problems, `${label}: content type "${media}" is not documented`];
    if (media !== "application/json") return problems;

    let body: unknown;
    try {
      body = JSON.parse(response.body);
    } catch {
      return [...problems, `${label}: body is not valid JSON`];
    }
    const validate = this.validator(schema);
    if (!validate(body)) problems.push(`${label}: ${describeErrors(validate)}`);
    if (response.status >= 400 && isRecord(body) && isRecord(body.error) && body.error.request_id !== requestId) {
      problems.push(`${label}: error.request_id does not match the X-Request-ID header`);
    }
    return problems;
  }
}
