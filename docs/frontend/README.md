# DocDuniya frontend integration guide

This guide is for developers building the DocDuniya website (patients, doctors, provider staff and platform administrators) against the backend API. It explains how to talk to the API, how sign-in works, how to decide what each user sees, and the screen-by-screen workflows with the endpoints and fields each step needs.

Three documents work together:

| Document                            | Use it for                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| This guide                          | Conventions, sign-in, navigation, workflows                                                             |
| [API reference](api-reference.md)   | Every endpoint with every request field, type, limit and a minimal example body, plus all status values |
| [openapi.json](../api/openapi.json) | Machine-readable OpenAPI 3.1 contract with the same request schemas, for generating a typed client      |

The reference and `openapi.json` are generated from the backend source (`npm run openapi` in `docduniya-backend`), so they always match the server. Regenerate them after backend changes; never edit them by hand.

## Contents

1. [Setup](#1-setup)
2. [How the API behaves](#2-how-the-api-behaves)
3. [A minimal API client](#3-a-minimal-api-client)
4. [Sign-up, sign-in and sessions](#4-sign-up-sign-in-and-sessions)
5. [Who is this user? Building navigation](#5-who-is-this-user-building-navigation)
6. [Site map](#6-site-map)
7. [Patient workflows](#7-patient-workflows)
8. [Doctor and professional workflows](#8-doctor-and-professional-workflows)
9. [Provider console workflows](#9-provider-console-workflows)
10. [Platform administration](#10-platform-administration)
11. [Shared building blocks](#11-shared-building-blocks)
12. [Known gaps](#12-known-gaps)

---

## 1. Setup

**Base URL.** Every path in this guide and in the reference is relative to `<API host>/api/v1`, for example `http://localhost:4000/api/v1/discovery/doctors`. The backend listens on `PORT` from its `.env` (default `3000`, the same as Next.js, so run one of them on another port locally). Point the frontend's `NEXT_PUBLIC_API_URL` at the API host including `/api/v1`.

**Health.** `GET /health` (process up) and `GET /health/ready` (database ready). Use them in deployment checks, not in pages.

**CORS and cookies.** The API sets two `httpOnly` cookies on sign-in: `accessToken` (15 minutes) and `refreshToken` (7 days). For the browser to send them:

- Call the API with `credentials: 'include'`.
- The frontend origin must be allowed by the backend: `FRONTEND_URL`, plus any extra origins in `CORS_ORIGINS` (comma-separated, wildcard subdomains allowed).
- If the site and the API are on different sites (not just different subdomains), the backend needs `AUTH_COOKIE_SAME_SITE=none` and HTTPS. On the same site (for example `app.example.com` and `api.example.com`), the default `lax` works; set `AUTH_COOKIE_DOMAIN` if the cookie must be shared across subdomains.

Every sign-in response also returns `data.accessToken`. A client that cannot use cookies (a mobile app, or a Next.js server component calling the API) can send `Authorization: Bearer <accessToken>` instead. Refresh still uses the refresh cookie.

**Typed client (optional).** Generate TypeScript types from the contract:

```bash
npx openapi-typescript ../docduniya-backend/docs/api/openapi.json -o src/lib/api-types.ts
```

The contract describes request bodies exactly. Response bodies are documented as the `{ success, data }` envelope only; this guide and the reference describe the important response fields.

## 2. How the API behaves

### Response envelope

Every success response is JSON:

```json
{ "success": true, "data": { "...": "..." }, "message": "optional text" }
```

Commands (anything that creates or changes a record) return `data: { "id": "<ObjectId>", "version": <number> }`. Read the record afterwards if the screen needs more. Status codes: `201` for creation, `200` otherwise (a replayed creation may return `201` again).

Every error response is JSON:

```json
{
  "success": false,
  "code": "VALIDATION_ERROR",
  "message": "Readable text",
  "errors": { "field": ["message"] }
}
```

Show `message` to users only when it is about their input; branch on `code`, never on `message`.

### Errors you must handle

| Status | `code`                                   | Meaning and what the UI should do                                                                                                                                          |
| ------ | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `VALIDATION_ERROR`                       | Bad input. `errors` maps field names to messages: show them next to the fields. Unknown fields are also rejected, so never send extra keys.                                |
| 400    | `IDEMPOTENCY_KEY_REQUIRED`               | The command needs an `Idempotency-Key` header (see below). A client bug.                                                                                                   |
| 400    | `BAD_REQUEST`                            | Malformed identifier or request.                                                                                                                                           |
| 401    | `TOKEN_EXPIRED`                          | Access token expired: call `POST /auth/refresh` once, then retry the request.                                                                                              |
| 401    | `TOKEN_INVALID`, `SESSION_NOT_FOUND`     | Not signed in, or the session was revoked: go to sign-in.                                                                                                                  |
| 401    | `INVALID_CREDENTIALS`                    | Wrong email or password.                                                                                                                                                   |
| 403    | `FORBIDDEN`                              | Signed in but not allowed. Hide the action.                                                                                                                                |
| 403    | `MFA_ENROLLMENT_REQUIRED`                | Privileged admin action needs two-factor sign-in: send the user to authenticator setup (section 4).                                                                        |
| 403    | `CREDENTIAL_INVALID`                     | The professional's credential is missing, suspended or expired (signing, dispensing, verifying). Show "Your credential is not current".                                    |
| 404    | `NOT_FOUND`                              | Missing **or not visible to this user**. The API deliberately answers `404` for records outside the caller's authority; treat it as "not found", not as an error to retry. |
| 409    | `VERSION_CONFLICT`                       | Someone changed the record since you loaded it: reload, show the new state, let the user retry.                                                                            |
| 409    | `IDEMPOTENCY_CONFLICT`                   | The same `Idempotency-Key` was reused with a different body: generate a new key for a new action.                                                                          |
| 409    | domain codes                             | A business rule stopped the command; see the list below. Show a specific message.                                                                                          |
| 413    | `PAYLOAD_TOO_LARGE`                      | Body or upload too large.                                                                                                                                                  |
| 422    | `INCOMPLETE_RECORD`                      | A record cannot be signed or completed yet (for example a note without content).                                                                                           |
| 429    | —                                        | Rate limited (sign-in, OTP and uploads have tighter limits). Wait and retry; show "Too many attempts".                                                                     |
| 503    | `TRANSACTIONS_REQUIRED`, `*_UNAVAILABLE` | Server configuration problem. Show a generic error.                                                                                                                        |

Domain `409` codes and suggested messages:

| Code                                                                                                                                                         | Where                              | Message idea                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- | --------------------------------------------------------------------------- |
| `SLOT_UNAVAILABLE`                                                                                                                                           | Booking, reschedule, theatre       | "That time was just taken. Pick another slot." Refresh availability.        |
| `QUOTE_CHANGED`                                                                                                                                              | Booking                            | "The price or service changed." Reload the offering and show the new price. |
| `HOLD_EXPIRED`                                                                                                                                               | Booking                            | "Your reservation expired." Start again.                                    |
| `PAYMENT_NOT_READY`                                                                                                                                          | Confirming a prepaid booking       | Prepaid bookings confirm only after payment; send the user to pay.          |
| `PROVIDER_NOT_ACTIVE`                                                                                                                                        | Provider console                   | The organization is not verified yet.                                       |
| `MEMBERSHIP_EXISTS`                                                                                                                                          | Staff invite                       | Already a member or invited.                                                |
| `ARRIVAL_REQUIRED`                                                                                                                                           | Starting an encounter or admission | Check the patient in, or add them to today's queue first.                   |
| `CONSENT_REQUIRED`                                                                                                                                           | Video/audio encounters             | Record telemedicine consent first.                                          |
| `STOCK_UNAVAILABLE`, `BATCH_UNAVAILABLE`, `QUANTITY_EXCEEDED`, `PRESCRIPTION_EXPIRED`, `SUBSTITUTION_NOT_ALLOWED`, `ALLERGY_REVIEW_REQUIRED`, `OVER_RECEIPT` | Pharmacy                           | Show the specific stock or prescription problem.                            |
| `BED_UNAVAILABLE`, `BED_UNSUITABLE`, `DISCHARGE_NOT_READY`                                                                                                   | Inpatient                          | Pick another bed; complete the discharge checklist.                         |
| `REVIEW_NOT_ELIGIBLE`                                                                                                                                        | Reviews                            | Only a completed visit can be reviewed, once.                               |
| `UPLOAD_MISSING`, `DOCUMENT_NOT_AVAILABLE`                                                                                                                   | Documents                          | The upload did not arrive, or the file is still being scanned.              |
| `MERCHANT_UNAVAILABLE`                                                                                                                                       | Online payment                     | The provider cannot take online payments yet; offer pay at clinic.          |

### Idempotency-Key (healthcare commands)

Almost every command on the healthcare routes (booking, payments, records, billing, staff, profiles) needs an `Idempotency-Key` header: 8–100 letters, digits, `_` or `-`. The reference marks exactly these endpoints with **Idempotency-Key: required**; without the header they answer `400 IDEMPOTENCY_KEY_REQUIRED`. Sign-in routes, content administration (users, roles, blog, files, media) and a few read-like actions (verifying a payment, opening a document, marking a notification read) do not use it.

- Generate one key per **user action** (`crypto.randomUUID()`), for example when the user presses "Book".
- If the request fails with a network error or a timeout, retry with **the same key and the same body**. The server returns the original result instead of doing the work twice. This is what prevents double bookings and double payments.
- After a success or a definite error, the next action gets a new key.

### Optimistic versions (`expectedVersion`)

Records carry a `version`. Commands that change an existing record require `expectedVersion`: send the `version` you displayed. If it changed meanwhile, you get `409 VERSION_CONFLICT`: reload and let the user redo the action. After a successful command, use the returned `version` for the next change.

### Lists and pagination

Lists return `{ "items": [...], "nextCursor": "<id>" }`. Ask for the next page with `?before=<nextCursor>`; `limit` is 1–100 (default 25; public doctor discovery 1–25, default 10). There is no `nextCursor` on the last page. Lists are newest first. Build "Load more" or infinite scroll; there are no page numbers or totals.

### Money, dates and identifiers

- **Money** is in integer minor units (paise): `amountMinor: 50000` is ₹500.00. Currency is always `INR`. Format with `Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(amountMinor / 100)`. Taxes are basis points (`taxBasisPoints: 1800` is 18%).
- **Dates** are `YYYY-MM-DD`; **times** are ISO 8601 in UTC (`2026-12-01T04:30:00.000Z`). Clinics operate in `Asia/Kolkata`: display times with `timeZone: 'Asia/Kolkata'`. Schedule windows use minutes after local midnight (`startMinute: 600` is 10:00 IST).
- **Identifiers** are 24-character hex ObjectIds.
- **Phone numbers** are E.164 (`+919876543210`). **PIN codes** are six digits.
- **Names** are objects: `{ "display": "Asha Rao", "given": "Asha", "family": "Rao" }`; only `display` is required.
- **Addresses** need `use`, `line1`, `city`, `stateCode` and a six-digit `postalCode`.

### Caching

Personal and clinical responses carry `Cache-Control: no-store`. Do not cache them in a service worker, `localStorage` or a shared CDN layer, and clear in-memory state on sign-out. Public catalogs (discovery, specialties, drugs, tests) can be fetched at request time; they are also `no-store` so availability stays current.

## 3. A minimal API client

A browser-side client using cookies, with refresh-on-expiry and idempotency keys. Adapt it to server components by forwarding the bearer token instead.

```ts
// src/lib/api.ts
const BASE = process.env.NEXT_PUBLIC_API_URL!; // e.g. http://localhost:4000/api/v1

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public errors?: Record<string, string[]>,
  ) {
    super(message);
  }
}

type Options = {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  idempotencyKey?: string;
};

let refreshing: Promise<boolean> | null = null;
async function refresh(): Promise<boolean> {
  refreshing ??= fetch(`${BASE}/auth/refresh`, { method: 'POST', credentials: 'include' })
    .then((r) => r.ok)
    .finally(() => (refreshing = null));
  return refreshing;
}

export async function api<T>(path: string, options: Options = {}, retried = false): Promise<T> {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(options.query ?? {}))
    if (v !== undefined) url.searchParams.set(k, String(v));
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  const response = await fetch(url, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    credentials: 'include',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const json = await response.json().catch(() => ({}));
  if (response.ok) return json.data as T;
  if (response.status === 401 && json.code === 'TOKEN_EXPIRED' && !retried && (await refresh()))
    return api<T>(path, options, true);
  throw new ApiError(
    response.status,
    json.code ?? 'ERROR',
    json.message ?? 'Request failed',
    json.errors,
  );
}

/** For commands: one key per user action, reused on retry. Use method 'PATCH' or 'PUT' where the reference says so. */
export const command = <T = { id: string; version: number }>(
  path: string,
  body: unknown = {},
  key = crypto.randomUUID(),
  method: 'POST' | 'PATCH' | 'PUT' = 'POST',
) => api<T>(path, { method, body, idempotencyKey: key });
```

Keep the key in component state while a command is in flight, so a retry button reuses it.

## 4. Sign-up, sign-in and sessions

The account (email and password) is separate from what the person is on the platform: a patient profile, a doctor or other professional profile, staff memberships in provider organizations, and platform administration roles. One account can have all of them. Sign-up therefore creates only the account; the profiles come after sign-in (sections 7 and 8).

| Step                | Call                                                      | Body                                                                                  |
| ------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Create account      | `POST /auth/register`                                     | `email`, `password` (8–128 chars with upper case, lower case, digit and symbol)       |
| Verify email        | `POST /auth/verify-otp`                                   | `email`, `otp` (6 digits from the email)                                              |
| Resend code         | `POST /auth/resend-otp`                                   | `email`, `type` (`REGISTER` default, or `RESET_PASSWORD`)                             |
| Sign in             | `POST /auth/login`                                        | `email`, `password`                                                                   |
| Sign in with Google | `POST /auth/google`                                       | `credential` (the ID token from Google Identity Services)                             |
| Second factor       | `POST /auth/mfa/verify`                                   | `challengeToken` plus `code` (6 digits) or `recoveryCode`                             |
| Keep signed in      | `POST /auth/refresh`                                      | none (uses the refresh cookie)                                                        |
| Who am I            | `GET /auth/me`                                            | —                                                                                     |
| Sign out            | `POST /auth/logout`; everywhere: `POST /auth/logout-all`  | none                                                                                  |
| Forgot password     | `POST /auth/forgot-password`                              | `email`                                                                               |
| Reset password      | `POST /auth/reset-password`                               | `token`, `email`, `newPassword` (from the emailed link), or `resetUrl`, `newPassword` |
| Change password     | `POST /auth/change-password`                              | see reference                                                                         |
| Devices             | `GET /auth/sessions`, `DELETE /auth/sessions/{sessionId}` | —                                                                                     |

**Sign-in result.** `POST /auth/login` (and `/auth/google`) returns either:

- `data: { accessToken }` and sets the cookies: signed in.
- `data: { mfaRequired: true, challengeToken, expiresAt }`: show a code screen and call `POST /auth/mfa/verify` within five minutes (five attempts).

Verify-OTP does **not** sign the user in; send them to sign-in afterwards (or sign in with the password they just set). Errors to show on the sign-in form: `INVALID_CREDENTIALS`, `ACCOUNT_NOT_VERIFIED` (offer to resend the code), `ACCOUNT_LOCKED` (too many attempts; wait), `ACCOUNT_DISABLED`.

**`GET /auth/me`** returns `{ userId, email, role, isVerified, mustChangePassword, permissions }`. `permissions` are **platform** permissions (administration of DocDuniya itself). Normal users have none. If `mustChangePassword` is true, force the change-password screen.

**Administrator portal (`/administrator/login`).** DocDuniya staff (any account whose role grants platform permissions, including the super admin) sign in only through the administrator portal, and every sign-in needs a code emailed to them:

| Step            | Call                           | Body                     | Result                                                                                                                                                                    |
| --------------- | ------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Password     | `POST /auth/admin/login`       | `email`, `password`      | `{ verificationRequired: true, challengeToken, expiresAt, sentTo }`; a 6-digit code is emailed. No session yet.                                                           |
| 2. Emailed code | `POST /auth/admin/verify`      | `challengeToken`, `code` | Signed in (`{ accessToken }` and cookies), or `{ mfaRequired: true, challengeToken }` when the admin also enrolled an authenticator: finish with `POST /auth/mfa/verify`. |
| New code        | `POST /auth/admin/resend-code` | `challengeToken`         | A new code is emailed; the previous one stops working.                                                                                                                    |

Rules the screens should explain:

- A code lasts 10 minutes, works once and allows five attempts (the error message says how many are left). A wrong-code error has code `OTP_INVALID`; `OTP_MAX_ATTEMPTS` or `TOKEN_INVALID` means the attempt is over, so return to the password step.
- One code per minute: a new sign-in or a resend within 60 seconds answers `429 OTP_COOLDOWN`. At most three codes per attempt. Starting a new sign-in cancels the older attempt.
- Patients and doctors get the same `401 INVALID_CREDENTIALS` as for a wrong password, so the portal does not reveal who is an administrator.
- Staff accounts are refused by the patient and doctor sign-in (`POST /auth/login`, `POST /auth/google`) with `403 ADMIN_LOGIN_REQUIRED`: link to the portal.

**Two-factor setup** (account security page):

1. `GET /auth/mfa`: whether an authenticator is enrolled.
2. `POST /auth/mfa/totp/enroll`: returns a secret and an `otpauth://` URI; render it as a QR code.
3. `POST /auth/mfa/totp/activate` with `{ code }`: returns ten recovery codes. Show them once and ask the user to store them. Other sessions are signed out.
4. `POST /auth/mfa/recovery-codes` with `{ code }` issues new recovery codes; `DELETE /auth/mfa/totp` with `{ code }` removes the factor.

When the backend enforces two-factor for administrators (`MFA_ENFORCE_PRIVILEGED=true`), admin actions return `403 MFA_ENROLLMENT_REQUIRED` until the user enrolls.

**Replacing the current mock session.** `docduniya-frontend/src/app/actions/auth.ts` currently invents a session cookie. Replace it with the calls above: the backend's cookies are the session. To know who is signed in, call `GET /auth/me` (a `401` means signed out). Do not store roles in a frontend cookie; derive them from the bootstrap calls in section 5 on each load.

The current sign-up forms collect more than the account needs. Map them like this:

| Form field                                   | Where it goes                                                                                                                                                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Email, password                              | `POST /auth/register`                                                                                                                                                                                                                            |
| Name, date of birth, gender, phone (patient) | After sign-in, `POST /patients` with `kind: "SELF"` and `profile.name.display`, `profile.birthDate`, `profile.administrativeSex` (`FEMALE`, `MALE`, `OTHER`, `UNKNOWN`), `profile.contacts: [{ kind: "PHONE", value: "+91…", use: "PERSONAL" }]` |
| City (patient)                               | Only as part of a full address in `profile.addresses` (needs `line1`, `city`, `stateCode`, `postalCode`). The API stores no city on its own.                                                                                                     |
| Blood group                                  | Not stored by the API; drop it or keep it in a clinical record later.                                                                                                                                                                            |
| Doctor name, phone                           | `POST /practitioners/me` (`name`, `profession: "DOCTOR"`, `contacts`)                                                                                                                                                                            |
| Speciality                                   | `POST /doctors/me` → `specialtyIds` (ids from `GET /specialties`)                                                                                                                                                                                |
| Registration number                          | `POST /practitioners/me/registrations` (`authority`, `jurisdiction`, `registrationNumberNormalized`, `evidenceReference`)                                                                                                                        |
| Experience                                   | `POST /doctors/me` → `careerStartDate`                                                                                                                                                                                                           |
| Clinic name, fee                             | Not doctor fields. A clinic is an organization (section 9.1) and a fee is the price of a service offering (section 9.3). A solo doctor creates a `SOLO_PRACTICE` organization.                                                                   |

## 5. Who is this user? Building navigation

After sign-in (and on every full page load), run these calls in parallel and build the navigation from the results. Each is cheap.

| Call                    | Tells you                                                                                                                                                                                                    | Empty or `404` means                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `GET /auth/me`          | Account, platform permissions                                                                                                                                                                                | `401`: signed out                                  |
| `GET /me/patients`      | Patient profiles this account may act for. Items: `{ id, name, status, version, self }`; `self: true` is the account's own profile, the others are approved dependents                                       | No `self` profile yet: offer "Create your profile" |
| `GET /me/workspaces`    | Provider organizations the user works in: organization, facility scope, roles, **effective permissions**, and pending invitations                                                                            | Not provider staff                                 |
| `GET /practitioners/me` | Professional profile (doctor, nurse, pharmacist and others)                                                                                                                                                  | `404`: not a professional                          |
| `GET /doctors/me`       | Doctor profile: `slug`, `publicName`, `bio`, `specialtyIds`, `verificationStatus` (`UNVERIFIED`, `IN_REVIEW`, `VERIFIED`, `SUSPENDED`), `profilePublished`, `verificationCaseId`, `verifiedUntil`, `version` | `404`: not a doctor                                |
| `GET /me/notifications` | In-app notifications                                                                                                                                                                                         | —                                                  |

`GET /me/workspaces` response:

```json
{
  "workspaces": [
    {
      "membershipId": "…",
      "membershipVersion": 1,
      "organization": {
        "id": "…",
        "kind": "CLINIC",
        "displayName": "Sunrise Clinic",
        "slug": "sunrise-clinic",
        "status": "ACTIVE"
      },
      "facilityScope": "SELECTED",
      "facilityIds": ["…"],
      "roles": [{ "slug": "receptionist", "name": "Receptionist" }],
      "permissions": ["appointments.manage", "appointments.read", "billing.read", "…"]
    }
  ],
  "invitations": [
    {
      "membershipId": "…",
      "membershipVersion": 0,
      "organization": { "…": "…" },
      "facilityScope": "ALL",
      "facilityIds": [],
      "invitationExpiresAt": "…"
    }
  ]
}
```

Use it to show a workspace switcher ("Personal" plus one entry per organization) and to show only the console menu items whose permission the user has. Show pending invitations with an "Accept" button (`POST /me/memberships/{membershipId}/accept` with `{ expectedVersion: membershipVersion }`). The list is a guide for the interface: every command re-checks permissions on the server, so still handle `403` and `404`.

### Areas to show

| Condition                                           | Show                                                                              |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| Always                                              | Public site: find doctors, doctor pages, blog, policies                           |
| Signed in                                           | Account settings (password, sessions, two-factor), notifications, support tickets |
| Signed in (anyone can be a patient)                 | Patient portal; profile switcher if `GET /me/patients` has more than one profile  |
| `GET /practitioners/me` succeeds                    | Professional area: profile, qualifications, registrations, employment             |
| profession is a doctor (`GET /doctors/me` succeeds) | Doctor area: verification, affiliations, publication, leave                       |
| profession is not a doctor                          | Credential review (`/professionals/me/credential-reviews`)                        |
| `workspaces` not empty                              | Provider console, one per organization                                            |
| `GET /auth/me` `permissions` not empty              | Platform admin console                                                            |

### Provider console menu by organization permission

| Menu item                               | Show when the workspace has                                                                         | Main endpoints                                          |
| --------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Organization profile and verification   | `organization.read` (edit: `organization.manage`; submit: `organization.submit`)                    | `/organizations/{id}`, `/submit-verification`           |
| Facilities (branches)                   | `facilities.read` / `facilities.manage`                                                             | `/organizations/{id}/facilities`                        |
| Staff and roles                         | `memberships.read` / `memberships.manage`, `roles.assign`                                           | `/memberships`, `/role-assignments`                     |
| Doctors at this provider                | `affiliations.manage`                                                                               | `/doctor-affiliations`                                  |
| Services, prices, rooms and schedules   | `services.manage`, `scheduling.manage`                                                              | `/service-offerings`, `/resources`, `/schedules`        |
| Intake questionnaires                   | `services.manage`                                                                                   | `/questionnaires`                                       |
| Appointments and calendar               | `appointments.read` / `appointments.manage`                                                         | `/organizations/{id}/appointments`                      |
| Front desk queue                        | `queue.manage`                                                                                      | `/queue`                                                |
| Patients (registrations)                | `patients.demographics.read`, `patients.register`                                                   | `/patient-registrations`                                |
| Clinical workspace (charts, encounters) | `clinical.read`, `clinical.write`, `clinical.sign`                                                  | `/encounters`, `/patients/{patientId}/clinical-summary` |
| Lab worklist                            | `diagnostics.manage`, `diagnostics.verify`                                                          | `/lab-worklist`, `/specimens`, `/diagnostic-reports`    |
| Pharmacy and stock                      | `pharmacy.dispense`, `inventory.manage`, `procurement.manage`                                       | `/dispenses`, `/stock`, `/purchase-orders`              |
| Wards, beds and admissions              | `facilities.manage` (set up wards and beds), `inpatient.manage` (beds, admissions), `nursing.write` | `/locations`, `/bed-board`, `/admissions`               |
| Theatre                                 | `inpatient.manage` (board), `clinical.write` (request)                                              | `/theatre-schedule`, `/procedures`                      |
| Billing and payments                    | `billing.read` / `billing.manage`, `payments.collect`, `payments.refund`                            | `/invoices`, `/payments`                                |
| Accounts (ledger)                       | `ledger.read`                                                                                       | `/ledger/journals`, `/ledger/trial-balance`             |
| Online payments setup                   | `merchant.manage`                                                                                   | `/merchant-accounts`                                    |
| Insurance and claims                    | `billing.manage`                                                                                    | `/preauthorizations`, `/claims`                         |
| Documents                               | `documents.read` / `documents.manage`                                                               | `/organizations/{id}/documents`                         |
| Messages                                | `appointments.manage` (admin threads), clinical permissions (care threads)                          | `/organizations/{id}/conversations`                     |
| Reviews                                 | `reviews.reply`                                                                                     | `/reviews/{reviewId}/reply`                             |
| Subscription                            | `subscriptions.manage`                                                                              | `/subscription`                                         |
| Audit log                               | `audit.read`                                                                                        | `/audit-events`                                         |

Built-in roles and what they hold:

| Role                     | Permissions (summary)                                                                                                                                                                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `owner`, `administrator` | All administration: organization, facilities, staff, roles, services, schedules, appointments, queue, registrations, billing, payments, ledger, merchant, stock, procurement, inpatient operations, subscriptions, reviews, audit. **No clinical permissions.** |
| `receptionist`           | Registrations, demographics, appointments, queue, view bills, collect payments                                                                                                                                                                                  |
| `clinician`              | Charts (read, write, sign), prescribing, ordering tests, recording consents, documents, accepting doctor affiliations, queue                                                                                                                                    |
| `nurse`                  | Charts (read, write), nursing documentation, inpatient operations, queue, documents (read)                                                                                                                                                                      |
| `lab-technician`         | Diagnostics worklist, results and verification, documents                                                                                                                                                                                                       |
| `pharmacist`             | Dispensing, inventory, procurement                                                                                                                                                                                                                              |
| `billing`                | Invoices, payments, refunds, ledger                                                                                                                                                                                                                             |

An owner who is also a doctor (a solo practice) grants themselves the `clinician` role (section 9.2). Clinical screens additionally need the person's own verified credentials; the API answers `403 CREDENTIAL_INVALID` otherwise.

### Platform admin menu by platform permission

| Menu item                                                                 | Permission (`GET /auth/me` → `permissions`)                                               |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Dashboard                                                                 | `dashboard.view`                                                                          |
| Users, roles                                                              | `users.manage`, `roles.manage`                                                            |
| Provider verification queue                                               | `providers.verify`                                                                        |
| Doctor verification queue, doctor suspension                              | `doctors.verify`                                                                          |
| Nurse, pharmacist and lab credential queue                                | `professionals.verify`                                                                    |
| Representative (guardian) requests                                        | `patient-relationships.verify`                                                            |
| Duplicate patient merges                                                  | `patient-identity.manage`                                                                 |
| Merchant (online payment) activation                                      | `merchants.verify`                                                                        |
| Catalogs: drugs, tests, payers, questionnaire templates, concern mappings | `catalog.manage`                                                                          |
| Subscription plans and payments                                           | `commerce.manage`                                                                         |
| Support tickets                                                           | `support.manage`                                                                          |
| Review moderation                                                         | `reviews.moderate`                                                                        |
| Privacy requests, policies, retention holds                               | `privacy.manage`                                                                          |
| Platform audit                                                            | `audit.read`                                                                              |
| Failed events, operations health                                          | `operations.manage`                                                                       |
| Blog, categories, files, media, email                                     | `blogs.manage`, `blog-categories.manage`, `files.manage`, `assets.manage`, `email.manage` |

## 6. Site map

A suggested page structure. Each line lists the calls the page needs; see the reference for fields.

**Public**

| Page                                                      | Calls                                                                                                                                                           |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home, specialties                                         | `GET /specialties`                                                                                                                                              |
| "What's bothering you?" helper                            | `GET /discovery/concerns?q=` (search), `POST /discovery/route` with `concernCodes` (ranked specialties; `bookable: false` and emergency advice for emergencies) |
| Find a doctor                                             | `GET /discovery/doctors?specialtyId=&organizationId=&facilityId=&limit=&before=`                                                                                |
| Doctor page                                               | `GET /discovery/doctors?doctorId=` (one entry per clinic location), `GET /doctors/{doctorId}/reviews`                                                           |
| Service and time picker                                   | `GET /offerings/{offeringId}`, `GET /offerings/{offeringId}/availability?date=YYYY-MM-DD`, `GET /offerings/{offeringId}/questionnaire`                          |
| Blog                                                      | `GET /blogs`, `GET /blogs/slug/{slug}`, `GET /blog-categories`                                                                                                  |
| Legal pages                                               | `GET /policies`                                                                                                                                                 |
| For providers: pricing                                    | `GET /subscription-plans`                                                                                                                                       |
| Sign in, sign up, verify email, forgot and reset password | `/auth/*` (section 4)                                                                                                                                           |

Each discovery item is a doctor at one facility:

```json
{
  "id": "…",
  "doctorId": "…",
  "slug": "dr-asha-rao",
  "publicName": "Dr Asha Rao",
  "bio": "…",
  "organization": { "id": "…", "name": "Sunrise Clinic" },
  "facility": {
    "id": "…",
    "name": "Main branch",
    "kind": "CLINIC",
    "address": { "…": "…" },
    "contacts": [{ "kind": "PHONE", "value": "+91…" }]
  },
  "title": "Consultant",
  "department": "Cardiology",
  "languages": ["en", "hi"],
  "bookable": true,
  "offerings": [
    {
      "id": "…",
      "name": "Consultation",
      "mode": "IN_PERSON",
      "durationMinutes": 15,
      "paymentPolicy": "PREPAY",
      "price": { "totalMinor": 50000, "currency": "INR" }
    }
  ],
  "rating": { "average": 4.6, "count": 31 },
  "specialties": [{ "id": "…", "code": "…", "name": "Cardiology" }],
  "qualifications": [{ "name": "MBBS", "institution": "…", "awardYear": 2012 }]
}
```

**Patient portal** (signed in; pick the active profile from `GET /me/patients`)

| Page                   | Calls                                                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| My profiles and family | `GET /me/patients`, `POST /patients`, `GET/PATCH /patients/{patientId}/profile`, `GET /me/patient-relationships` |
| Appointments           | `GET /me/appointments?patientId=&status=` (`patientId` is required), `GET /appointments/{appointmentId}`         |
| Book (section 7.2)     | holds, intake, payment intents                                                                                   |
| Waitlist               | `POST /waitlist`, `GET /patients/{patientId}/waitlist`                                                           |
| Health records         | `GET /patients/{patientId}/clinical-records`, `GET /patients/{patientId}/diagnostic-reports`                     |
| Documents              | `GET /patients/{patientId}/documents`, `GET /me/documents`, uploads (section 11.1)                               |
| Bills                  | `GET /patients/{patientId}/invoices`, `POST /patients/{patientId}/invoices/{invoiceId}/payment-intents`          |
| Insurance              | `GET/POST /patients/{patientId}/coverages`, `GET /payers`                                                        |
| Messages               | `GET/POST /patients/{patientId}/conversations`, `/conversations/{conversationId}/messages`                       |
| Privacy                | `/patients/{patientId}/consents`, `/access-history`, `/export`, `/privacy-requests`                              |
| Reviews                | `POST /reviews`                                                                                                  |
| Help                   | `POST /support-tickets`, `GET /me/support-tickets`                                                               |

**Professional area**: section 8. **Provider console**: section 9. **Platform admin**: section 10.

## 7. Patient workflows

### 7.1 Create a patient profile

1. `GET /me/patients`. If no item has `self: true`, show the profile form.
2. `POST /patients` with `kind: "SELF"` and a `profile` (`name.display` is the only required profile field; add `birthDate`, `administrativeSex`, `contacts`, `addresses`, `emergencyContacts`).
3. Later edits: `GET /patients/{patientId}/profile`, then `PATCH /patients/{patientId}/profile` with `expectedVersion` and the full `profile` (it replaces the editable fields).

**Family members.** `POST /patients` with `kind: "DEPENDENT"`, a `relationship` (`PARENT`, `GUARDIAN`, `CAREGIVER`, `REPRESENTATIVE`) and an `authorityReference` (what proves the authority). The dependent profile starts **pending**: a DocDuniya reviewer decides it. Show its state from `GET /me/patient-relationships`. Until approved, the dependent does not appear as an active profile. Access to the dependent's medical records needs a separately reviewed medical authority; without it the representative manages the profile and bookings only, and record screens answer `404`.

### 7.2 Find a doctor and book

```text
discovery → doctor page → choose offering → availability → hold → (intake) → pay or confirm → confirmed
```

1. **Find.** `GET /discovery/doctors` with filters. Show `bookable` entries with their `offerings` and prices.
2. **Pick a time.** `GET /offerings/{offeringId}/availability?date=2026-12-01` returns `{ offeringId, offeringVersion, price: { id, amountMinor, taxMinor, totalMinor, currency }, timezone, slots: [{ startAt, endAt, available }] }`. Show `available` slots; dates up to 90 days ahead. Availability is an estimate: the hold re-checks everything.
3. **Hold.** `POST /appointments/holds` with a new idempotency key:

   ```json
   {
     "patientId": "<active profile>",
     "offeringId": "…",
     "offeringVersion": 3,
     "priceId": "<price.id>",
     "startAt": "<slot.startAt>",
     "reasonForVisit": "optional"
   }
   ```

   Returns `{ id, version }` of the appointment in status `HELD`. Then `GET /appointments/{id}` for `holdExpiresAt`, `price`, `paymentPolicy` and `cancellationPolicy`; show a countdown to `holdExpiresAt`.
   Handle `SLOT_UNAVAILABLE` (refresh the slots) and `QUOTE_CHANGED` (reload the offering and show the new price).

4. **Intake (if the service has one).** `GET /offerings/{offeringId}/questionnaire`. Render its questions (yes/no, single and multiple choice, text, number, date, with `enableWhen` conditions). Submit `POST /appointments/{appointmentId}/intake` with `answers: [{ linkId, valueBoolean | valueString | valueCodes | valueNumber | valueDate }]`. The response is `{ id, version, redFlags, advice }`: when `redFlags` is not empty, show `advice` (seek urgent care) prominently before continuing. The patient can resubmit until the visit; the latest response replaces the earlier one.
5. **Pay or confirm**, depending on `paymentPolicy`:
   - `PAY_AT_PROVIDER` or `FREE`: `POST /appointments/{appointmentId}/confirm` with `{ expectedVersion }`. Status becomes `CONFIRMED`.
   - `PREPAY`: online payment (section 7.3). The booking is confirmed by the payment itself; calling confirm returns `409 PAYMENT_NOT_READY`.
6. **Done.** Show the booking (`bookingNumber`, time, clinic). The patient receives an in-app notification and an email.

If the hold expires before payment or confirmation, the appointment becomes `EXPIRED` (`409 HOLD_EXPIRED` on later commands): start again from availability.

### 7.3 Pay online (Razorpay)

1. `POST /appointments/{appointmentId}/payment-intents` (no body; idempotency key required). For a bill: `POST /patients/{patientId}/invoices/{invoiceId}/payment-intents`.
   It returns the intent: `{ id, status, amountMinor, currency, appointmentId, invoiceIds, expiresAt, checkout, version }`.
2. If `status` is `READY`, `checkout` contains `{ provider: "RAZORPAY", keyId, orderId }`. If `status` is `ORDER_PENDING`, poll `GET /payment-intents/{intentId}` every 2–3 seconds until `checkout` appears.
3. Open Razorpay Checkout with `key: checkout.keyId`, `order_id: checkout.orderId`, `amount: amountMinor`, `currency: "INR"`. Never compute the amount yourself.
4. In the Checkout success handler, call `POST /payment-intents/{intentId}/verify` with

   ```json
   {
     "orderId": "<razorpay_order_id>",
     "paymentId": "<razorpay_payment_id>",
     "signature": "<razorpay_signature>"
   }
   ```

   It returns the updated intent.

5. Show "Payment received" when the intent `status` is `SUCCEEDED`, and read `GET /appointments/{appointmentId}` for `CONFIRMED`. Razorpay's webhook also confirms the payment, so if the browser closes after paying, the booking still confirms; poll the appointment on return.
6. `outcome: "REFUND_REQUIRED"` means the payment arrived after the hold expired or was cancelled: the booking is not revived and a full refund is issued. Tell the patient.

Errors: `MERCHANT_UNAVAILABLE` (the clinic cannot take online payments), `SIGNATURE_INVALID` (tampered or mismatched checkout response).

### 7.4 Manage a booking

| Action     | Call                                                                                                                                    | Notes                                                                                                                                                               |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| List       | `GET /me/appointments?patientId=&status=`                                                                                               | `patientId` (the active profile) is required. Filter by status for "Upcoming" and "Past" tabs                                                                       |
| Details    | `GET /appointments/{appointmentId}`                                                                                                     | `requiresReassignment: true` means the doctor is unavailable (leave or suspension): show "Your clinic will contact you" and offer reschedule or cancel              |
| Cancel     | `POST /appointments/{appointmentId}/cancel` with `expectedVersion`, `reason` (5+ chars)                                                 | Prepaid: the refund share follows the `cancellationPolicy` shown at booking (`noticeHours`, `refundBeforeBps`, `refundAfterBps`). Show it before the user confirms. |
| Reschedule | `POST /appointments/{appointmentId}/reschedule` with `expectedVersion`, `offeringId`, `offeringVersion`, `priceId`, `startAt`, `reason` | Pick a new slot from availability (same fields as a hold); the booking keeps its identity                                                                           |
| Intake     | `GET /appointments/{appointmentId}/intake`                                                                                              | Shows the submitted answers                                                                                                                                         |

**Waitlist.** When no slot fits, `POST /waitlist` with `patientId`, `offeringId`, `earliestDate`, `latestDate`. When a slot frees up, the patient gets a notification and the entry shows an offer for 30 minutes. `POST /waitlist/{entryId}/accept` places a normal hold (then continue from step 4 of 7.2). `POST /waitlist/{entryId}/cancel` leaves the list. List entries with `GET /patients/{patientId}/waitlist`.

### 7.5 After the visit

| Need                                                                                                                      | Call                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Visit summary, prescriptions, allergies, problems, immunizations (signed and released records only, across all providers) | `GET /patients/{patientId}/clinical-records`                                                                                              |
| Lab and imaging reports (verified only)                                                                                   | `GET /patients/{patientId}/diagnostic-reports`                                                                                            |
| Documents from the clinic and own uploads                                                                                 | `GET /patients/{patientId}/documents`; open one with `POST /documents/{documentId}/access` and `purpose: "PATIENT_ACCESS"` (section 11.1) |
| Bills                                                                                                                     | `GET /patients/{patientId}/invoices`, `GET /patients/{patientId}/invoices/{invoiceId}`; pay online as in 7.3                              |
| Review the doctor                                                                                                         | `POST /reviews` with `appointmentId`, `rating` 1–5, optional `text`. Only once, only after a completed visit; published after moderation. |
| Message the clinic                                                                                                        | Section 11.2                                                                                                                              |

Drafts are never shown to patients. A prescription in the portal is the signed version.

### 7.6 Privacy and consent

| Feature                                                                 | Calls                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Share records with another provider (second opinion, care coordination) | `POST /patients/{patientId}/consents/record-sharing` with `recipientOrganizationId`, `purposes`, `resourceTypes`, optional record period, `expiresAt`. List with `GET /patients/{patientId}/consents`; withdraw with `POST /consents/{consentId}/withdraw` (takes effect immediately). |
| Who looked at my records                                                | `GET /patients/{patientId}/access-history` (shows providers, not individual staff)                                                                                                                                                                                                     |
| Download my data                                                        | `GET /patients/{patientId}/export` (JSON)                                                                                                                                                                                                                                              |
| Privacy requests (access, correction, erasure, grievance)               | `POST /patients/{patientId}/privacy-requests`, `GET /patients/{patientId}/privacy-requests`                                                                                                                                                                                            |
| Accept updated terms                                                    | `GET /policies`, `POST /me/policy-acknowledgements`                                                                                                                                                                                                                                    |

## 8. Doctor and professional workflows

### 8.1 Doctor: from sign-up to a bookable listing

A doctor becomes visible in discovery only when all of these are true: verified by DocDuniya, an active affiliation with a verified provider facility, and published. Bookings additionally need an active service with a price and a schedule (section 9.3). Guide the doctor through a checklist page that reads the state of each step.

| Step                     | Who                                                                                                                                                                                                                                                                   | Call                                                                     | Key fields                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| 1. Professional profile  | Doctor                                                                                                                                                                                                                                                                | `POST /practitioners/me`                                                 | `name`, `profession: "DOCTOR"`, `contacts`, `languages`                                                   |
| 2. Qualifications        | Doctor                                                                                                                                                                                                                                                                | `POST /practitioners/me/qualifications` (one per degree)                 | `kind`, `qualificationName`, `institutionName`, `awardYear`, `evidenceReference`                          |
| 3. Council registration  | Doctor                                                                                                                                                                                                                                                                | `POST /practitioners/me/registrations`                                   | `authority`, `jurisdiction`, `registrationNumberNormalized`, `issuedOn`, `expiresOn`, `evidenceReference` |
| 4. Public doctor profile | Doctor                                                                                                                                                                                                                                                                | `POST /doctors/me` (edit with `PATCH /doctors/me` while unverified)      | `slug`, `publicName`, `bio` (10+ chars), `specialtyIds`, `careerStartDate`                                |
| 5. Request verification  | Doctor                                                                                                                                                                                                                                                                | `POST /doctors/me/verification-requests`                                 | `expectedVersion` (doctor), `registrationId`, `qualificationIds`, `declaration` (20+ chars)               |
| 6. Review                | DocDuniya reviewer                                                                                                                                                                                                                                                    | Section 10                                                               | —                                                                                                         |
| 7. Join a provider       | Provider admin invites the doctor's account as staff with the `clinician` role; the doctor accepts the invitation (`POST /me/memberships/{membershipId}/accept`)                                                                                                      | —                                                                        |
| 8. Affiliation           | Provider admin proposes (`POST /organizations/{id}/doctor-affiliations` with `doctorId`, `facilityId`, `title`, `department`); the doctor accepts (`GET /doctors/me/affiliations`, `POST /doctors/me/affiliations/{affiliationId}/respond` with `decision: "ACCEPT"`) | —                                                                        |
| 9. Publish               | Doctor                                                                                                                                                                                                                                                                | `POST /doctors/me/publication` with `expectedVersion`, `published: true` | —                                                                                                         |

`evidenceReference` values are references to evidence held for the reviewer (for example the id of an uploaded document, section 11.1), not the evidence itself.

A doctor in review or verified cannot change their legal name or birth date: `POST /doctors/me/withdraw-verification` returns them to a draft first. Show the review history with `GET /doctors/me/verification-requests`.

**Leave.** `POST /doctors/me/time-blocks` blocks the doctor's calendar at every provider; affected bookings are flagged `requiresReassignment` for the clinics. Cancel a block with `POST /doctors/me/time-blocks/{blockId}/cancel`.

### 8.2 Nurses, pharmacists, laboratory and other professionals

1. `POST /practitioners/me` with their `profession` (`NURSE`, `PHARMACIST`, `LAB_PROFESSIONAL`, `THERAPIST`, `OTHER`), then a registration (`POST /practitioners/me/registrations`).
2. Request review: `POST /professionals/me/credential-reviews` with `registrationId` and a `declaration` (20+ chars). Show status with `GET /professionals/me/credential-reviews`.
3. After approval (at most one year), they can sign, dispense, verify results or give medicines at providers where they are members. Expiry or suspension blocks those actions immediately (`403 CREDENTIAL_INVALID`); show a banner when the approval nears its expiry.

## 9. Provider console workflows

All console paths start with `/organizations/{organizationId}`; take the id from the selected workspace. Members restricted to some facilities (`facilityScope: "SELECTED"`) see only those branches: pass `facilityId` filters accordingly.

### 9.1 Register a provider (hospital, clinic, solo practice, lab, pharmacy)

1. `POST /organizations` with `kind`, `legalName`, `displayName`, `slug`, `legalAddress`, `contacts`. The caller becomes the owner; the organization starts as `DRAFT`.
2. `POST /organizations/{id}/facilities` for each branch: `name`, `code` (upper case), `kind`, `address`, `publicContacts`. Facilities start as `DRAFT`.
3. `POST /organizations/{id}/submit-verification` with `expectedVersion`, `declaration` (20+ chars) and `evidenceReferences`.
4. A DocDuniya reviewer approves it (section 10); the organization becomes `ACTIVE`.
5. Activate each facility: `POST /organizations/{id}/facilities/{facilityId}/state` with `expectedVersion`, `status: "ACTIVE"`, `reason`.
6. Online payments (optional): `POST /organizations/{id}/merchant-accounts` with the Razorpay `keyId` and `env:` references to secrets configured on the server; a DocDuniya reviewer activates it. Until then use pay-at-clinic services.
7. Subscription: `GET /subscription-plans`, then `POST /organizations/{id}/subscriptions`.

### 9.2 Staff and roles

1. The person must have a verified DocDuniya account. Invite by account id: `POST /organizations/{id}/memberships` with `userId`, `role`, `facilityScope` (`ALL` or `SELECTED`) and `facilityIds`.
2. They accept from their own account (invitations in `GET /me/workspaces`). Invitations expire after seven days.
3. Extra roles: `POST /organizations/{id}/memberships/{membershipId}/role-assignments` with `role`; revoke with `POST /organizations/{id}/role-assignments/{assignmentId}/revoke`.
4. Suspend, reactivate or end: `POST /organizations/{id}/memberships/{membershipId}/state`.

The API has no "find account by email" endpoint for providers; collect the invitee's account id (for example by having them share it from their profile page) or add such a lookup to the backend first.

A solo doctor who owns their practice grants themselves the `clinician` role in step 3; this is the only case where self-assignment is allowed.

### 9.3 Services, prices and schedules

1. Rooms and devices (optional): `POST /organizations/{id}/resources`.
2. Service: `POST /organizations/{id}/service-offerings` with `doctorAffiliationId`, `name`, `mode` (`IN_PERSON`, `VIDEO`, `AUDIO`), `durationMinutes`, buffers, `resourceIds`, `paymentPolicy` (`PAY_AT_PROVIDER`, `PREPAY`, `FREE`) and `cancellationPolicy`.
3. Price: `POST /organizations/{id}/service-offerings/{offeringId}/prices` with `expectedVersion`, `amountMinor`, `taxBasisPoints`. Published prices never change; publish a new one to change the fee.
4. Activate: `POST /organizations/{id}/service-offerings/{offeringId}/state` with `status: "ACTIVE"` and `reason`.
5. Weekly schedule: `POST /organizations/{id}/schedules` with `offeringId`, `weekdays` (0 = Sunday … 6 = Saturday), `startMinute`, `endMinute` (minutes after IST midnight), `stepMinutes`, `effectiveFrom`, `effectiveUntil`. Schedules are active as soon as they are created; pause or end one with `POST /organizations/{id}/schedules/{scheduleId}/state`.
6. Intake form (optional): create `POST /organizations/{id}/questionnaires`, publish it, then attach it with `PUT /organizations/{id}/offerings/{offeringId}/questionnaire`.

The doctor then appears in discovery with `bookable: true`.

### 9.4 Front desk: the clinic day

| Task                               | Call                                                                                                                                                                                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Day list                           | `GET /organizations/{id}/appointments?date=YYYY-MM-DD&facilityId=`                                                                                                                                                                       |
| Book for a patient (phone booking) | `POST /organizations/{id}/appointments/holds`, then `…/appointments/{appointmentId}/confirm`                                                                                                                                             |
| Find a registered patient          | `GET /organizations/{id}/patient-registrations?mrn=` (exact MRN; there is no free-text patient search)                                                                                                                                   |
| Register a walk-in                 | `POST /organizations/{id}/patient-registrations` with `facilityId` and `profile`; returns the registration with its MRN                                                                                                                  |
| Check in an arrival                | `POST /organizations/{id}/appointments/{appointmentId}/check-in` with `expectedVersion`. Allocates a queue token.                                                                                                                        |
| Walk-in without appointment        | `POST /organizations/{id}/queue` with `facilityId`, `patientRegistrationId`, `priority`. Keep the returned queue entry id: the doctor needs it to start the visit.                                                                       |
| Queue screen                       | `GET /organizations/{id}/queue`; move an entry with `POST /organizations/{id}/queue/{entryId}/transition` and `action`: `call`, `serve`, `done`, `left` or `prioritize` (status `WAITING` → `CALLED` → `IN_SERVICE` → `DONE`, or `LEFT`) |
| No-show                            | `POST /organizations/{id}/appointments/{appointmentId}/no-show`                                                                                                                                                                          |
| Bookings needing reassignment      | `GET /organizations/{id}/appointments?requiresReassignment=true`                                                                                                                                                                         |
| Take payment at the desk           | `POST /organizations/{id}/payments/offline` with `patientRegistrationId`, `method`, `amountMinor`, optional `invoiceId`                                                                                                                  |

### 9.5 Consultation (doctor)

1. From the day list or queue, start the appointment: `POST /organizations/{id}/appointments/{appointmentId}/start` (only the assigned doctor).
2. Open the encounter: `POST /organizations/{id}/encounters` with `patientId`, `facilityId`, `appointmentId` (or `queueEntryId` for a walk-in), `type.text` (for example "Outpatient consultation"), `chiefComplaint`, `mode`. Without arrival evidence the API answers `409 ARRIVAL_REQUIRED`. Video or audio visits need `telemedicineConsentId` (record it with `POST /organizations/{id}/consents`).
3. Chart side panel: `GET /organizations/{id}/patients/{patientId}/clinical-summary`, `GET …/timeline`, intake answers `GET /organizations/{id}/appointments/{appointmentId}/intake` (mark reviewed with `POST /organizations/{id}/intake-responses/{responseId}/review`).
4. Document:
   - Note: `POST /organizations/{id}/encounters/{encounterId}/notes` with `noteType`, `sections` (`history`, `examination`, `assessment`, `plan`), `reviewState`. Update the draft with `POST /organizations/{id}/clinical-notes/{noteId}/draft`.
   - Diagnosis: `POST …/encounters/{encounterId}/diagnoses`.
   - Vitals: `POST …/encounters/{encounterId}/observations`.
   - Prescription: `POST …/encounters/{encounterId}/prescriptions` with `items` (medicine, dosage, quantity, refills) and `validDays`. Drug picker: `GET /drugs`.
   - Tests: `POST …/encounters/{encounterId}/service-orders` (test picker: `GET /diagnostic-tests`).
   - Referral: `POST …/encounters/{encounterId}/referrals`.
   - Allergies, conditions, medicines, immunizations: `POST /organizations/{id}/patients/{patientId}/allergies` (and `/conditions`, `/medication-statements`, `/immunizations`); update with `…/{recordId}/update`.
5. Sign: `POST /organizations/{id}/clinical-records/{type}/{recordId}/sign` with `expectedVersion` and `attestation: true`, where `type` is `clinicalNote`, `diagnosis` or `prescription`. Signed records are final: correct them with `…/clinical-notes/{noteId}/amend`, `…/addenda`, or `…/clinical-records/{type}/{recordId}/mark-error`.
6. Share the note with the patient: `POST /organizations/{id}/clinical-notes/{noteId}/release`.
7. Finish: `POST /organizations/{id}/encounters/{encounterId}/finish`, then `POST /organizations/{id}/appointments/{appointmentId}/complete`.
8. Follow-ups: `GET /organizations/{id}/tasks` (result reviews, critical results), `POST /organizations/{id}/tasks/{taskId}/transition`.

Show drafts with a clear "Draft — not signed" label. Signing failures: `403 CREDENTIAL_INVALID`, `422 INCOMPLETE_RECORD`, `409 VERSION_CONFLICT`.

### 9.6 Laboratory

1. Worklist: `GET /organizations/{id}/lab-worklist`; accept an order with `POST /organizations/{id}/service-orders/{orderId}/transition`.
2. Specimen: `POST /organizations/{id}/specimens` (returns accession number and barcode), then receive or reject with `POST /organizations/{id}/specimens/{specimenId}/transition`.
3. Results: `POST /organizations/{id}/diagnostic-reports` (preliminary values).
4. Verify: `POST /organizations/{id}/diagnostic-reports/{reportId}/verify`. The ordering doctor gets a review task (a critical result creates an urgent task). Corrections: `…/amend`.
5. Imaging references: `POST /organizations/{id}/imaging-studies`.

### 9.7 Pharmacy and stock

| Task                     | Call                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Items and suppliers      | `POST/GET /organizations/{id}/inventory-items`, `/suppliers`                                                                 |
| Purchase order           | `POST /organizations/{id}/purchase-orders`; approve or order via `…/{orderId}/transition` (approval must be a second person) |
| Receive goods            | `POST /organizations/{id}/purchase-orders/{orderId}/receipts` (goods enter quarantine)                                       |
| Release a batch for sale | `POST /organizations/{id}/stock-batches/{batchId}/transition` (pharmacist)                                                   |
| Stock views              | `GET /organizations/{id}/stock`, `GET /organizations/{id}/stock/low`                                                         |
| Adjust or transfer       | `POST /organizations/{id}/stock-adjustments`, `/stock-transfers`                                                             |
| Dispense a prescription  | Read it with `GET /organizations/{id}/prescriptions/{prescriptionId}`, then `POST /organizations/{id}/dispenses`             |
| Return                   | `POST /organizations/{id}/dispenses/{dispenseId}/returns`                                                                    |

Dispensing creates a charge that billing turns into an invoice line.

### 9.8 Wards, beds and admissions

1. Wards, rooms and beds: `POST /organizations/{id}/locations` (a hierarchy), state changes with `…/locations/{locationId}/state`.
2. Bed board: `GET /organizations/{id}/bed-board`.
3. Admission: a clinician requests it with `POST /organizations/{id}/admissions` (arrival evidence required, as for encounters); staff admit to a bed with `…/admissions/{admissionId}/admit`; move with `…/transfer`.
4. Nursing: `GET …/admissions/{admissionId}/nursing-chart`; medicines given `…/medication-administrations` (corrections `…/medication-administrations/{administrationId}/correct`); fluids `…/fluid-balance`; vitals `…/observations`.
5. Discharge: `…/discharge-plan`, checklist items `/organizations/{id}/discharge-plans/{planId}/checklist`, then `…/clinical-discharge` (needs a signed discharge summary) and `…/depart` (frees the bed).

### 9.9 Theatre

1. A treating clinician requests a procedure: `POST /organizations/{id}/procedures`.
2. Theatre staff book a theatre and team: `POST /organizations/{id}/procedures/{caseId}/schedule` (overlaps return `409`).
3. The WHO checklist in order: `…/checklist/sign-in`, `…/checklist/time-out`, then `…/start` (surgeon), `…/checklist/sign-out`, `…/complete`. Cancel with `…/cancel`.
4. Board: `GET /organizations/{id}/theatre-schedule` (times and status only).

### 9.10 Billing, payments and insurance

| Task                      | Call                                                                                                                                                                                                                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unbilled charges          | `GET /organizations/{id}/charges`                                                                                                                                                                                                                                                  |
| Draft an invoice          | `POST /organizations/{id}/invoices` with `patientRegistrationId` and `appointmentId`, `chargeItemIds` or manual `lines`                                                                                                                                                            |
| Issue or discard          | `…/invoices/{invoiceId}/issue` (assigns the invoice number) or `…/discard` (drafts only)                                                                                                                                                                                           |
| Correct an issued invoice | `…/invoices/{invoiceId}/credit-notes`                                                                                                                                                                                                                                              |
| Receipts                  | `POST /organizations/{id}/payments/offline`; allocate later with `…/payments/{paymentId}/allocations`                                                                                                                                                                              |
| Refunds                   | `POST /organizations/{id}/payments/{paymentId}/refunds`                                                                                                                                                                                                                            |
| Lists                     | `GET /organizations/{id}/invoices`, `GET /organizations/{id}/payments`, `GET /organizations/{id}/payment-disputes`                                                                                                                                                                 |
| Accounts                  | `GET /organizations/{id}/ledger/journals`, `GET …/ledger/trial-balance`, reconciliation `POST …/reconciliations`                                                                                                                                                                   |
| Insurance                 | Policies: `POST /organizations/{id}/patients/{patientId}/coverages`. Pre-authorization: `POST …/preauthorizations`, record the payer's decision with `…/preauthorizations/{preauthId}/decision`. Claims: `POST …/claims`, then `…/adjudication`, `…/settlement` or `…/withdrawal`. |

## 10. Platform administration

Each queue follows the same pattern: list, open, decide with `expectedVersion`, a `decision` and a `reason`. Reviewers can never decide their own case or a case at a provider where they work; the API answers `403`.

| Queue                                      | List                                                     | Decide                                                                                                                                                                    |
| ------------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Providers                                  | `GET /platform/provider-verifications`                   | `POST /platform/provider-verifications/{verificationId}/decide`                                                                                                           |
| Doctors                                    | `GET /platform/doctor-verifications`, `GET …/{reviewId}` | `POST /platform/doctor-verifications/{reviewId}/decide` (approval needs explicit `checks` and `validUntil`); suspend with `POST /platform/doctors/{doctorId}/restriction` |
| Other professionals                        | `GET /admin/professional-credential-reviews`             | `POST /admin/professional-credential-reviews/{reviewId}/decision`, `…/suspension`                                                                                         |
| Representatives                            | `GET /platform/patient-relationship-requests`            | `POST /platform/patient-relationship-requests/{relationshipId}/decide`                                                                                                    |
| Duplicate patients                         | `GET /admin/patient-merge-requests`                      | `POST /admin/patient-merge-requests/{caseId}/decision`                                                                                                                    |
| Merchants                                  | `GET /platform/merchant-accounts`                        | `POST /platform/merchant-accounts/{merchantId}/decide`                                                                                                                    |
| Support                                    | `GET /platform/support-tickets`                          | `POST /platform/support-tickets/{ticketId}/transition`                                                                                                                    |
| Reviews                                    | `GET /platform/reviews`                                  | `POST /platform/reviews/{reviewId}/moderate`                                                                                                                              |
| Privacy requests                           | `GET /platform/privacy-requests`                         | `POST /platform/privacy-requests/{requestId}/decide`                                                                                                                      |
| Concern mappings (two different reviewers) | —                                                        | `POST /admin/concern-mappings`, `…/{concernId}/approve`, `…/retire`                                                                                                       |

Catalogs: `POST /platform/drugs`, `POST /platform/diagnostic-tests`, `POST /admin/payers`, `POST /admin/questionnaires` (templates), `POST /platform/policies`, `POST /platform/subscription-plans`. Operations: `GET /platform/outbox/failed`, `POST /platform/outbox/{eventId}/replay`, `GET /platform/operations/health`, `GET /platform/audit-events`. Content and accounts use `/users`, `/roles`, `/blogs`, `/blog-categories`, `/files` and `/assets`.

## 11. Shared building blocks

### 11.1 Uploading and opening private documents

Medical documents and credential evidence never go through the public media endpoints.

1. `POST /documents/upload-intents` with `custody` (one of: `{ kind: "PATIENT", patientId }` for a patient's own upload; `{ kind: "ORGANIZATION", organizationId, patientId }` for a provider document; `{ kind: "USER" }` for a professional's evidence), `category`, `title`, `originalName`, `mimeType` (PDF, PNG, JPEG or WebP) and the exact `sizeBytes`.
2. The response contains `upload: { method: "PUT", url, headers, expiresAt }`. `PUT` the file bytes directly to `url` with exactly those headers (from the browser, with `fetch(url, { method: 'PUT', headers, body: file })`). Do not send cookies or the API token to that URL.
3. `POST /documents/{documentId}/complete-upload` with `{ expectedVersion }`.
4. The file is scanned before it becomes available. Until then it is listed but cannot be opened (`409 DOCUMENT_NOT_AVAILABLE`); show "Processing". Poll the list.
5. To open: `POST /documents/{documentId}/access` with `purpose` (`PATIENT_ACCESS` for patients, `TREATMENT` for clinicians, `CREDENTIAL_REVIEW` for reviewers). It returns `{ url, expiresAt, sha256 }`; the URL works for 60 seconds, so request it on click and open it immediately. Never store it.
6. Providers release a document to the patient with `POST /organizations/{id}/documents/{documentId}/release`.

Public website images (blog, logos) use `/files` and `/assets` (multipart upload with the file in the `file` field).

### 11.2 Messaging

| Side     | Calls                                                                                                                                                                                                                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Patient  | Start: `POST /patients/{patientId}/conversations` with `organizationId`, `kind` (`CARE` for health questions, `ADMINISTRATIVE` for scheduling and billing), `subject`, `body`, optional `appointmentId`, `documentIds`. List: `GET /patients/{patientId}/conversations`. Thread: `GET/POST /conversations/{conversationId}/messages`. |
| Provider | Inbox: `GET /organizations/{id}/conversations`. Reply: `POST /organizations/{id}/conversations/{conversationId}/messages`. Close: `…/close`. Start: `POST /organizations/{id}/conversations`.                                                                                                                                         |

Messages are up to 4,000 characters with up to five documents of the same patient. Patients see whether the patient side or the provider side wrote a message, never individual staff names. There is no real-time push: refresh the thread on focus or every 15–30 seconds while it is open.

### 11.3 Notifications

`GET /me/notifications` (paginated) and `POST /me/notifications/{notificationId}/read`. Poll on navigation or every minute; show an unread badge. Notifications never contain clinical details: link to the relevant page.

### 11.4 Support

`POST /support-tickets`, `GET /me/support-tickets`, `POST /support-tickets/{ticketId}/replies`.

## 12. Known gaps

Plan the interface around these current backend limits:

- **Search:** discovery filters by specialty, provider, facility and doctor only. There is no city, text, distance or availability search yet, and no free-text patient search in the console (exact MRN only).
- **Invitations by email:** staff are invited by account id; there is no account lookup by email for providers.
- **Real-time:** no websockets or push; poll notifications, messages, payment intents and queues.
- **Channels:** no SMS, push notifications or video calls. Video and audio services exist as booking modes, but the call itself needs a separate provider.
- **Documents** stay in "Processing" until the server's malware scanner is configured.
- **Online payments** need an activated Razorpay merchant per provider; marketplace commission and payouts to providers are not built yet.
- **Insurance** decisions are entered by staff; there is no live insurer connection.
- **Not built yet:** nursing assessment scales, care plans, incident reporting, formulary rules, stock reservations, ABDM/FHIR exchange.

When the backend adds endpoints, run `npm run openapi` in `docduniya-backend` and the [API reference](api-reference.md) updates itself.
