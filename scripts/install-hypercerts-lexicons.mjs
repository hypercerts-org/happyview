#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { webUriSchema } from "@atproto/oauth-types";
import { schemas } from "@hypercerts-org/lexicon/lexicons";

export const COLLECTIONS = [
  {
    record: "app.certified.actor.organization",
    query: "app.certified.actor.listOrganizations",
  },
  {
    record: "app.certified.actor.profile",
    query: "app.certified.actor.listProfiles",
  },
  {
    record: "app.certified.badge.award",
    query: "app.certified.badge.listAwards",
  },
  {
    record: "app.certified.badge.definition",
    query: "app.certified.badge.listDefinitions",
  },
  {
    record: "app.certified.badge.response",
    query: "app.certified.badge.listResponses",
  },
  {
    record: "app.certified.graph.entityFollow",
    query: "app.certified.graph.listEntityFollows",
  },
  {
    record: "app.certified.graph.follow",
    query: "app.certified.graph.listFollows",
  },
  {
    record: "app.certified.link.evm",
    query: "app.certified.link.listEvmLinks",
  },
  { record: "app.certified.location", query: "app.certified.listLocations" },
  {
    record: "app.certified.signature.proof",
    query: "app.certified.signature.listProofs",
  },
  { record: "org.hyperboards.board", query: "org.hyperboards.listBoards" },
  {
    record: "org.hyperboards.displayProfile",
    query: "org.hyperboards.listDisplayProfiles",
  },
  {
    record: "org.hypercerts.claim.activity",
    query: "org.hypercerts.claim.listActivities",
  },
  {
    record: "org.hypercerts.claim.contribution",
    query: "org.hypercerts.claim.listContributions",
  },
  {
    record: "org.hypercerts.claim.contributorInformation",
    query: "org.hypercerts.claim.listContributorInformation",
  },
  {
    record: "org.hypercerts.claim.rights",
    query: "org.hypercerts.claim.listRights",
  },
  {
    record: "org.hypercerts.collection",
    query: "org.hypercerts.listCollections",
  },
  {
    record: "org.hypercerts.context.acknowledgement",
    query: "org.hypercerts.context.listAcknowledgements",
  },
  {
    record: "org.hypercerts.context.attachment",
    query: "org.hypercerts.context.listAttachments",
  },
  {
    record: "org.hypercerts.context.evaluation",
    query: "org.hypercerts.context.listEvaluations",
  },
  {
    record: "org.hypercerts.context.measurement",
    query: "org.hypercerts.context.listMeasurements",
  },
  {
    record: "org.hypercerts.entity.feature",
    query: "org.hypercerts.entity.listFeatures",
  },
  {
    record: "org.hypercerts.funding.receipt",
    query: "org.hypercerts.funding.listReceipts",
  },
  {
    record: "org.hypercerts.vocab.tag",
    query: "org.hypercerts.vocab.listTags",
  },
  {
    record: "org.hypercerts.workscope.tag",
    query: "org.hypercerts.workscope.listTags",
  },
];

export function normalizeHappyViewUrl(value) {
  const trimmed = value.trim().replace(/\/+$/, "");
  const result = webUriSchema.safeParse(trimmed);

  if (!result.success) {
    if (trimmed.startsWith("http://")) {
      throw new Error(
        "HappyView URL must use https:// unless it is a loopback address",
      );
    }
    throw new Error("HappyView URL must use http:// or https://");
  }

  return result.data;
}

function buildQueryLexicon(record, query) {
  return {
    lexicon: 1,
    id: query,
    defs: {
      main: {
        type: "query",
        description: `Lists indexed ${record} records.`,
      },
    },
  };
}

export function buildInstallPlan(packageSchemas) {
  const schemasById = new Map(
    packageSchemas.map((schema) => [schema.id, schema]),
  );

  const records = COLLECTIONS.map(({ record }) => {
    const schema = schemasById.get(record);
    if (!schema || schema.defs?.main?.type !== "record") {
      throw new Error(
        `@hypercerts-org/lexicon does not export record schema ${record}. ` +
          "Update the explicit COLLECTIONS manifest or install the expected package version.",
      );
    }

    return {
      kind: "record",
      id: record,
      payload: {
        lexicon_json: schema,
        backfill: true,
        target_collection: null,
      },
    };
  });

  const queries = COLLECTIONS.map(({ record, query }) => ({
    kind: "query",
    id: query,
    payload: {
      lexicon_json: buildQueryLexicon(record, query),
      backfill: false,
      target_collection: record,
    },
  }));

  return [...records, ...queries];
}

async function ask(question, { hidden = false } = {}) {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error(
      "Interactive input requires a terminal. Set HAPPYVIEW_URL and HAPPYVIEW_ADMIN_TOKEN instead.",
    );
  }

  const readline = createInterface({ input: stdin, output: stdout });
  if (hidden)
    execFileSync("stty", ["-echo"], {
      stdio: ["inherit", "inherit", "inherit"],
    });

  try {
    const answer = await readline.question(question);
    if (hidden) stdout.write("\n");
    return answer.trim();
  } finally {
    if (hidden)
      execFileSync("stty", ["echo"], {
        stdio: ["inherit", "inherit", "inherit"],
      });
    readline.close();
  }
}

async function upload(url, token, step) {
  const response = await fetch(`${url}/admin/lexicons`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(step.payload),
  });
  const body = await response.text();

  if (!response.ok) {
    throw new Error(
      `Failed to upload ${step.kind} ${step.id}: HappyView returned ` +
        `${response.status} ${response.statusText}. ${body || "No response body."}`,
    );
  }

  return body ? JSON.parse(body) : {};
}

function printUsage() {
  console.log(`Usage: bun run install:hypercerts-lexicons [--dry-run] [--yes]

Uploads 25 explicit Hypercerts record lexicons from @hypercerts-org/lexicon,
then creates one native listing query for each record collection.

Environment variables:
  HAPPYVIEW_URL          HappyView base URL
  HAPPYVIEW_ADMIN_TOKEN  Admin API key with lexicons:create and backfill:create

Options:
  --dry-run  Print the record/query mapping without contacting HappyView
  --yes      Skip the final interactive confirmation
  --help     Show this help`);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const supportedArgs = new Set(["--dry-run", "--yes", "--help"]);
  const unknownArg = [...args].find((arg) => !supportedArgs.has(arg));
  if (unknownArg)
    throw new Error(`Unknown option ${unknownArg}. Run with --help for usage.`);
  if (args.has("--help")) return printUsage();

  const plan = buildInstallPlan(schemas);
  console.log("Record collection -> listing query");
  for (const { record, query } of COLLECTIONS)
    console.log(`  ${record} -> ${query}`);

  if (args.has("--dry-run")) {
    console.log(
      `\nDry run complete: ${plan.length} uploads planned; HappyView was not contacted.`,
    );
    return;
  }

  const rawUrl = process.env.HAPPYVIEW_URL || (await ask("HappyView URL: "));
  const token =
    process.env.HAPPYVIEW_ADMIN_TOKEN ||
    (await ask("HappyView admin token: ", { hidden: true }));
  const url = normalizeHappyViewUrl(rawUrl);
  if (!token) throw new Error("HappyView admin token cannot be empty.");

  if (!args.has("--yes")) {
    const confirmation = await ask(
      `\nUpload ${plan.length} lexicons to ${url}? [y/N] `,
    );
    if (!/^y(es)?$/i.test(confirmation)) {
      console.log("Cancelled; HappyView was not changed.");
      return;
    }
  }

  for (const [index, step] of plan.entries()) {
    const result = await upload(url, token, step);
    const backfill = result.backfill_job_id
      ? `; backfill ${result.backfill_job_id}`
      : "";
    console.log(
      `[${index + 1}/${plan.length}] ${step.kind} ${step.id}${backfill}`,
    );
  }

  console.log("Installation complete.");
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
