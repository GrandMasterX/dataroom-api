---
name: nestjs-api-conventions
description: Conventions for this NestJS + Prisma API — module boundaries, thin controllers, DTOs with class-validator and Swagger, the error-envelope exception filter, transaction and advisory-lock patterns, config validation at boot, response mapping (never return Prisma entities), BigInt handling, and log redaction. Use whenever you add or change a controller, service, module, guard, pipe, filter, DTO or Prisma call in the API, when mapping a database error to an HTTP status, or when a review asks whether an endpoint is shaped correctly.
---

# NestJS API conventions

The goal of these rules is that a reviewer can predict where any piece of logic lives without
searching, and that no endpoint can leak data or lose a transaction by accident.

## Layering

```
controller  — HTTP shape only: params, DTO in, response DTO out. No Prisma, no business rules.
service     — the decision and the transaction. Owns invariants. Knows nothing about HTTP.
repository  — only when a query is raw SQL or reused by 3+ services. Otherwise Prisma in the service.
guard       — builds AccessContext (session or share token). Never business decisions.
filter/pipe — cross-cutting translation: validation errors, Prisma errors, error envelope.
```

A controller method longer than ~15 lines is usually a service method that leaked upward. A service
that imports `Request`, `Response` or an HTTP exception type has the layering inverted — throw domain
errors and let the filter map them.

## DTOs and the wire contract

- Request DTOs are classes with `class-validator` decorators and `@ApiProperty`. Validation runs
  through a global `ValidationPipe` with `whitelist: true` and `forbidNonWhitelisted: true`, so unknown
  fields are rejected rather than silently ignored. Silently ignored fields are how a client thinks it
  set `role: 'EDITOR'` and the server thinks otherwise.
- **Never return a Prisma model from a controller.** Map to a response DTO explicitly. Entities carry
  fields that must never reach a client (`passwordHash`, `storageKey`, `tokenHash`) and a future column
  addition would leak automatically. An explicit mapper fails closed: new columns stay invisible until
  someone adds them.
- `BigInt` (file sizes) is converted to `number` in the mapper, not by patching `BigInt.prototype.toJSON`.
  A global patch changes serialization everywhere including logs, which is a surprising action at a
  distance; the mapper documents the boundary where the conversion is safe.
- The OpenAPI document is the contract consumed by a separate frontend repository. Adding an endpoint
  without `@ApiProperty`/`@ApiResponse` means the frontend cannot see it — treat missing decorators as
  an incomplete change, not a style nit.

## Errors

One envelope, one place that produces it:

```
{ "error": { "code": "NAME_CONFLICT", "message": "...", "details": { ... } } }
```

- Services throw domain errors carrying a code; a single exception filter maps code → HTTP status and
  envelope. Controllers do not build error responses, and no two places decide the status for one code.
- Database errors are translated at that boundary: Prisma `P2002` (unique violation) → the domain
  conflict, `P2025` (not found) → not found. Letting a raw Prisma error escape leaks column and index
  names to the client.
- The status for "you may not read this" is **404** (see the `dataroom-domain` skill for why); 403 is
  only for "you may read but not write". Pick the status in the domain error, not in the controller.

## Transactions and locking

- One decision, one transaction. Use `prisma.$transaction(async tx => ...)` and pass `tx` down; a
  service that opens a second transaction inside the first has silently created two atomicity domains.
- Reads that a write depends on happen **inside** the transaction. A parent folder read before the
  transaction can be deleted before the insert lands.
- Tree mutations take the per-data-room advisory lock first (`pg_advisory_xact_lock`). It is released
  with the transaction, so there is no unlock path to forget. Do not add a second lock granularity
  without stating what it protects that the first does not.
- Never call S3 or any network service inside a transaction. Holding a DB transaction across a network
  call turns a slow dependency into database contention; blob work happens after commit.

## Config

Every environment variable is declared and validated at boot, and the process refuses to start when one
is missing or malformed. The alternative — discovering a missing `S3_BUCKET` on the first upload — turns
a deploy-time error into a user-visible one. Read config only through the typed config service, never
`process.env` scattered in services, so the set of required variables is greppable in one file.

## Logging and observability

- Structured logs with a request id. Redact `authorization`, `cookie`, `set-cookie`, share tokens and
  presigned URLs — a presigned URL in a log is a working credential for anyone with log access.
- Log the decision, not the payload: node ids, actor id, action, outcome. Document contents and file
  names of a due-diligence data room do not belong in logs.
- `/healthz` checks the database, not just process liveness, otherwise a platform health check reports
  green while every request 500s.

## Review checklist

Before calling an API change done:

1. Controller has no Prisma import and no business branching.
2. Response goes through an explicit mapper; no entity reaches the wire.
3. New/changed endpoint has validation DTO + Swagger decorators, and the emitted OpenAPI file is updated.
4. Every new error path has a code in the envelope table and a mapped status.
5. Writes that touch more than one row are in one transaction; tree writes hold the advisory lock.
6. No network call inside a transaction.
7. New env var validated at boot and added to `.env.example`.
8. Tests: at least one that fails if the guard is removed, and one that fails if the transaction is split.
