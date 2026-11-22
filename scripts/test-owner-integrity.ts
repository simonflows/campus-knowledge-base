import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  canEditCard,
  canSeeCard,
  areCardOwnerIdsAssignable,
  getDemoAccount,
  resolveLegacyCardOwnerIds,
  visibleKnowledgeCard,
} from "../lib/auth";
import type { CustomCard, UniversityCard } from "../lib/knowledge";
import { sessionDirectory } from "../lib/pilot-auth";
import { knowledgeCardInputSchema } from "../lib/validation/knowledge";

function row(login: string, name: string, profile: string) {
  return { login, name, profile, keyHash: createHash("sha256").update(login).digest("hex") };
}

const profile = getDemoAccount("demo-owner-csu")!;
const staff = [
  row("first", "Первый Сотрудник", profile.id),
  row("second", "Второй Сотрудник", profile.id),
  row("pr", "Тест Редактор", "demo-pr-csu"),
  row("admin", "Тест Координатор", "demo-admin"),
  row("rio", "Тест Рион", "demo-rio"),
];
process.env.CAMPUS_DEMO_LOGIN = "false";
function directory(rows: typeof staff) {
  process.env.CAMPUS_PILOT_ACCOUNTS = JSON.stringify(rows);
  const users = sessionDirectory();
  assert.equal(users.length, rows.length);
  return (login: string) => users.find(user => user.id === "pilot-" + login)!;
}

const legacy: CustomCard = {
  id: "fixture", type: "custom", customTypeId: "fixture", title: "Тест",
  owners: [profile.ownershipLabel], folderId: "fixture", customFields: {},
  referenceDescription: "", stopFormula: "", createdAt: "", updatedAt: "", status: "approved",
};
const account = directory(staff);
const first = account("first");
const second = account("second");
for (const user of [first, second]) {
  assert.equal(canEditCard(user, legacy), false, "A shared profile cannot identify a personal owner");
  assert.equal(canEditCard(user, { ...legacy, owners: [user.ownershipLabel] }), true);
}
assert.equal(canEditCard(directory(staff.filter(item => item.login !== "second"))("first"), legacy), true);

const namesakes = directory(staff.map(item =>
  item.profile === profile.id ? { ...item, name: "Общее Имя" } : item
));
for (const login of ["first", "second"]) {
  const user = namesakes(login);
  for (const label of [user.name, user.ownershipLabel]) {
    assert.equal(canEditCard(user, { ...legacy, owners: [label] }), false);
  }
}

const rio = account("rio");
const bound = { ...legacy, owners: [second.ownershipLabel, rio.organization], ownerIds: [first.id] };
assert.equal(canEditCard(first, bound), true);
assert.equal(canEditCard(second, bound), false);
assert.equal(canEditCard(rio, bound), false);
assert.equal(canEditCard(account("admin"), bound), true);
assert.equal(canEditCard(second, { ...bound, ownerIds: [] }), false);
assert.equal(canSeeCard(second, { ...bound, status: "pending" }), false);
assert.equal(canEditCard(second, { ...bound, status: "pending", submittedBy: second.id }), false, "Reassignment revokes the former submitter's edit permission");
assert.equal(canEditCard(first, visibleKnowledgeCard(first, bound)!), true);
assert.equal(canEditCard(second, visibleKnowledgeCard(second, bound)!), false);
assert.ok(!JSON.stringify(visibleKnowledgeCard(null, bound)).includes(first.id));
assert.equal(canEditCard(account("pr"), { ...legacy, type: "university", universityId: "csu", structuredMetrics: [] }), false);
const passport: UniversityCard = { ...bound, type: "university", universityId: "csu", structuredMetrics: [] };
assert.equal(canEditCard(second, passport), false);
assert.equal(canEditCard(account("pr"), passport), false);
const legacyPassport = { ...passport, ownerIds: undefined, owners: [profile.ownershipLabel] };
assert.equal(canEditCard(first, legacyPassport), false, "A legacy passport cannot grant both leaders personal access");
assert.equal(canEditCard(second, legacyPassport), false);
assert.equal(canEditCard(first, { ...legacyPassport, owners: [first.ownershipLabel] }), true);
const movedOwner = { ...first, universityId: "susu" as const };
const scopedCard = { ...bound, status: "pending" as const, folderId: "01_universities/csu/products" };
assert.equal(canEditCard(movedOwner, scopedCard), false, "An account transfer must revoke rights outside the new scope");
assert.equal(canSeeCard(movedOwner, scopedCard), false);
assert.deepEqual(knowledgeCardInputSchema.parse(bound).ownerIds, [first.id]);
assert.equal(knowledgeCardInputSchema.parse(legacy).ownerIds, undefined);
const csuCard = { ...legacy, owners: [first.ownershipLabel], folderId: "01_universities/csu/products" };
const directoryUsers = [first, second, account("pr"), rio, account("admin")];
assert.deepEqual(resolveLegacyCardOwnerIds(csuCard, directoryUsers), [first.id]);
assert.equal(resolveLegacyCardOwnerIds({ ...csuCard, owners: [first.ownershipLabel, "Неизвестный"] }, directoryUsers), null);
assert.equal(resolveLegacyCardOwnerIds({ ...csuCard, owners: [profile.ownershipLabel] }, directoryUsers), null);
assert.equal(resolveLegacyCardOwnerIds({ ...csuCard, owners: [account("pr").ownershipLabel] }, directoryUsers), null);
assert.equal(resolveLegacyCardOwnerIds({ ...csuCard, folderId: "01_universities/susu/products" }, directoryUsers), null);
assert.equal(areCardOwnerIdsAssignable(csuCard, [first.id, account("pr").id], directoryUsers), false);
assert.equal(areCardOwnerIdsAssignable(csuCard, [rio.id], directoryUsers), false);
assert.equal(areCardOwnerIdsAssignable(csuCard, ["missing"], directoryUsers), false);
assert.equal(areCardOwnerIdsAssignable({ ...csuCard, folderId: "02_joint", type: "project", isJoint: true, participantUniversityIds: ["susu"] }, [first.id], directoryUsers), false);
const compound = directory([
  row("csu", "Тест Имя", "demo-owner-csu"),
  row("susu", "Тест Имя", "demo-owner-susu"),
  row("compound", "Тест Имя, ЧелГУ", "demo-owner-csu"),
]);
const compoundCard = { ...legacy, owners: [compound("compound").ownershipLabel] };
assert.equal(canEditCard(compound("compound"), compoundCard), true);
assert.equal(canEditCard(compound("csu"), compoundCard), false, "A qualified alias must not match a different compound name");
console.log("PASS personal ownership, same-profile and same-university ambiguity, explicit IDs, role permissions and visible cards");
