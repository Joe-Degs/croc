export const CONTEXT_KILL_COMPACTION_START_DEBOUNCE_MS = 500;
export const CONTEXT_KILL_COMPACTION_GRACE_MS = 300_000;

export type TimerHandle = unknown;
export type ContextKillPolicyValue = "immediate" | "defer";

export interface ContextKillPolicyAgentEvent {
	type?: string;
	payload?: unknown;
	[key: string]: unknown;
}

export interface ContextKillPolicyOptions {
	policy: ContextKillPolicyValue;
	killPercent: number;
	onKill: () => void;
	setTimer?: (callback: () => void, ms: number) => TimerHandle;
	clearTimer?: (handle: TimerHandle) => void;
}

export interface ContextKillPolicy {
	observeContextPercent(percent: number): void;
	observeAgentEvent(event: ContextKillPolicyAgentEvent): void;
	dispose(): void;
}

function defaultSetTimer(callback: () => void, ms: number): TimerHandle {
	return setTimeout(callback, ms);
}

function defaultClearTimer(handle: TimerHandle): void {
	clearTimeout(handle as ReturnType<typeof setTimeout>);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function eventField(event: ContextKillPolicyAgentEvent, field: string): unknown {
	if (isRecord(event.payload) && field in event.payload) return event.payload[field];
	return event[field];
}

function compactionFinishedSuccessfully(event: ContextKillPolicyAgentEvent): boolean {
	if (eventField(event, "aborted") === true) return false;
	const success = eventField(event, "success");
	if (success === true) return true;
	if (success === false) return false;
	return eventField(event, "status") === "completed";
}

export function createContextKillPolicy(options: ContextKillPolicyOptions): ContextKillPolicy {
	const kill = options.onKill;
	if (!kill) throw new Error("createContextKillPolicy requires onKill");

	const setTimer = options.setTimer ?? defaultSetTimer;
	const clearTimer = options.clearTimer ?? defaultClearTimer;

	let disposed = false;
	let killed = false;
	let highContextPending = false;
	let compactionActive = false;
	let compactionRetryPending = false;

	let debounceTimer: TimerHandle;
	let debounceTimerActive = false;
	let graceTimer: TimerHandle;
	let graceTimerActive = false;

	function stopped(): boolean {
		return disposed || killed;
	}

	function clearDebounceTimer(): void {
		if (!debounceTimerActive) return;
		debounceTimerActive = false;
		clearTimer(debounceTimer);
	}

	function clearGraceTimer(): void {
		if (!graceTimerActive) return;
		graceTimerActive = false;
		clearTimer(graceTimer);
	}

	function clearTimers(): void {
		clearDebounceTimer();
		clearGraceTimer();
	}

	function killOnce(): void {
		if (stopped()) return;
		killed = true;
		highContextPending = false;
		clearTimers();
		kill();
	}

	function startGraceTimer(): void {
		if (stopped() || graceTimerActive) return;
		graceTimerActive = true;
		graceTimer = setTimer(() => {
			if (!graceTimerActive) return;
			graceTimerActive = false;
			if (stopped() || !highContextPending) return;
			killOnce();
		}, CONTEXT_KILL_COMPACTION_GRACE_MS);
	}

	function startDebounceTimer(): void {
		if (stopped() || debounceTimerActive || graceTimerActive) return;
		debounceTimerActive = true;
		debounceTimer = setTimer(() => {
			if (!debounceTimerActive) return;
			debounceTimerActive = false;
			if (stopped() || !highContextPending) return;
			killOnce();
		}, CONTEXT_KILL_COMPACTION_START_DEBOUNCE_MS);
	}

	function clearPendingKill(): void {
		highContextPending = false;
		clearTimers();
	}

	return {
		observeContextPercent(percent: number): void {
			if (stopped() || !Number.isFinite(percent)) return;
			if (percent < options.killPercent) {
				if (options.policy === "defer") clearPendingKill();
				return;
			}

			if (options.policy !== "defer") {
				killOnce();
				return;
			}

			if (highContextPending) return;
			highContextPending = true;

			if (compactionActive || compactionRetryPending) {
				startGraceTimer();
			} else {
				startDebounceTimer();
			}
		},

		observeAgentEvent(event: ContextKillPolicyAgentEvent): void {
			if (stopped()) return;

			if (event.type === "compaction_started") {
				compactionActive = true;
				compactionRetryPending = false;
				if (!highContextPending) return;
				clearDebounceTimer();
				startGraceTimer();
				return;
			}

			if (event.type !== "compaction_finished") return;

			compactionActive = false;
			if (eventField(event, "willRetry") === true) {
				compactionRetryPending = true;
				return;
			}

			compactionRetryPending = false;
			if (compactionFinishedSuccessfully(event)) {
				clearPendingKill();
				return;
			}

			if (highContextPending) killOnce();
		},

		dispose(): void {
			if (disposed) return;
			disposed = true;
			clearTimers();
		},
	};
}
