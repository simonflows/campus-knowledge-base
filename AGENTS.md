## Canon Workspace

- This is «Канон», the campus knowledge base. Read [progress.md](progress.md) for current status, the applicable section of [plan.md](plan.md) for acceptance criteria, and [DEPLOY.md](DEPLOY.md) for release operations.
- Choose the explicit local demo for built-in example data. Normal application mode requires a database and must make its failure visible. Prepare disposable QA storage with `npm run qa:init-fixture`. Import reviewed working records only as described in the deployment guide.
- Production is a separate Linux environment behind a trusted HTTPS ingress. Keep startup settings in the approved secret store. The VibeCraft bridge is available only in development with an explicit `CAMPUS_PREVIEW_ORIGIN`.

## Hard Rules

- Work as autonomously as possible.
- Use `docker compose`, not `docker-compose`.
- Use only port `8080`. Browser smoke tests go through `http://localhost:8080` with `playwright-cli`.
- Never shut down the dev server. Starting it and restarting/recreating the app container are OK.
- Run build/check/lint/format/typecheck commands locally on the host, never through `docker compose exec`.
- The only project command that must run through Docker exec is the DB migration: `docker compose exec app npm run db:migrate`.
- Use DynamoDB for persistent data. Do not add Postgres, Redis, file storage, or another persistence layer.
- Keep `app/api/health/route.ts` and `<Toaster />` intact. Use `/api/ready` to check storage readiness. Preserve the trusted development preview through `<BridgeProvider />`.

## Environment

- Tech stack: Next.js, DynamoDB, Tailwind, shadcn/ui.
- Browser smoke tests use `http://localhost:8080`. The disposable production fixture can bind to `127.0.0.2:8080` separately from the running local app.
- Yandex Cloud Document API is DynamoDB-compatible; existing plumbing is already set up.
- Internet access is available. Prefer official sources for framework/block lookups and keep local fallback paths when external access fails.

## Secrets And Preview Cookies

- Write server-side application code that uses `process.env.<NAME>` with the environment variable names specified in the task (for example, `process.env.CRM_API_TOKEN`). The running application resolves secret values at runtime.
- As the development agent, never read, extract, inspect, or print secret values yourself. Do not retrieve them through tools, shell commands, environment dumps, or ad hoc scripts.
- Never put secret values in .env files, source code, configuration, logs, documentation, client code, or browser storage.
- Never ask the user to send secret values in chat. If the application reports missing credentials, report only the required variable names for configuration in the approved secret store.
- Project secrets reach the runtime asynchronously. If the application reports that a just-saved variable is missing, report that the environment may still be updating; do not replace it with a hardcoded value or an .env file.
- Name every application cookie `__Host-vibecraft-<purpose>` (for example, `__Host-vibecraft-session`). Preview only forwards cookies with this exact prefix.
- Every such cookie must have `Secure` and `Path=/`. Do not set Domain. Preserve this contract when setting, replacing, or deleting cookies, including during local development.

## Request Classification

Before building, classify the request:

1. **Static prototype**: landing pages, portfolios, marketing pages, and other screens with no real CRUD or persistence.
   - Build the actual page in `app/page.tsx`.
   - Hardcode data inline or in `lib/data.ts`.
   - Do not add DynamoDB tables, mock-data arrays, or `/api/*` routes.
   - Skip the CRUD/Data and Input Validation sections unless a form submits real user data.
2. **CRUD/data app**: any feature that creates, reads, updates, or deletes user data.
   - Use DynamoDB, API routes, mock fallback data, zod validation, and migrations.
   - If the feature does not fit DynamoDB's key-value/document model, push back at the product level instead of adding another database.

## Command Policy

| Action                     | Command                                      | Where       |
| -------------------------- | -------------------------------------------- | ----------- |
| Check dev server           | `docker compose ps`                          | host        |
| Start dev server           | `docker compose up -d`                       | host        |
| Restart app container      | `docker compose up -d --force-recreate app`  | host        |
| Run DB migrations          | `docker compose exec app npm run db:migrate` | Docker exec |
| Typecheck                  | `npm run typecheck`                          | host        |
| Lint                       | `npm run lint`                               | host        |
| Format                     | `npm run format`                             | host        |
| Full static check          | `npm run check`                              | host        |
| Production build           | `npm run build`                              | host        |
| Inspect shadcn project     | `npx shadcn@latest info`                     | host        |
| Add shadcn primitive/block | `npx shadcn@latest add <name>`               | host        |
| Install packages           | `npm install ...`                            | host        |
| Clean local build output   | `rm -rf .next`                               | host        |

- If a task needs API calls, migrations, or browser smoke tests, start by checking `docker compose ps`. If the app container is not running, use `docker compose up -d`.
- Restart/recreate the app container only when `docker compose ps` explicitly shows it as `unhealthy`; use `docker compose up -d --force-recreate app` and do not use `docker compose down`.
- If the app container is running and not `unhealthy` but the app does not respond, diagnose or report the blocker instead of restarting.
- If port `8080` is occupied by an unrelated process, report the blocker instead of switching ports.
- `npm run format` mutates files. Run it only after code edits, never for read-only review/advice tasks.
- The container has non-standard runtime environment values and can produce false `next build` failures. If a host command fails, diagnose the TypeScript, ESLint, React, or formatting issue locally instead of retrying the command inside the container.

## Repo Map

- Public `/demo` is an explicit owner-authorized exception to working-storage rules: it keeps only an educational dataset and edits in the visitor's browser. It must never issue working API writes, call paid providers, change the working session, or export to Disk. Preserve reload/reset/corruption safeguards. All real work continues to use DynamoDB/YDB.
- The owner now requires demo to reuse the ordinary site components and shared chrome. Keep its routes and user fields in browser fragments with an explicit scoped request/navigation transport, never a global fetch override. Preserve the isolated document/CSP and working session on entry/exit. Working server loaders remain outside the demo route.
- For the follow-up to 0.9.6, read `docs/followup-0.9.6-workflows.md` before changing rewrite/semantic verification, draft tombstones or demo transport. Deletion must preserve history and enforce author/state/version checks; a writer unaware of tombstones must not be restarted after the new writer has run.
- Release 0.9.6 contracts: `docs/release-0.9.6-contracts.md`, `docs/release-0.9.6-access.md`, and `docs/release-0.9.6-disk.md`. Read the matching contract before changing AI, approval or Disk protocols. Run `npm run test:096` for their regression suite; normal full checks still apply.

- Main page: `app/page.tsx`.
- Root chrome/metadata: `app/layout.tsx`. Product name lives in the single `appName` constant.
- DynamoDB schema: `lib/schema.ts`.
- Typed data access: `lib/models.ts`.
- Static/mock fallback data: `lib/mock-data.ts`.
- DB availability/client plumbing: `lib/db.ts`.
- API routes: `app/api/<resource>/route.ts`.
- Migrations: `scripts/migrate.ts`; it reads `TABLE_SCHEMAS`, so usually do not edit it.

## Protected Infrastructure

Never remove or rewrite:

- `app/api/health/route.ts`
- The trusted preview integration and its explicit development-only gate
- `<Toaster />` in layout
- Existing DynamoDB plumbing in `lib/db.ts`, unless the request explicitly requires it

Do not "fix" build errors by deleting required infrastructure such as `BridgeProvider`, `<HandshakeListener />`, `<Toaster />`, or health checks. Diagnose and fix the actual local build error.

## Server And Client Components

- `app/**/page.tsx` is a Server Component by default: no state, effects, event handlers, or browser APIs.
- Never pass handler props such as `onClick`, `onChange`, or `onSubmit` from a server page into shadcn primitives or other client components.
- Put interactive UI, local state, effects, optimistic updates, and sonner feedback in client components under `components/` with `"use client"` at the top.
- Server pages stay thin: fetch initial data and pass plain serializable props into one client component.
- Split components by mixed concerns, not by line count. Extract a component when it owns at least two of: form state, list filter state, dialog open state, fetch effects.

## UI Rules

- Stay inside shadcn/ui. Do not introduce MUI, Chakra, Mantine, Ant, Magic UI, Aceternity, or another component library.
- Use `lucide-react` for icons. Do not use emoji icons or other icon sets.
- Use `sonner` for user feedback. Do not use `alert()` or `confirm()`.
- Use shadcn `<Skeleton />` for loading states.
- Empty states use a Lucide icon in a muted circle, one-line message, and optional CTA.
- Use `tw-animate-css` classes such as `animate-in fade-in slide-in-from-bottom-4 duration-500`. Do not write custom `@keyframes`; do not add framer-motion/Motion unless the request truly needs gesture or layout animation.
- Reuse visual utilities in `app/globals.css` such as `gradient-hero-vibrant`, `pattern-grid`, and `card-hover`. Limit the page to one flashy element.

Sonner patterns:

```ts
toast.success("Готово");
toast.error(message);
const id = toast.loading("Сохраняем...");
toast.success("Готово", { id });
toast("Удалить?", {
  action: { label: "Удалить", onClick: doDelete },
  cancel: { label: "Отмена", onClick: () => {} },
});
```

shadcn workflow:

- Use the `shadcn` skill if available — it owns CLI usage, registry/docs lookup, add/diff flows, and post-add review.
- Check whether `components/ui/<name>.tsx` already exists before adding.
- Do not overwrite existing UI files if the CLI prompts to.
- If the CLI cannot fetch, continue with existing local shadcn primitives and project patterns.
- If a block or registry item is requested without a named registry, default to the official `@shadcn` registry and proceed.

## CRUD/Data

For new or changed DynamoDB-backed CRUD resources, use the `dynamodb-crud-resource` skill if it is available. Otherwise follow this checklist:

1. `lib/schema.ts`: add the table to `TableName` and a `TableSchema` entry under `TABLE_SCHEMAS`.
2. `lib/models.ts`: add typed interfaces and CRUD functions using DynamoDB document commands.
3. `lib/mock-data.ts`: add mock arrays for every entity read by a page so static-mode builds still render.
4. `app/api/<entity>/route.ts`: add REST endpoints. Return `503` for reads and writes if the working database is unavailable. Allow examples only in explicit demo mode.
5. Run `docker compose exec app npm run db:migrate` after schema changes.

Mock data is only for read fallback/static rendering. Do not use mock data, local files, or browser storage as persistence for writes.

## Input Validation

- `zod` is required for every API route body and every client form submit.
- Do not use manual shape checks like `if (!body.x || typeof body.x !== "string")`.
- Share schemas between server and client where practical. Prefer `lib/validation.ts` or `lib/validation/<resource>.ts`, and derive form types with `z.infer<typeof schema>`.

Example API validation pattern:

```ts
import { z } from "zod";

const createNoteSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().max(10_000).optional(),
  color: z.enum(["yellow", "green", "blue", "pink"]).default("yellow"),
});

export async function POST(request: NextRequest) {
  const parsed = createNoteSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Некорректные данные", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  // parsed.data is fully typed and validated
}
```

## Assets

For tasks involving images, media, logos, icons, illustrations, backgrounds, avatars, screenshots, or other visual assets, use the `asset-workflow` skill if it is available. Otherwise keep assets inside the existing project conventions and avoid introducing a new asset pipeline unless the request requires it.

## Build Verification

- For UI-only/static work, run `npm run check` and `npm run build` on the host when verification is requested or the task is ready for DoD.
- For CRUD/schema work, run `docker compose exec app npm run db:migrate` after schema changes, then `npm run check` and `npm run build` on the host.
- For changed user flows, API integration, or browser-visible behavior, smoke test through `http://localhost:8080` with `playwright-cli`.
- Do not run verification commands through `docker compose exec`, except DB migrations.

## Common Pitfalls

- Date math and timezones: when computing streaks, "today", or any date-based logic, treat date strings as UTC explicitly.
- Do not mix `.setDate()` / `.getDate()` local-time methods with ISO date strings.

Use this pattern:

```ts
const today = new Date().toISOString().split("T")[0];
const d = new Date(today + "T00:00:00Z");
d.setUTCDate(d.getUTCDate() - 1);
const yesterday = d.toISOString().split("T")[0];
```

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
