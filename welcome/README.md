# welcome/

Content used by the welcome, add-on and estimate emails: service_code_map.json (customer-facing program names), service_descriptions.md (descriptions), and the email templates. Workers load these files from raw.githubusercontent.com, so this folder stays in this public repo.

The welcome and add-on email code no longer lives here. Since 2026-11-08 the only copy is `workers/saapi-after-service/src/welcome.js` in the private repo utlawndoctor/lawndoctor-workers, which deploys automatically on push.
