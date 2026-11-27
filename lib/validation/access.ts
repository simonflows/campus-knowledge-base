import { z } from "zod";
import { CONFIRM_INDICATOR_ACTIONS } from "../strategy";

export const loginSchema = z.object({
  accountId: z.string().trim().min(1, "Введите логин").max(64),
  accessKey: z.string().max(100).optional(),
  pin: z.string().trim().max(100).optional(),
});

export const moderationActionSchema = z.object({
  action: z.enum([
    "approve",
    "reject",
    "confirm-participation",
    "confirm-stakeholder",
    ...CONFIRM_INDICATOR_ACTIONS,
  ]),
  comment: z.string().trim().max(2_000).optional(),
});

export const editRequestCreateSchema = z.object({
  message: z
    .string()
    .trim()
    .min(10, "Опишите, что нужно изменить, хотя бы десятью символами")
    .max(2_000, "Комментарий слишком длинный"),
});

export const editRequestUpdateSchema = z.object({
  requestId: z.string().trim().min(1),
  action: z.enum(["resolve", "reopen"]),
  resolution: z.string().trim().max(1_000).optional(),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type ModerationActionInput = z.infer<typeof moderationActionSchema>;
