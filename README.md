# docduniya-backend

Production-ready REST API starter built with **Node.js 24 (LTS)**, **Express 5** and **TypeScript** (native ES modules).

It implements the DocDuniya healthcare marketplace and provider software described in the
[architecture](docs/architecture/README.md):

- **Onboarding and identity:** provider onboarding, scoped staff access, patients and dependents,
  and doctor verification, affiliations and public discovery
  ([foundation](docs/implementation/foundation.md),
  [provider marketplace](docs/implementation/provider-marketplace.md)).
- **Booking and payments:** services and schedules, resource-safe booking and queues, Razorpay
  payments, invoicing, refunds and the ledger.
- **Records and privacy:** private documents, consent and sharing, signed clinical records and
  prescriptions, and diagnostics.
- **Hospital operations:** pharmacy and stock, and admissions, beds, nursing and discharge.
- **Engagement and operations:** notifications, support, reviews and provider subscriptions
  ([platform modules](docs/implementation/platform-modules.md)).

The [completion tracker](docs/implementation/completion-tracker.md) lists what still needs
external setup or business decisions before production.

## Tech stack

| Concern      | Tool                                                    |
| ------------ | ------------------------------------------------------- |
| Runtime      | Node.js 24 LTS, ESM (`"type": "module"`)                |
| Framework    | Express 5                                               |
| Language     | TypeScript (strict, `NodeNext`)                         |
| Validation   | Zod (env + request validation)                          |
| Security     | Helmet, CORS, express-rate-limit                        |
| Logging      | Pino + pino-http (pino-pretty in dev)                   |
| Testing      | Vitest + Supertest                                      |
| Code quality | ESLint (flat config, typescript-eslint), Prettier       |
| Git hooks    | Husky + lint-staged (lint & format on commit)           |
| Containers   | Multi-stage Dockerfile (non-root, healthcheck), Compose |

## Getting started

```bash
nvm use            # uses .nvmrc (Node 24)
npm install
cp .env.example .env
docker compose -f docker-compose.db.yml up -d --wait
npm run db:setup   # explicit collections/indexes, role upgrades, specialty labels, templates
npm run dev        # http://localhost:3000/api/v1/health
npm run worker     # background jobs: outbox, payments, refunds, scans, reminders, renewals
```

## Scripts

| Script                     | Description                                                     |
| -------------------------- | --------------------------------------------------------------- |
| `npm run dev`              | Start with hot reload (tsx watch)                               |
| `npm run build`            | Compile TypeScript to `dist/`                                   |
| `npm start`                | Run compiled build                                              |
| `npm run typecheck`        | Type-check without emitting                                     |
| `npm run lint`             | Lint (`lint:fix` to auto-fix)                                   |
| `npm run format`           | Format with Prettier                                            |
| `npm test`                 | Run tests (`test:coverage` for cov)                             |
| `npm run test:integration` | Isolated real MongoDB replica-set workflow tests                |
| `npm run db:setup`         | Add collections, indexes, role upgrades, specialties, templates |
| `npm run worker`           | Run background jobs (`worker:start` runs the compiled build)    |

## Docker

```bash
docker compose up --build
# or
docker build -t docduniya-backend .
docker run -p 3000:3000 --env-file .env docduniya-backend
```

## Project structure

```
src/
  config/          # env validation (zod), logger, MongoDB connection
  controllers/     # request handlers
  middlewares/     # error handler, 404, validation, rate limits, CSRF/shape guards
  modules/
    admin/auth/    # registration, OTP, login, Google, sessions, passwords, roles & permissions
    users/         # admin user management
    email/         # SMTP provider, templates, suppression list, delivery log
    file-manager/  # provider-agnostic storage (S3), image → WebP optimisation, upload policies
    managed-files/ # per-user file records on top of file-manager
    assets/        # media library (SEO metadata, slugs, replace, bulk delete)
    admin/blog/    # blog posts
    admin/blogCategories/ # blog categories
    organizations/ access/ patients/ practitioners/ providers/  # onboarding and identity
    scheduling/ appointments/                                   # services, schedules, booking, queue
    billing/ payments/                                          # invoices, ledger, Razorpay
    documents/ privacy/                                         # private files, consent, audit
    clinical/ diagnostics/                                      # signed records, orders, results
    locations/ inpatient/ pharmacy/                             # hospital operations and stock
    notifications/ operations/ engagement/ commerce/            # events, support, subscriptions
  workers/         # background job runner (npm run worker)
  routes/          # route definitions (mounted at /api/v1)
  utils/           # helpers (ApiError, AppError, xlsx)
  app.ts           # Express app factory
  server.ts        # HTTP server + graceful shutdown
tests/             # Vitest + Supertest tests
```

## API overview (`/api/v1`)

| Prefix             | Access                            | Purpose                                                                                                                  |
| ------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `/auth`            | public / signed-in                | register, verify-otp, resend-otp, login, google, refresh, logout, logout-all, forgot/reset/change password, me, sessions |
| `/roles`           | `roles.manage`                    | role CRUD, permission catalog (`/assignable` needs `users.manage`)                                                       |
| `/users`           | `users.manage`                    | create, list, export (xlsx), update, delete, verify, unlock, sessions, email preference                                  |
| `/files`           | signed-in / `files.manage`        | own files (`/mine`, `/`, `/:id`) and file manager (`/admin/*`)                                                           |
| `/assets`          | `assets.manage`                   | media library                                                                                                            |
| `/blogs`           | public / `blogs.manage`           | posts (drafts visible only to blog managers), banner + resource uploads, status, stats, bulk delete                      |
| `/blog-categories` | public / `blog-categories.manage` | blog category CRUD                                                                                                       |
| `/email`           | `email.manage`                    | suppression list and delivery log                                                                                        |

Auth uses short-lived JWT access tokens (15 min) plus rotating refresh tokens stored as
httpOnly cookies (`Authorization: Bearer` is also accepted). Every request checks that the
session still exists, so logout and password changes revoke access immediately.

Create the first Super Admin with:

```bash
ADMIN_EMAIL=owner@example.com ADMIN_PASSWORD='Str0ng!Pass' npm run admin:create
```

## Adding a route

1. Create `src/controllers/user.controller.ts` and `src/routes/user.routes.ts`.
2. Validate input with `validate({ body: schema })` from `src/middlewares/validate.ts`.
3. Mount it in `src/routes/index.ts`: `router.use('/users', userRoutes)`.
4. Throw `ApiError.notFound()` etc. — async errors are caught automatically by Express 5.

> Note: ESM requires `.js` extensions in relative imports (e.g. `import x from './x.js'`).
