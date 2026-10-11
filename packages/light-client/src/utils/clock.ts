import {ChainForkConfig} from "@lodestar/config";
import {EPOCHS_PER_SYNC_COMMITTEE_PERIOD, ForkName, SLOTS_PER_EPOCH} from "@lodestar/params";
import {Epoch, Slot, SyncPeriod} from "@lodestar/types";

/**
 * Subset of the fork config the clock needs. `getSlotDurationMs` only exists in Lodestar releases with
 * fork-aware slot timing, older releases have a single slot duration for all forks.
 */
export type SlotClockConfig = Pick<ChainForkConfig, "SLOT_DURATION_MS"> & {
  forksAscendingEpochOrder: {name: ForkName; epoch: Epoch}[];
  getSlotDurationMs?: (fork: ForkName) => number;
};

/** Slot durations with their activation slots, one entry per scheduled fork */
function getSlotDurations(config: SlotClockConfig): [Slot, number][] {
  const durations: [Slot, number][] = [];
  for (const fork of config.forksAscendingEpochOrder) {
    if (fork.epoch === Infinity) continue;
    durations.push([fork.epoch * SLOTS_PER_EPOCH, config.getSlotDurationMs?.(fork.name) ?? config.SLOT_DURATION_MS]);
  }
  return durations;
}

export function computeTimeAtSlotMs(config: SlotClockConfig, slot: Slot, genesisTimeMs: number): number {
  let endSlot = slot;
  let timeMs = genesisTimeMs;
  for (const [forkSlot, slotDurationMs] of getSlotDurations(config).reverse()) {
    if (forkSlot < endSlot) {
      timeMs += (endSlot - forkSlot) * slotDurationMs;
      endSlot = forkSlot;
    }
  }
  // Pre-genesis slots extrapolate linearly so the clock keeps ticking before genesis
  return timeMs + endSlot * config.SLOT_DURATION_MS;
}

export function computeSlotAtTimeMs(config: SlotClockConfig, timeMs: number, genesisTimeMs: number): Slot {
  let startSlot = 0;
  let startTimeMs = genesisTimeMs;
  let slotDurationMs = config.SLOT_DURATION_MS;
  for (const [forkSlot, forkSlotDurationMs] of getSlotDurations(config)) {
    const forkTimeMs = computeTimeAtSlotMs(config, forkSlot, genesisTimeMs);
    if (timeMs >= forkTimeMs) {
      startSlot = forkSlot;
      startTimeMs = forkTimeMs;
      slotDurationMs = forkSlotDurationMs;
    }
  }
  return startSlot + Math.floor((timeMs - startTimeMs) / slotDurationMs);
}

export function getCurrentSlot(config: SlotClockConfig, genesisTime: number): Slot {
  return computeSlotAtTimeMs(config, Date.now(), genesisTime * 1000);
}

/** Returns the slot if the internal clock were advanced by `toleranceSec`. */
export function slotWithFutureTolerance(config: SlotClockConfig, genesisTime: number, toleranceSec: number): Slot {
  // this is the same to getting slot at now + toleranceSec
  return getCurrentSlot(config, genesisTime - toleranceSec);
}

/**
 * Return the epoch number at the given slot.
 */
export function computeEpochAtSlot(slot: Slot): Epoch {
  return Math.floor(slot / SLOTS_PER_EPOCH);
}

/**
 * Return the sync committee period at slot
 */
export function computeSyncPeriodAtSlot(slot: Slot): SyncPeriod {
  return computeSyncPeriodAtEpoch(computeEpochAtSlot(slot));
}

/**
 * Return the sync committee period at epoch
 */
export function computeSyncPeriodAtEpoch(epoch: Epoch): SyncPeriod {
  return Math.floor(epoch / EPOCHS_PER_SYNC_COMMITTEE_PERIOD);
}

export function timeUntilNextEpoch(config: SlotClockConfig, genesisTime: number): number {
  const nextEpochSlot = (computeEpochAtSlot(getCurrentSlot(config, genesisTime)) + 1) * SLOTS_PER_EPOCH;
  return Math.max(0, computeTimeAtSlotMs(config, nextEpochSlot, genesisTime * 1000) - Date.now());
}
