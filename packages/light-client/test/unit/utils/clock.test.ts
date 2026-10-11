import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {ForkName, SLOTS_PER_EPOCH} from "@lodestar/params";
import {
  SlotClockConfig,
  computeSlotAtTimeMs,
  computeTimeAtSlotMs,
  getCurrentSlot,
  timeUntilNextEpoch,
} from "../../../src/utils/clock.js";

describe("utils / clock", () => {
  const genesisTime = 1_600_000_000;
  const genesisTimeMs = genesisTime * 1000;
  const boundarySlot = SLOTS_PER_EPOCH;
  const boundaryTimeMs = genesisTimeMs + boundarySlot * 12000;

  const singleEra: SlotClockConfig = {
    SLOT_DURATION_MS: 12000,
    forksAscendingEpochOrder: [{name: ForkName.phase0, epoch: 0}],
  };

  // slot duration changes from 12s to 10s at the start of epoch 1
  const twoEras: SlotClockConfig = {
    SLOT_DURATION_MS: 12000,
    forksAscendingEpochOrder: [
      {name: ForkName.phase0, epoch: 0},
      {name: ForkName.gloas, epoch: 1},
    ],
    getSlotDurationMs: (fork) => (fork === ForkName.gloas ? 10000 : 12000),
  };

  it("computes slot times linearly with a single slot duration", () => {
    expect(computeTimeAtSlotMs(singleEra, 0, genesisTimeMs)).toBe(genesisTimeMs);
    expect(computeTimeAtSlotMs(singleEra, 5, genesisTimeMs)).toBe(genesisTimeMs + 60000);
    expect(computeTimeAtSlotMs(singleEra, -1, genesisTimeMs)).toBe(genesisTimeMs - 12000);
    expect(computeSlotAtTimeMs(singleEra, genesisTimeMs + 60000, genesisTimeMs)).toBe(5);
    expect(computeSlotAtTimeMs(singleEra, genesisTimeMs - 1, genesisTimeMs)).toBe(-1);
  });

  it("computes slot times piecewise across a slot duration change", () => {
    expect(computeTimeAtSlotMs(twoEras, boundarySlot - 1, genesisTimeMs)).toBe(boundaryTimeMs - 12000);
    expect(computeTimeAtSlotMs(twoEras, boundarySlot, genesisTimeMs)).toBe(boundaryTimeMs);
    expect(computeTimeAtSlotMs(twoEras, boundarySlot + 1, genesisTimeMs)).toBe(boundaryTimeMs + 10000);
    expect(computeSlotAtTimeMs(twoEras, boundaryTimeMs - 1, genesisTimeMs)).toBe(boundarySlot - 1);
    expect(computeSlotAtTimeMs(twoEras, boundaryTimeMs, genesisTimeMs)).toBe(boundarySlot);
    expect(computeSlotAtTimeMs(twoEras, boundaryTimeMs + 9999, genesisTimeMs)).toBe(boundarySlot);
    expect(computeSlotAtTimeMs(twoEras, boundaryTimeMs + 10000, genesisTimeMs)).toBe(boundarySlot + 1);
  });

  describe("wall clock", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("tracks the current slot after the duration change", () => {
      vi.setSystemTime(boundaryTimeMs + 3 * 10000 + 500);
      expect(getCurrentSlot(twoEras, genesisTime)).toBe(boundarySlot + 3);
    });

    it("waits for the next epoch using the duration of the upcoming slots", () => {
      // 2 seconds into the last pre-boundary slot, the next epoch starts at the boundary
      vi.setSystemTime(boundaryTimeMs - 12000 + 2000);
      expect(timeUntilNextEpoch(twoEras, genesisTime)).toBe(10000);
      // 3 slots into epoch 1, the remaining 5 slots are 10s each
      vi.setSystemTime(boundaryTimeMs + 3 * 10000);
      expect(timeUntilNextEpoch(twoEras, genesisTime)).toBe((SLOTS_PER_EPOCH - 3) * 10000);
    });

    it("waits for genesis before genesis", () => {
      vi.setSystemTime(genesisTimeMs - 5000);
      expect(timeUntilNextEpoch(twoEras, genesisTime)).toBe(5000);
    });
  });
});
