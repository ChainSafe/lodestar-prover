import {ApiClient} from "@lodestar/api";
import {ExecutionPayload, LightClientHeader, RootHex} from "@lodestar/types";
import {Logger} from "@lodestar/utils";
import {MAX_PAYLOAD_HISTORY} from "../constants.js";
import {
  fetchBlock,
  fetchExecutionPayload,
  getEmbeddedExecutionPayload,
  getExecutionPayloadForBlockNumber,
} from "../utils/consensus.js";
import {bufferToHex, hexToNumber} from "../utils/conversion.js";
import {OrderedMap} from "./ordered_map.js";

type BlockELRoot = string;
type BlockELRootAndSlot = {
  blockELRoot: BlockELRoot;
  slot: number;
};
type BlockCLRoot = string;

/**
 * The in-memory store for the execution payloads to be used to verify the proofs
 */
export class PayloadStore {
  // We store the block root from execution for finalized blocks
  // As these blocks are finalized, so not to be worried about conflicting roots
  private finalizedRoots = new OrderedMap<BlockELRootAndSlot>();

  // Unfinalized blocks may change over time and may have conflicting roots
  // We can receive multiple light-client headers for the same block of execution
  // So we why store unfinalized payloads by their CL root, which is only used
  // in processing the light-client headers
  private unfinalizedRoots = new Map<BlockCLRoot, BlockELRoot>();

  // Payloads store with BlockELRoot as key
  private payloads = new Map<BlockELRoot, ExecutionPayload>();

  private latestBlockRoot: BlockELRoot | null = null;

  constructor(private opts: {api: ApiClient; logger: Logger}) {}

  get finalized(): ExecutionPayload | undefined {
    const maxBlockNumberForFinalized = this.finalizedRoots.max;

    if (maxBlockNumberForFinalized === undefined) {
      return undefined;
    }

    const finalizedMaxRoot = this.finalizedRoots.get(maxBlockNumberForFinalized);
    if (finalizedMaxRoot) {
      return this.payloads.get(finalizedMaxRoot.blockELRoot);
    }

    return undefined;
  }

  get latest(): ExecutionPayload | undefined {
    if (this.latestBlockRoot) {
      return this.payloads.get(this.latestBlockRoot);
    }

    return undefined;
  }

  async get(blockId: number | string): Promise<ExecutionPayload | undefined> {
    // Given block id is a block hash in hex (32 bytes root takes 64 hex chars + 2 for 0x prefix)
    if (typeof blockId === "string" && blockId.startsWith("0x") && blockId.length === 64 + 2) {
      return this.payloads.get(blockId);
    }

    // Given block id is a block number in hex
    if (typeof blockId === "string" && blockId.startsWith("0x")) {
      return this.getOrFetchFinalizedPayload(hexToNumber(blockId));
    }

    // Given block id is a block number in decimal string
    if (typeof blockId === "string" && !blockId.startsWith("0x")) {
      return this.getOrFetchFinalizedPayload(parseInt(blockId, 10));
    }

    // Given block id is a block number in decimal
    if (typeof blockId === "number") {
      return this.getOrFetchFinalizedPayload(blockId);
    }

    return undefined;
  }

  protected async getOrFetchFinalizedPayload(blockNumber: number): Promise<ExecutionPayload | undefined> {
    const maxBlockNumberForFinalized = this.finalizedRoots.max;
    const minBlockNumberForFinalized = this.finalizedRoots.min;

    if (maxBlockNumberForFinalized === undefined || minBlockNumberForFinalized === undefined) {
      return;
    }

    if (blockNumber > maxBlockNumberForFinalized) {
      throw new Error(
        `Block number ${blockNumber} is higher than the latest finalized block number. We recommend to use block hash for unfinalized blocks.`
      );
    }

    let blockELRoot = this.finalizedRoots.get(blockNumber);
    // check if we have payload cached locally else fetch from api
    if (!blockELRoot) {
      const finalizedMaxRoot = this.finalizedRoots.get(maxBlockNumberForFinalized);
      const slot = finalizedMaxRoot?.slot;
      if (slot !== undefined) {
        const payloads = await getExecutionPayloadForBlockNumber(this.opts.api, slot, blockNumber);
        for (const [slot, payload] of payloads.entries()) {
          this.set(payload, slot, true);
        }
      }
    }

    blockELRoot = this.finalizedRoots.get(blockNumber);
    if (blockELRoot) {
      return this.payloads.get(blockELRoot.blockELRoot);
    }

    return undefined;
  }

  set(payload: ExecutionPayload, slot: number, finalized: boolean): void {
    const blockELRoot = bufferToHex(payload.blockHash);
    this.payloads.set(blockELRoot, payload);

    if (this.latestBlockRoot) {
      const latestPayload = this.payloads.get(this.latestBlockRoot);
      if (
        !latestPayload ||
        latestPayload.blockNumber < payload.blockNumber ||
        (latestPayload.blockNumber === payload.blockNumber && this.latestBlockRoot !== blockELRoot)
      ) {
        this.latestBlockRoot = blockELRoot;
      }
    } else {
      this.latestBlockRoot = blockELRoot;
    }

    if (finalized) {
      this.finalizedRoots.set(payload.blockNumber, {blockELRoot, slot});
    }
  }

  /**
   * Cache the execution payload referenced by a verified light-client header.
   *
   * Assumes the caller:
   *   - verified the light-client signatures and Merkle branches.
   *   - checked that the header has the correct execution data.
   *   - (If `finalized` is true) verified consensus finality for the header.
   */
  async processLCHeader(header: LightClientHeader, finalized = false): Promise<void> {
    const executionBlockHash = this.getExecutionBlockHash(header);
    if (!executionBlockHash) return;

    const blockSlot = header.beacon.slot;
    const blockELRoot = bufferToHex(executionBlockHash);
    const blockCLRoot = bufferToHex(header.beacon.stateRoot);
    const existingELRoot = this.unfinalizedRoots.get(blockCLRoot);
    const existingPayload = existingELRoot ? this.payloads.get(existingELRoot) : undefined;

    if (existingELRoot === blockELRoot && existingPayload) {
      if (finalized) {
        this.set(existingPayload, blockSlot, true);
        this.unfinalizedRoots.delete(blockCLRoot);
      }
      return;
    }

    if (existingELRoot && existingELRoot !== blockELRoot) {
      this.payloads.delete(existingELRoot);
      this.unfinalizedRoots.delete(blockCLRoot);
    }

    const payload = await this.fetchExecutionPayloadForLightClientHeader(header);
    if (!payload) {
      this.opts.logger.error("Failed to fetch execution payload", {slot: blockSlot});
      return;
    }

    if (bufferToHex(payload.blockHash) !== blockELRoot) {
      throw new Error("Execution payload does not match light-client header execution block hash");
    }

    if ("execution" in header && payload.blockNumber !== header.execution.blockNumber) {
      throw new Error(
        `Execution payload block number ${payload.blockNumber} does not match light-client header block number ${header.execution.blockNumber}`
      );
    }

    this.set(payload, blockSlot, finalized);
    if (finalized) {
      this.unfinalizedRoots.delete(blockCLRoot);
    } else {
      this.unfinalizedRoots.set(blockCLRoot, blockELRoot);
    }
    this.prune();
  }

  /**
   * Gets the execution block hash, if present.
   *
   * Returns `executionBlockHash` for Gloas-shaped headers, including upgraded headers. Returns
   * `execution.blockHash` for original Capella-through-Fulu headers. Returns undefined for pre-Capella headers.
   */
  private getExecutionBlockHash(header: LightClientHeader): Uint8Array | undefined {
    if ("executionBlockHash" in header) return header.executionBlockHash;
    if ("execution" in header) return header.execution.blockHash;
    return undefined;
  }

  private async fetchExecutionPayloadForLightClientHeader(
    header: LightClientHeader
  ): Promise<ExecutionPayload | undefined> {
    if (!("executionBlockHash" in header)) {
      if (!("execution" in header)) return;

      const block = await fetchBlock(this.opts.api, header.beacon.slot);
      if (!block) return;

      return fetchExecutionPayload(this.opts.api, block);
    }

    const expectedBlockHash = bufferToHex(header.executionBlockHash);

    // A pre-Gloas header can be upgraded to the Gloas shape. Its payload remains embedded in its own block.
    const headerBlock = await fetchBlock(this.opts.api, header.beacon.slot);
    const headerBlockPayload = headerBlock ? getEmbeddedExecutionPayload(headerBlock) : undefined;
    if (headerBlockPayload) {
      if (bufferToHex(headerBlockPayload.blockHash) !== expectedBlockHash) {
        throw new Error("Execution payload does not match light-client header execution block hash");
      }
      return headerBlockPayload;
    }

    let beaconBlockRoot = bufferToHex(header.beacon.parentRoot) as RootHex;
    const visitedRoots = new Set<RootHex>();

    while (!visitedRoots.has(beaconBlockRoot)) {
      visitedRoots.add(beaconBlockRoot);

      const response = await this.opts.api.beacon.getSignedExecutionPayloadEnvelope({blockId: beaconBlockRoot});
      if (response.ok) {
        const envelope = response.value().message;
        if (bufferToHex(envelope.beaconBlockRoot) !== beaconBlockRoot) {
          throw new Error("Execution payload envelope does not match requested beacon block root");
        }
        if (bufferToHex(envelope.payload.blockHash) !== expectedBlockHash) {
          throw new Error("Execution payload does not match light-client header execution block hash");
        }
        return envelope.payload;
      }

      if (response.status !== 404) return;

      const block = await fetchBlock(this.opts.api, beaconBlockRoot);
      if (!block) return;

      // The first Gloas block can reference a payload embedded in its pre-Gloas parent block.
      const embeddedPayload = getEmbeddedExecutionPayload(block);
      if (embeddedPayload) {
        if (bufferToHex(embeddedPayload.blockHash) !== expectedBlockHash) {
          throw new Error("Execution payload does not match light-client header execution block hash");
        }
        return embeddedPayload;
      }

      beaconBlockRoot = bufferToHex(block.message.parentRoot) as RootHex;
      if (/^0x0+$/.test(beaconBlockRoot)) return;
    }

    return;
  }

  prune(): void {
    if (this.finalizedRoots.size <= MAX_PAYLOAD_HISTORY) return;
    // Store doe not have any finalized blocks means it's recently initialized
    if (this.finalizedRoots.max === undefined || this.finalizedRoots.min === undefined) return;

    for (
      let blockNumber = this.finalizedRoots.max - MAX_PAYLOAD_HISTORY;
      blockNumber >= this.finalizedRoots.min;
      blockNumber--
    ) {
      const blockELRoot = this.finalizedRoots.get(blockNumber);
      if (blockELRoot) {
        this.payloads.delete(blockELRoot.blockELRoot);
        this.finalizedRoots.delete(blockNumber);
      }
    }

    for (const [clRoot, elRoot] of this.unfinalizedRoots) {
      const payload = this.payloads.get(elRoot);
      if (!payload) {
        this.unfinalizedRoots.delete(clRoot);
        continue;
      }

      if (payload.blockNumber < this.finalizedRoots.min) {
        this.unfinalizedRoots.delete(clRoot);
      }
    }
  }
}
