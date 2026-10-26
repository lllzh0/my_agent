# ZCode source attribution

Upstream: [zai-org/ZCode](https://github.com/zai-org/ZCode), inspected at commit `3c5b227649371507ddc4eb46ac5133afe6db1cab` on 2026-10-24.

ZCode first-party code is licensed under Apache-2.0. The unmodified upstream [LICENSE](LICENSE) and [NOTICE.md snapshot](UPSTREAM-NOTICE.md) are retained here. The upstream notice describes ZCode's own operating modes and dependencies; My Agent's behavior is documented in [the feature guide](../../../../docs/workflow-agent-zcode-reuse.md).

`src/skills/external.ts` adapts source-directory mappings and bounded scan/exclusion policies from:

- `packages/services/src/settings-sync/settingsSyncService.ts`
- `packages/services/src/skills/skillDiscoveryWalk.ts`
- `packages/shared/src/skill-scan-policy.ts`
- `docs/external-agent-skills-import.md`

Modifications for My Agent: include `.agents/skills` as an explicit source, validate selected `SKILL.md` files, copy/link whole skill directories under the product home, skip conflicts, roll back failed activation, and coordinate with the existing resource and permission controls. No ZCode service or UI package is installed.

The request trace feature is a new implementation for OMP, informed by `docs/model-trajectory-viewer.md` and `apps/zcode-cli/packages/adapters/src/model/runner-debug.ts`. It uses OMP stream/payload hooks, local bounded JSON records and the existing `diff` dependency. ZCode's React viewer, JSONL storage and `tools/prompt-trajectory` scripts are not copied. Recording defaults **off** in My Agent.

No ZCode fonts, binaries, plugins or bundled third-party dependencies are redistributed by this change.
