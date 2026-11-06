// BootstrapSummaryReport (AC43, AC44): the one JSON document printed on stdout, with all eleven keys in a fixed
// order, arrays sorted lexicographically and only names (never values) in variablesSet and secretsSet.

import fs from "node:fs";
import Ajv from "ajv";
import { SdlcError } from "./errors.mjs";

export const SUMMARY_SCHEMA_PATH = new URL("../../schemas/bootstrap-summary-report.schema.json", import.meta.url);

const ARRAY_KEYS = [
  "installationsVerified",
  "onboardedProjects",
  "deconflictedTargetWorkflows",
  "skippedReadOnlyUpstreams",
  "variablesSet",
  "secretsSet",
  "compiledWorkflows",
];

const sortedUnique = (values) => [...new Set(values ?? [])].sort();

let validator = null;
function summaryValidator() {
  if (validator === null) {
    validator = new Ajv({ allErrors: true, strict: true }).compile(JSON.parse(fs.readFileSync(SUMMARY_SCHEMA_PATH, "utf8")));
  }
  return validator;
}

/** Validates a report against schemas/bootstrap-summary-report.schema.json; returns the list of schema errors. */
export function summaryProblems(report) {
  const validate = summaryValidator();
  return validate(report) ? [] : validate.errors.map((error) => `${error.instancePath || "/"} ${error.message}`);
}

/** Builds the report with its keys in contract order and every array sorted; throws when it would not validate. */
export function buildSummaryReport(fields) {
  const report = {
    appId: fields.appId,
    appSlug: fields.appSlug,
    clientId: fields.clientId,
    installationsVerified: sortedUnique(fields.installationsVerified),
    onboardedProjects: sortedUnique(fields.onboardedProjects),
    deconflictedTargetWorkflows: sortedUnique(fields.deconflictedTargetWorkflows),
    skippedReadOnlyUpstreams: sortedUnique(fields.skippedReadOnlyUpstreams),
    variablesSet: sortedUnique(fields.variablesSet),
    secretsSet: sortedUnique(fields.secretsSet),
    compiledWorkflows: sortedUnique(fields.compiledWorkflows),
    doctorStatus: fields.doctorStatus,
  };
  const problems = summaryProblems(report);
  if (problems.length > 0) throw new SdlcError(`the BootstrapSummaryReport does not validate: ${problems.join("; ")}`, { code: "summary-invalid" });
  return report;
}

/** Prints exactly one JSON document on stdout. */
export function printSummaryReport(stdout, report) {
  stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

export { ARRAY_KEYS };
