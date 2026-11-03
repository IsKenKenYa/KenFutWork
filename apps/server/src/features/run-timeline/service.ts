import {
  renderRunTimelineMarkdown,
  runTimelineFilename,
} from "./markdown.js";
import { buildRunTimeline, mergeChildEvents } from "./timeline.js";
import {
  RunTimelineError,
  type RunTimelineRepository,
  type RunTimelineResult,
  type RunTimelineService,
} from "./types.js";

/** 时间线服务的 Provider：读仓储、投影条目、渲染导出。 */
export function createRunTimelineService(deps: {
  repository: RunTimelineRepository;
}): RunTimelineService {
  const load = async (
    instanceId: string,
    runId: string,
  ): Promise<RunTimelineResult> => {
    const run = await deps.repository.loadRun(instanceId, runId);
    if (!run) throw new RunTimelineError("not_found");
    const [events, usage, childSessions] = await Promise.all([
      deps.repository.loadEvents(instanceId, runId),
      deps.repository.loadUsage(instanceId, runId),
      deps.repository.loadChildSessions(instanceId, run.rootSessionId, runId),
    ]);
    const children = await Promise.all(
      childSessions.map(async (session) => ({
        session,
        events: await deps.repository.loadChildEvents(
          instanceId,
          run.rootSessionId,
          session.childSessionId,
        ),
      })),
    );
    return buildRunTimeline({
      run,
      events: mergeChildEvents({
        runId,
        parentEvents: events,
        children,
      }),
      usage,
    });
  };

  return {
    get(input) {
      return load(input.instanceId, input.runId);
    },

    async exportMarkdown(input) {
      const timeline = await load(input.instanceId, input.runId);
      return {
        markdown: renderRunTimelineMarkdown(timeline),
        filename: runTimelineFilename(input.runId),
      };
    },
  };
}
