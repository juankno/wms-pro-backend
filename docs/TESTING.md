# Testing

## Reglas que el CI hace cumplir

Workflow `.github/workflows/ci.yml`, job `lint-test`, en cada PR y en cada push a `main`:

1. `npm run lint`: ESLint (`typescript-eslint` con reglas type-checked), sin `--fix`.
2. `npm run typecheck`: `tsc --noEmit`.
3. `npm run test:cov`: tests unitarios + de integración, con cobertura (lcov y cobertura).
4. `npm run build`.
5. `npm audit --audit-level critical`.
6. Cobertura del diff ≥ 80 % (diff-cover contra la rama base).

`pr-checks.yml` valida el nombre de la rama (`(feature|fix|chore|refactor)/<slug>`) y que los commits sigan Conventional Commits.

## Ubicación por tipo de test

| Tipo | Ubicación | Proyecto Vitest | Dependencias |
|---|---|---|---|
| Unitario | `src/**/*.spec.ts`, junto al código | `unit` | Ninguna |
| Integración | `test/**/*.e2e-spec.ts` | `integration` | PostgreSQL en `TEST_DATABASE_URL` |
| E2E HTTP | Pendiente | — | — |

Los tests de integración crean y borran sus propios datos. `TEST_DATABASE_URL` debe apuntar a una base desechable, nunca a datos reales.

## Comandos

```bash
npm test             # unit
npm run test:e2e     # integration (requiere TEST_DATABASE_URL)
npm run test:cov     # ambos, con cobertura en coverage/
npm run lint
npm run typecheck
```

Base de pruebas local, la primera vez:

```bash
DATABASE_URL="$TEST_DATABASE_URL" npx prisma migrate deploy
```

## Herramientas

Vitest + SWC (`unplugin-swc`, para la metadata de los decoradores). NestJS 12 se publica solo como ESM, así que Jest no puede cargarlo.

## Estado de los gates

| Gate | Estado | Pendiente |
|---|---|---|
| Lint | Bloqueante | — |
| Typecheck | Bloqueante | — |
| Tests | Bloqueante | — |
| Build | Bloqueante | — |
| Audit (critical) | Bloqueante | — |
| Cobertura del diff ≥ 80 % | **Solo informativo** (`continue-on-error`) | picking, packing, products y reports no tienen tests. Pasa a bloqueante en cuanto el PR de picking/packing (tareas 0.3 y 0.6 del plan) agregue su suite. |
| E2E HTTP (supertest) | No existe | Scaffold con `@nestjs/testing` + supertest para auth y guards. |
