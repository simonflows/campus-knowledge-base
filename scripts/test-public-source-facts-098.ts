import assert from "node:assert/strict";
import { test } from "node:test";
import { checkFactText } from "../lib/fact-check";
import { qaPublicSourceCards, qaPublicSourceScenarios } from "./qa-public-source-fixtures";

const scenario = qaPublicSourceScenarios.kukaPlacement;
const card = { ...qaPublicSourceCards[scenario.sourceLabel], status: "approved" as const };

test("the approved public demonstration confirms the historical fact and leaves current campus operation open", () => {
  const historical = checkFactText(scenario.correctText, [card]);
  assert.ok(historical.findings.some(finding => finding.level === "green" && finding.sourceCardId === card.id));

  const current = checkFactText(scenario.incorrectText, [card]);
  assert.ok(current.findings.some(finding => finding.level === "yellow" && finding.quote === scenario.incorrectText));
  assert.equal(current.summary.red, 0);
  assert.ok(!current.findings.some(finding => finding.level === "green" && finding.quote === scenario.incorrectText));
  assert.equal(current.canPublish, false);
});

test("a matched current operation statement can contradict the same centre's campus location", () => {
  const operatingAtMidis = { ...card, placementDetails: `${card.title} работает на площадке МИДиС.` };
  const current = checkFactText(scenario.incorrectText, [operatingAtMidis]);
  assert.ok(current.findings.some(finding => finding.level === "red" &&
    finding.quote === scenario.incorrectText && finding.sourceCardId === card.id));
  assert.equal(current.summary.yellow, 0);
  assert.equal(current.canPublish, false);
});
