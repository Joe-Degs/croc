import { join } from "node:path";
import { getTaskplaneBatteryTools } from "./battery-contributions.ts";
import type { CrocConfig } from "./config.ts";
import { writeJson } from "./config.ts";

const DEFAULT_TOOLS = "read,write,edit,bash,grep,find,ls";
const REVIEWER_TOOLS = "read,bash,grep,find,ls";

function addTools(tools: string, extras: string[]): string {
	const merged = new Set(
		tools
			.split(",")
			.map((tool) => tool.trim())
			.filter(Boolean),
	);
	for (const extra of extras) merged.add(extra);
	return [...merged].join(",");
}

function toolsFor(config: CrocConfig, baseTools: string): string {
	return addTools(baseTools, getTaskplaneBatteryTools(config));
}

export function getTaskplaneConfigPath(cwd: string): string {
	return join(cwd, ".pi", "taskplane-config.json");
}

export function buildTaskplaneConfig(config: CrocConfig): Record<string, unknown> {
	const taskplane = config.taskplane;
	return {
		configVersion: 1,
		taskRunner: {
			project: {
				name: taskplane.projectName,
				description: taskplane.projectDescription,
			},
			paths: {
				tasks: taskplane.tasksPath,
			},
			testing: {
				commands: taskplane.testingCommands,
			},
			standards: {
				docs: [],
				rules: [],
			},
			standardsOverrides: {},
			worker: {
				model: taskplane.workerModel,
				tools: toolsFor(config, DEFAULT_TOOLS),
				thinking: taskplane.workerThinking,
				excludeExtensions: [],
			},
			reviewer: {
				model: taskplane.reviewerModel,
				tools: toolsFor(config, REVIEWER_TOOLS),
				thinking: taskplane.reviewerThinking,
				excludeExtensions: [],
			},
			context: {
				workerContextWindow: 0,
				warnPercent: 85,
				killPercent: 95,
				compactionKillPolicy: taskplane.compactionKillPolicy,
				maxWorkerIterations: taskplane.maxWorkerIterations,
				maxReviewCycles: 2,
				noProgressLimit: 3,
				maxWorkerMinutes: taskplane.maxWorkerMinutes,
			},
			taskAreas: {
				default: {
					path: taskplane.tasksPath,
					prefix: taskplane.taskPrefix,
					context: `${taskplane.tasksPath}/CONTEXT.md`,
				},
			},
			referenceDocs: {},
			neverLoad: [],
			selfDocTargets: {},
			protectedDocs: [],
			qualityGate: {
				enabled: false,
				reviewModel: "",
				maxReviewCycles: 2,
				maxFixCycles: 1,
				passThreshold: "no_critical",
			},
			modelFallback: "inherit",
		},
		orchestrator: {
			orchestrator: {
				maxLanes: taskplane.maxLanes,
				worktreeLocation: taskplane.worktreeLocation,
				worktreePrefix: taskplane.worktreePrefix,
				batchIdFormat: "timestamp",
				spawnMode: "subprocess",
				sessionPrefix: taskplane.sessionPrefix,
				operatorId: "",
				integration: taskplane.integration,
			},
			dependencies: {
				source: "prompt",
				cache: true,
			},
			assignment: {
				strategy: "affinity-first",
				sizeWeights: { S: 1, M: 2, L: 4 },
			},
			preWarm: {
				autoDetect: false,
				commands: {},
				always: [],
			},
			merge: {
				model: taskplane.mergeModel,
				tools: toolsFor(config, DEFAULT_TOOLS),
				thinking: taskplane.mergeThinking,
				verify: taskplane.mergeVerify,
				order: "fewest-files-first",
				timeoutMinutes: 90,
				excludeExtensions: [],
			},
			failure: {
				onTaskFailure: "skip-dependents",
				onMergeFailure: "pause",
				stallTimeout: taskplane.stallTimeoutMinutes,
				maxWorkerMinutes: taskplane.maxWorkerMinutes,
				abortGracePeriod: 60,
			},
			monitoring: {
				pollInterval: 5,
			},
			verification: {
				enabled: false,
				mode: "permissive",
				flakyReruns: 1,
			},
			supervisor: {
				model: taskplane.supervisorModel || config.pi.model,
				autonomy: taskplane.supervisorAutonomy,
			},
		},
	};
}

export function writeTaskplaneConfig(cwd: string, config: CrocConfig): string {
	const path = getTaskplaneConfigPath(cwd);
	writeJson(path, buildTaskplaneConfig(config));
	return path;
}
