import { describe, it } from "node:test";
import { expect } from "./expect.ts";
import {
	CONTEXT_KILL_COMPACTION_GRACE_MS,
	CONTEXT_KILL_COMPACTION_START_DEBOUNCE_MS,
	createContextKillPolicy,
	type TimerHandle,
} from "../taskplane/context-kill-policy.ts";

interface ScheduledTimer {
	id: number;
	callback: () => void;
	ms: number;
	active: boolean;
}

class FakeTimers {
	private nextId = 1;
	readonly timers = new Map<number, ScheduledTimer>();

	setTimer = (callback: () => void, ms: number): TimerHandle => {
		const id = this.nextId++;
		this.timers.set(id, { id, callback, ms, active: true });
		return id;
	};

	clearTimer = (handle: TimerHandle): void => {
		const timer = this.timers.get(Number(handle));
		if (timer) timer.active = false;
	};

	activeTimers(): ScheduledTimer[] {
		return [...this.timers.values()].filter((timer) => timer.active);
	}

	activeTimer(): ScheduledTimer {
		const timers = this.activeTimers();
		expect(timers).toHaveLength(1);
		return timers[0];
	}

	fire(id: number): void {
		const timer = this.timers.get(id);
		if (!timer) throw new Error(`unknown timer ${id}`);
		timer.active = false;
		timer.callback();
	}
}

describe("context kill policy", () => {
	it("exports compaction debounce and grace constants", () => {
		expect(CONTEXT_KILL_COMPACTION_START_DEBOUNCE_MS).toBe(500);
		expect(CONTEXT_KILL_COMPACTION_GRACE_MS).toBe(300_000);
	});

	it("kills synchronously at the threshold in immediate mode", () => {
		let kills = 0;
		const policy = createContextKillPolicy({
			policy: "immediate",
			killPercent: 95,
			onKill: () => {
				kills++;
			},
		});

		policy.observeContextPercent(94.9);
		expect(kills).toBe(0);

		policy.observeContextPercent(95);
		expect(kills).toBe(1);

		policy.observeContextPercent(100);
		policy.observeAgentEvent({ type: "compaction_finished", payload: { success: false } });
		expect(kills).toBe(1);
	});

	it("starts one debounce timer for deferred high-context telemetry", () => {
		const timers = new FakeTimers();
		let kills = 0;
		const policy = createContextKillPolicy({
			policy: "defer",
			killPercent: 95,
			onKill: () => {
				kills++;
			},
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
		});

		policy.observeContextPercent(95);
		const debounce = timers.activeTimer();
		expect(debounce.ms).toBe(CONTEXT_KILL_COMPACTION_START_DEBOUNCE_MS);

		policy.observeContextPercent(96);
		expect(timers.activeTimer().id).toBe(debounce.id);

		timers.fire(debounce.id);
		expect(kills).toBe(1);

		timers.fire(debounce.id);
		policy.observeContextPercent(99);
		expect(kills).toBe(1);
	});

	it("ignores non-finite context telemetry", () => {
		const timers = new FakeTimers();
		let immediateKills = 0;
		const immediatePolicy = createContextKillPolicy({
			policy: "immediate",
			killPercent: 95,
			onKill: () => {
				immediateKills++;
			},
		});
		const deferPolicy = createContextKillPolicy({
			policy: "defer",
			killPercent: 95,
			onKill: () => {
				immediateKills++;
			},
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
		});

		immediatePolicy.observeContextPercent(Number.NaN);
		immediatePolicy.observeContextPercent(Number.POSITIVE_INFINITY);
		deferPolicy.observeContextPercent(Number.NaN);
		deferPolicy.observeContextPercent(Number.POSITIVE_INFINITY);

		expect(immediateKills).toBe(0);
		expect(timers.activeTimers()).toHaveLength(0);
	});

	it("clears deferred pending kill when context drops below threshold", () => {
		const timers = new FakeTimers();
		let kills = 0;
		const policy = createContextKillPolicy({
			policy: "defer",
			killPercent: 95,
			onKill: () => {
				kills++;
			},
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
		});

		policy.observeContextPercent(95);
		const debounce = timers.activeTimer();
		policy.observeContextPercent(80);
		expect(timers.activeTimers()).toHaveLength(0);

		timers.fire(debounce.id);
		expect(kills).toBe(0);

		policy.observeContextPercent(96);
		policy.observeAgentEvent({ type: "compaction_started" });
		const grace = timers.activeTimer();
		policy.observeContextPercent(70);
		expect(timers.activeTimers()).toHaveLength(0);

		timers.fire(grace.id);
		expect(kills).toBe(0);
	});

	it("switches from debounce to one grace timer when compaction starts", () => {
		const timers = new FakeTimers();
		let kills = 0;
		const policy = createContextKillPolicy({
			policy: "defer",
			killPercent: 95,
			onKill: () => {
				kills++;
			},
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
		});

		policy.observeContextPercent(95);
		const debounce = timers.activeTimer();

		policy.observeAgentEvent({ type: "compaction_started" });
		const grace = timers.activeTimer();
		expect(grace.id).not.toBe(debounce.id);
		expect(grace.ms).toBe(CONTEXT_KILL_COMPACTION_GRACE_MS);

		policy.observeAgentEvent({ type: "compaction_started" });
		policy.observeContextPercent(97);
		expect(timers.activeTimer().id).toBe(grace.id);

		timers.fire(debounce.id);
		expect(kills).toBe(0);

		timers.fire(grace.id);
		expect(kills).toBe(1);
	});

	it("uses grace immediately when compaction started before high context", () => {
		const timers = new FakeTimers();
		let kills = 0;
		const policy = createContextKillPolicy({
			policy: "defer",
			killPercent: 95,
			onKill: () => {
				kills++;
			},
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
		});

		policy.observeAgentEvent({ type: "compaction_started" });
		policy.observeContextPercent(95);

		const grace = timers.activeTimer();
		expect(grace.ms).toBe(CONTEXT_KILL_COMPACTION_GRACE_MS);

		timers.fire(grace.id);
		expect(kills).toBe(1);
	});

	it("successful compaction finish clears the pending kill", () => {
		const timers = new FakeTimers();
		let kills = 0;
		const policy = createContextKillPolicy({
			policy: "defer",
			killPercent: 95,
			onKill: () => {
				kills++;
			},
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
		});

		policy.observeContextPercent(95);
		policy.observeAgentEvent({ type: "compaction_started" });
		const grace = timers.activeTimer();

		policy.observeAgentEvent({ type: "compaction_finished", payload: { success: true } });
		expect(timers.activeTimers()).toHaveLength(0);

		timers.fire(grace.id);
		expect(kills).toBe(0);
	});

	it("failed, skipped, and aborted compaction finishes kill when high context is pending", () => {
		const cases = [
			{ success: false },
			{ status: "skipped" },
			{ aborted: true },
		];

		for (const payload of cases) {
			const timers = new FakeTimers();
			let kills = 0;
			const policy = createContextKillPolicy({
				policy: "defer",
				killPercent: 95,
				onKill: () => {
					kills++;
				},
				setTimer: timers.setTimer,
				clearTimer: timers.clearTimer,
			});

			policy.observeContextPercent(95);
			policy.observeAgentEvent({ type: "compaction_started" });
			const grace = timers.activeTimer();

			policy.observeAgentEvent({ type: "compaction_finished", payload });
			expect(kills).toBe(1);
			expect(timers.activeTimers()).toHaveLength(0);

			policy.observeAgentEvent({ type: "compaction_finished", payload });
			timers.fire(grace.id);
			expect(kills).toBe(1);
		}
	});

	it("willRetry finishes keep the existing grace timer without resetting it", () => {
		const timers = new FakeTimers();
		let kills = 0;
		const policy = createContextKillPolicy({
			policy: "defer",
			killPercent: 95,
			onKill: () => {
				kills++;
			},
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
		});

		policy.observeContextPercent(95);
		policy.observeAgentEvent({ type: "compaction_started" });
		const grace = timers.activeTimer();

		policy.observeAgentEvent({
			type: "compaction_finished",
			payload: { success: false, status: "failed", willRetry: true },
		});
		expect(kills).toBe(0);
		expect(timers.activeTimer().id).toBe(grace.id);

		policy.observeAgentEvent({ type: "compaction_started" });
		policy.observeContextPercent(98);
		expect(timers.activeTimer().id).toBe(grace.id);

		timers.fire(grace.id);
		expect(kills).toBe(1);
	});

	it("dispose clears timers and makes observations and callbacks no-op", () => {
		const timers = new FakeTimers();
		let kills = 0;
		const policy = createContextKillPolicy({
			policy: "defer",
			killPercent: 95,
			onKill: () => {
				kills++;
			},
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
		});

		policy.observeContextPercent(95);
		const debounce = timers.activeTimer();

		policy.dispose();
		expect(timers.activeTimers()).toHaveLength(0);

		policy.observeAgentEvent({ type: "compaction_started" });
		policy.observeContextPercent(99);
		timers.fire(debounce.id);
		expect(kills).toBe(0);
	});
});
