import { z } from "zod";
import { universities } from "./data";

export const accountEmailSchema = z.string().trim().max(254).email("Введите адрес электронной почты").toLowerCase();
export const accountPasswordSchema = z.string().min(15, "Используйте не менее 15 символов").max(128, "Используйте не более 128 символов");
const loginPasswordSchema = z.string().min(1, "Введите пароль").max(128);
const accountNameSchema = z.string().trim().min(2, "Укажите имя").max(120)
  .refine(value => !/[\p{Cc}\p{Cf}]/u.test(value), "Проверьте введённое имя");
export const accountProofSchema = z.string().regex(/^[0-9a-f]{64}\.[A-Za-z0-9_-]{43}$/, "Ссылка недействительна");
export const accountSessionPattern = /^v3\.[A-Za-z0-9_-]{43}$/;
export const accountPublicIdSchema = z.string().regex(/^author-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/, "Укажите код аккаунта");
export const accountReturnPaths = ["/knowledge", "/analytics", "/editor", "/work", "/requests", "/check"] as const;
export const accountReturnPathSchema = z.enum(accountReturnPaths);
export function accountReturnPath(value: unknown) {
  const parsed = accountReturnPathSchema.safeParse(value);
  return parsed.success ? parsed.data : "/knowledge";
}

export const staffGrantSchema = z.discriminatedUnion("role", [
  z.strictObject({ role: z.enum(["author", "ministry", "rio", "chkk"]) }),
  z.strictObject({
    role: z.enum(["university_owner", "university_pr"]),
    universityId: z.string().refine(id => universities.some(university => university.id === id), "Выберите вуз"),
  }),
]);
export type StaffGrant = z.infer<typeof staffGrantSchema>;

export const emailLoginSchema = z.strictObject({
  method: z.literal("email"),
  email: accountEmailSchema,
  password: loginPasswordSchema,
});

export const accountActionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.enum(["signup", "forgot"]), email: accountEmailSchema }),
  z.strictObject({ action: z.literal("verify"), token: accountProofSchema, name: accountNameSchema, password: accountPasswordSchema }),
  z.strictObject({ action: z.literal("reset"), token: accountProofSchema, password: accountPasswordSchema }),
  z.strictObject({ action: z.literal("lookup"), accountId: accountPublicIdSchema }),
  z.strictObject({
    action: z.literal("grant"), accountId: accountPublicIdSchema, revision: z.number().int().nonnegative(), grant: staffGrantSchema,
  }),
]);
