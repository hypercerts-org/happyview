import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { schemas } from "@hypercerts-org/lexicon/lexicons";
import {
  COLLECTIONS,
  buildInstallPlan,
  normalizeHappyViewUrl,
} from "./install-hypercerts-lexicons.mjs";

const installerPath = new URL(
  "./install-hypercerts-lexicons.mjs",
  import.meta.url,
);

const expectedMappings = [
  ["app.certified.actor.organization", "app.certified.actor.listOrganizations"],
  ["app.certified.actor.profile", "app.certified.actor.listProfiles"],
  ["app.certified.badge.award", "app.certified.badge.listAwards"],
  ["app.certified.badge.definition", "app.certified.badge.listDefinitions"],
  ["app.certified.badge.response", "app.certified.badge.listResponses"],
  ["app.certified.graph.entityFollow", "app.certified.graph.listEntityFollows"],
  ["app.certified.graph.follow", "app.certified.graph.listFollows"],
  ["app.certified.link.evm", "app.certified.link.listEvmLinks"],
  ["app.certified.location", "app.certified.listLocations"],
  ["app.certified.signature.proof", "app.certified.signature.listProofs"],
  ["org.hyperboards.board", "org.hyperboards.listBoards"],
  ["org.hyperboards.displayProfile", "org.hyperboards.listDisplayProfiles"],
  ["org.hypercerts.claim.activity", "org.hypercerts.claim.listActivities"],
  [
    "org.hypercerts.claim.contribution",
    "org.hypercerts.claim.listContributions",
  ],
  [
    "org.hypercerts.claim.contributorInformation",
    "org.hypercerts.claim.listContributorInformation",
  ],
  ["org.hypercerts.claim.rights", "org.hypercerts.claim.listRights"],
  ["org.hypercerts.collection", "org.hypercerts.listCollections"],
  [
    "org.hypercerts.context.acknowledgement",
    "org.hypercerts.context.listAcknowledgements",
  ],
  [
    "org.hypercerts.context.attachment",
    "org.hypercerts.context.listAttachments",
  ],
  [
    "org.hypercerts.context.evaluation",
    "org.hypercerts.context.listEvaluations",
  ],
  [
    "org.hypercerts.context.measurement",
    "org.hypercerts.context.listMeasurements",
  ],
  ["org.hypercerts.entity.feature", "org.hypercerts.entity.listFeatures"],
  ["org.hypercerts.funding.receipt", "org.hypercerts.funding.listReceipts"],
  ["org.hypercerts.vocab.tag", "org.hypercerts.vocab.listTags"],
  ["org.hypercerts.workscope.tag", "org.hypercerts.workscope.listTags"],
];

test("provides the Hypercerts lexicon installer", () => {
  expect(existsSync(installerPath)).toBe(true);
});

test("exposes the installer through the root package", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );

  expect(packageJson.scripts["install:hypercerts-lexicons"]).toBe(
    "bun run scripts/install-hypercerts-lexicons.mjs",
  );
});

describe("collection manifest", () => {
  test("uses explicit record and query NSIDs", () => {
    expect(COLLECTIONS.map(({ record, query }) => [record, query])).toEqual(
      expectedMappings,
    );
  });

  test("covers every record schema exported by the installed package", () => {
    const packageRecordIds = schemas
      .filter((schema) => schema.defs?.main?.type === "record")
      .map((schema) => schema.id)
      .sort();

    expect(COLLECTIONS.map(({ record }) => record).sort()).toEqual(
      packageRecordIds,
    );
  });
});

describe("install plan", () => {
  test("uploads package record schemas before generated listing queries", () => {
    const plan = buildInstallPlan(schemas);

    expect(plan).toHaveLength(50);
    expect(plan.slice(0, 25).every(({ kind }) => kind === "record")).toBe(true);
    expect(plan.slice(25).every(({ kind }) => kind === "query")).toBe(true);
    expect(plan[0].payload.lexicon_json).toBe(
      schemas.find(({ id }) => id === "app.certified.actor.organization"),
    );
    expect(plan[25].payload).toEqual({
      lexicon_json: {
        lexicon: 1,
        id: "app.certified.actor.listOrganizations",
        defs: {
          main: {
            type: "query",
            description:
              "Lists indexed app.certified.actor.organization records.",
          },
        },
      },
      backfill: false,
      target_collection: "app.certified.actor.organization",
    });
  });

  test("explains when the installed package is missing a configured record", () => {
    const withoutOrganization = schemas.filter(
      ({ id }) => id !== "app.certified.actor.organization",
    );

    expect(() => buildInstallPlan(withoutOrganization)).toThrow(
      "@hypercerts-org/lexicon does not export record schema app.certified.actor.organization",
    );
  });
});

test("normalizes HTTPS HappyView URLs", () => {
  expect(normalizeHappyViewUrl(" https://happyview.example/ ")).toBe(
    "https://happyview.example",
  );
});

test("allows HTTP only for loopback HappyView URLs", () => {
  expect(normalizeHappyViewUrl("http://localhost:3000/")).toBe(
    "http://localhost:3000",
  );
  expect(normalizeHappyViewUrl("http://127.0.0.1:3000/")).toBe(
    "http://127.0.0.1:3000",
  );
  expect(normalizeHappyViewUrl("http://[::1]:3000/")).toBe(
    "http://[::1]:3000",
  );
  expect(() => normalizeHappyViewUrl("http://happyview.example")).toThrow(
    "HappyView URL must use https:// unless it is a loopback address",
  );
});

test("rejects unsupported HappyView URL protocols", () => {
  expect(() => normalizeHappyViewUrl("happyview.example")).toThrow(
    "HappyView URL must use http:// or https://",
  );
  expect(() => normalizeHappyViewUrl("ftp://happyview.example")).toThrow(
    "HappyView URL must use http:// or https://",
  );
});
