import { ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import { expect, it } from "vitest";
import { useCodeUiHttpFixture } from "./code-ui-http.fixture.js";

const { request } = useCodeUiHttpFixture();
it.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "同一技能卸载后重装，旧安装草稿不得停用或卸载新安装 integration",
  async () => {
    const created = await request("/api/skills", {
      name: "reinstall-probe",
      description: "重装",
      category: "custom",
      skillContent: "# 技能",
    });
    expect(created.status).toBe(201);
    const id = created.body.skill.id;
    expect(
      (await request("/api/instance/skills", { skillId: id })).status,
    ).toBe(204);
    const before = await request("/api/code-ui/rpc", {
      service: "skills",
      method: "list",
      args: [{ provider: ZCODE_AGENT_PROVIDER }],
    });
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    const revision = before.body.result.skills[0].installationRevision;
    expect(
      (await request(`/api/instance/skills/${id}`, undefined, "DELETE")).status,
    ).toBe(204);
    expect(
      (await request("/api/instance/skills", { skillId: id })).status,
    ).toBe(204);
    expect(
      (
        await request("/api/code-ui/rpc", {
          service: "skills",
          method: "setEnabled",
          args: [
            {
              scope: "user",
              provider: ZCODE_AGENT_PROVIDER,
              skillId: id,
              enabled: false,
              installationRevision: revision,
            },
          ],
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request("/api/code-ui/rpc", {
          service: "skills",
          method: "deleteSkill",
          args: [
            {
              provider: ZCODE_AGENT_PROVIDER,
              skillId: id,
              installationRevision: revision,
            },
          ],
        })
      ).status,
    ).toBe(404);
    expect((await request("/api/instance/skills")).body.skills).toEqual([
      expect.objectContaining({ id, enabled: true }),
    ]);
  },
);
it.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原技能页无需Project读取真实本机安装态，停用不卸载且卸载后迟到启停不能重装 integration",
  async () => {
    for (const project of (await request("/api/projects?kind=code")).body
      .projects)
      expect(
        (await request(`/api/projects/${project.id}`, undefined, "DELETE"))
          .status,
      ).toBe(204);
    const created = await request("/api/skills", {
      name: "ui-skill-probe",
      description: "中文技能",
      category: "custom",
      skillContent:
        "---\nname: ui-skill-probe\ndescription: 中文技能\n---\n# 原正文\n\n- 项目😀\n",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.skill.id;
    expect(
      (await request("/api/instance/skills", { skillId: id })).status,
    ).toBe(204);
    const list = () =>
      request("/api/code-ui/rpc", {
        service: "skills",
        method: "list",
        args: [{ provider: ZCODE_AGENT_PROVIDER }],
      });
    const loaded = await list();
    expect(loaded.status, JSON.stringify(loaded.body)).toBe(200);
    expect(loaded.body.result).toMatchObject({
      capability: { userScopeAvailable: true },
    });
    expect(loaded.body.result.skills).toEqual([
      expect.objectContaining({
        id,
        name: "ui-skill-probe",
        scope: "user",
        path: "",
        enabled: true,
        resourceRef: `kenfutwork-skill:${id}`,
      }),
    ]);
    const installationRevision =
      loaded.body.result.skills[0].installationRevision;
    const toggle = (enabled: boolean) =>
      request("/api/code-ui/rpc", {
        service: "skills",
        method: "setEnabled",
        args: [
          {
            provider: ZCODE_AGENT_PROVIDER,
            scope: "user",
            skillId: id,
            enabled,
            installationRevision,
          },
        ],
      });
    expect((await toggle(false)).status).toBe(200);
    expect((await list()).body.result.skills).toEqual([
      expect.objectContaining({ id, enabled: false }),
    ]);
    expect((await request("/api/instance/skills")).body.skills).toEqual([
      expect.objectContaining({ id, enabled: false }),
    ]);
    expect(
      (
        await request("/api/code-ui/rpc", {
          service: "skills",
          method: "deleteSkill",
          args: [
            {
              provider: ZCODE_AGENT_PROVIDER,
              skillId: id,
              installationRevision,
            },
          ],
        })
      ).status,
    ).toBe(200);
    expect((await list()).body.result.skills).toEqual([]);
    expect((await toggle(true)).status).toBe(404);
    expect((await request("/api/instance/skills")).body.skills).toEqual([]);
    expect(
      (await request("/api/skills")).body.skills.map(
        (row: { id: string }) => row.id,
      ),
    ).toContain(id);
    expect((await request("/api/projects?kind=code")).body.projects).toEqual(
      [],
    );
  },
);
