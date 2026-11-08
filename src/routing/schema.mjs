// Validation against schemas/sdlc-routing.schema.json for the S3 scripts. The schema file is read once, from the repository that the script runs in
// (the jobs of the cascade workflows check out src/ and schemas/), and every shape is compiled from its own $defs entry.

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

export const ROUTING_SCHEMA_PATH = fileURLToPath(new URL("../../schemas/sdlc-routing.schema.json", import.meta.url));

/** Data that does not have the shape that a script relies on: the script stops and writes nothing. */
export class RoutingDataError extends Error {
  /** @param {string} message @param {{ code?: string }} [details] */
  constructor(message, { code = "malformed" } = {}) {
    super(message);
    this.name = "RoutingDataError";
    this.code = code;
  }
}

let ajv = null;
const compiled = new Map();

function compiler() {
  if (ajv === null) {
    const schema = JSON.parse(fs.readFileSync(ROUTING_SCHEMA_PATH, "utf8"));
    ajv = new Ajv({ allErrors: true, strict: true });
    ajv.addSchema(schema);
  }
  return ajv;
}

/** The compiled validator of one $defs entry of the routing schema. */
export function validatorFor(name) {
  if (!compiled.has(name)) {
    const validate = compiler().getSchema(`sdlc-routing.schema.json#/$defs/${name}`);
    if (!validate) throw new Error(`schemas/sdlc-routing.schema.json has no definition '${name}'`);
    compiled.set(name, validate);
  }
  return compiled.get(name);
}

function describe(error) {
  const where = error.instancePath === "" ? "the value" : error.instancePath;
  if (error.keyword === "additionalProperties") return `${where}: unexpected property '${error.params.additionalProperty}'`;
  if (error.keyword === "required") return `${where}: missing property '${error.params.missingProperty}'`;
  if (error.keyword === "enum") return `${where}: ${error.message} (${error.params.allowedValues.map((value) => JSON.stringify(value)).join(", ")})`;
  return `${where}: ${error.message}`;
}

/** @returns {{ valid: boolean, errors: string[] }} */
export function validateShape(name, value) {
  const validate = validatorFor(name);
  const valid = validate(value) === true;
  return { valid, errors: valid ? [] : (validate.errors ?? []).map(describe) };
}

/** Throws a RoutingDataError that names the shape and every violation. */
export function assertShape(name, value, label = name) {
  const { valid, errors } = validateShape(name, value);
  if (!valid) throw new RoutingDataError(`${label} is not a valid ${name}: ${errors.join("; ")}`);
  return value;
}

/** True for a timestamp of the schema's UTC shape that names a real date and time (the pattern alone admits 31 February). */
export function isRealUtcTimestamp(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day && date.getUTCHours() === hour;
}
