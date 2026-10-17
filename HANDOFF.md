# Local delivery and later submission

Local implementation is running at http://localhost:3000 with the existing private runtime configuration. See README.md for authenticated import, status/results/rejection pagination, worker startup, repairs and preserved-volume operations. See VERIFICATION.md for executed checks and measured limits. Private credentials were not copied into these files.

Remaining external steps require a separately authorized operator:

- Choose cloud hosting with persistent PostgreSQL/Redis and an always-on worker. Configure secrets, apply migrations before API/worker rollout, smoke all six routes, and add the real deployed URL to README.md. Choose a deliberate demo credential policy without publishing this machine's actual key.
- Create a private repository (Task.md says no fork), add the requested collaborator `tech@jumeaucapital.com`, and push the implementation/lockfile/migrations/docs. This directory currently has no Git metadata; no historical daily commits can be verified or recreated truthfully.
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
