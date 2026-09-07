# Lawn Doctor Assets

Static assets (mainly images) used by automation skills for the Lawn Doctor franchise.
Public repo so files can be fetched directly via raw.githubusercontent.com without auth.

## Structure
- `images/email/` — images embedded (as Mailgun inline attachments) in after-service
  and daily-batch customer emails: logos, badges, stars, review icon.

To add more assets later: drop files into a sensibly named folder here (e.g. `images/website/`,
`images/social/`) and reference them via:
`https://raw.githubusercontent.com/utlawndoctor/lawndoctor-assets/main/<path>`
