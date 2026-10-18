# Local delivery and later submission

Local implementation is running at http://localhost:3000 with the existing private runtime configuration. See README.md for authenticated import, status/results/rejection pagination, worker startup, repairs and preserved-volume operations. See VERIFICATION.md for executed checks and measured limits. Private credentials were not copied into these files.

Remaining external delivery items (updated 2026-10-18):

- Choose cloud hosting with persistent PostgreSQL/Redis and an always-on worker. Configure secrets, apply migrations before API/worker rollout, smoke all six routes, and add the real deployed URL to README.md. Choose a deliberate demo credential policy without publishing this machine's actual key.
- The Git repository now exists with origin `https://github.com/Albin-R-Thomas/jumeau.git` and meaningful commits. Confirm it is private, grant reviewer access to `tech@jumeaucapital.com`, and push final reviewed changes. Historical daily emails cannot be verified or recreated truthfully.
- Add complete redacted conversation exports, including dead ends. `prompts/manifest.md` distinguishes the supplied/created summaries from unavailable full exports. Do not invent missing sessions or include secrets/private CSVs.
- Send the requested evaluation email only after authorization, with subject `Node Data and Backend Engineer Exercise evaluation: [your full name]`. Include the repository, real deployment URL, setup/test evidence, ambiguity/identity/quota tradeoffs, transcript gaps and any remaining limitations.

Suggested future progress-update template:

```text
Done: [concrete changes and executed checks]
Next: [next review/deployment step]
Blocked: [specific missing information or external dependency, if any]
```

Suggested evaluation body (not sent):

```text
Hello,

The CityWeather+ exercise is ready for evaluation.
Private repository: [real URL]
Deployment: [real URL]
API authentication/setup: [documented demo policy]
Verification: [link to the actual verification report]
AI records: [complete exports and explicitly disclosed gaps]
Known limitations: [provider candidate/identity limits and any deployment limits]

Regards,
[full name]
```
