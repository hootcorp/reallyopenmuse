# Changelog

## Unreleased

- Removed the third-party agent SDK packages and the hosted thread-persistence service requirement; no external key is needed to start the API.
- Local AG-UI runtime (`/api/agui`) built on TanStack AI, a dependency-free AG-UI client (`packages/agui`), and database-backed conversation threads (`/api/main-thread`, `/api/threads`).
- In-repo mock model (`apps/server/src/demo/mock-llm.ts`) replaces the external AI mock dev dependency.
- Removed the disabled OpenBot HTTP adapter (`packages/backends`) and its docs, which only targeted the removed runtime.

## 0.1.0-alpha — 2026-09-15

Initial public OpenMuse alpha.

- Native/web interface using React Native and AG-UI.
- Persistent browser computer, inline PDFs, structured artifacts, and conversation threads.
- Durable delegated tasks, reviews/receipts, Ideas, Goals, Tracking, and editable memory.
- Google adapters, supported PDF workflows, and CSV spending summaries.
- Native walkthrough recording, contributor docs, and CI for tests, builds, and real Chromium.
- Fixed Ideas suggesting sent replies or already completed matching work; restored task delegation in the persistent menu.

See [verification](docs/VERIFICATION.md) for actual coverage and [roadmap](ROADMAP.md) for incomplete integrations.
