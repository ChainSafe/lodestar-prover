import {ApiClient} from "@lodestar/api/beacon";
import {GenesisData, Lightclient} from "@lodestar/light-client";
import {Bytes32, ExecutionPayload, RootHex, SignedBeaconBlock} from "@lodestar/types";
import {Logger, byteArrayEquals} from "@lodestar/utils";
import {MAX_PAYLOAD_HISTORY} from "../constants.js";
import {bufferToHex, hexToBuffer} from "./conversion.js";

export async function fetchBlock(api: ApiClient, blockId: number | RootHex): Promise<SignedBeaconBlock | undefined> {
  const res = await api.beacon.getBlockV2({blockId});

  if (res.ok) return res.value();
  return;
}

export function getEmbeddedExecutionPayload(block: SignedBeaconBlock): ExecutionPayload | undefined {
  return (block.message.body as {executionPayload?: ExecutionPayload}).executionPayload;
}

export async function fetchExecutionPayload(
  api: ApiClient,
  block: SignedBeaconBlock,
  expectedBeaconBlockRoot?: RootHex
): Promise<ExecutionPayload | undefined> {
  const executionPayload = getEmbeddedExecutionPayload(block);
  if (executionPayload) return executionPayload;

  const response = await api.beacon.getSignedExecutionPayloadEnvelope({
    blockId: expectedBeaconBlockRoot ?? block.message.slot,
  });
  if (!response.ok) return;

  const envelope = response.value().message;
  if (expectedBeaconBlockRoot && bufferToHex(envelope.beaconBlockRoot) !== expectedBeaconBlockRoot) return;
  return envelope.payload;
}

export async function fetchNearestBlock(
  api: ApiClient,
  slot: number,
  direction: "up" | "down" = "down"
): Promise<SignedBeaconBlock> {
  const res = await api.beacon.getBlockV2({blockId: slot});

  if (res.ok) return res.value();

  if (!res.ok && res.status === 404) {
    return fetchNearestBlock(api, direction === "down" ? slot - 1 : slot + 1);
  }

  throw new Error(`Can not fetch nearest block for slot=${slot}`);
}

export async function getUnFinalizedRangeForPayloads(lightClient: Lightclient): Promise<{start: number; end: number}> {
  const headSlot = lightClient.getHead().beacon.slot;
  const finalizeSlot = lightClient.getFinalized().beacon.slot;
  const endSlot = headSlot - MAX_PAYLOAD_HISTORY;

  return {
    start: headSlot,
    end: endSlot < finalizeSlot ? finalizeSlot : endSlot,
  };
}

export async function getExecutionPayloads({
  api,
  startSlot,
  endSlot,
  logger,
}: {
  api: ApiClient;
  startSlot: number;
  endSlot: number;
  logger: Logger;
}): Promise<Map<number, ExecutionPayload>> {
  [startSlot, endSlot] = [Math.min(startSlot, endSlot), Math.max(startSlot, endSlot)];
  if (startSlot === endSlot) {
    logger.debug("Fetching EL payload", {slot: startSlot});
  } else {
    logger.debug("Fetching EL payloads", {startSlot, endSlot});
  }

  const payloads = new Map<number, ExecutionPayload>();

  let slot = endSlot;
  let block = await fetchNearestBlock(api, slot);
  let payload = await fetchExecutionPayload(api, block);
  if (payload) payloads.set(block.message.slot, payload);
  slot = block.message.slot - 1;

  while (slot >= startSlot) {
    const previousBlock = await fetchNearestBlock(api, block.message.slot - 1);
    const previousPayload = await fetchExecutionPayload(api, previousBlock);

    if (payload && previousPayload && byteArrayEquals(payload.parentHash, previousPayload.blockHash)) {
      payloads.set(block.message.slot, payload);
    }

    slot = block.message.slot - 1;
    block = previousBlock;
    payload = previousPayload;
  }

  return payloads;
}

export async function getExecutionPayloadForBlockNumber(
  api: ApiClient,
  startSlot: number,
  blockNumber: number
): Promise<Map<number, ExecutionPayload>> {
  const payloads = new Map<number, ExecutionPayload>();

  let block = await fetchNearestBlock(api, startSlot);
  let payload = await fetchExecutionPayload(api, block);
  if (payload) payloads.set(block.message.slot, payload);

  while (!payload || payload.blockNumber !== blockNumber) {
    block = await fetchNearestBlock(api, block.message.slot - 1);
    payload = await fetchExecutionPayload(api, block);
    if (payload) payloads.set(block.message.slot, payload);
  }

  return payloads;
}

export async function getGenesisData(api: Pick<ApiClient, "beacon">): Promise<GenesisData> {
  const {genesisTime, genesisValidatorsRoot} = (await api.beacon.getGenesis()).value();

  return {
    genesisTime,
    genesisValidatorsRoot,
  };
}

export async function getSyncCheckpoint(api: Pick<ApiClient, "beacon">, checkpoint?: string): Promise<Bytes32> {
  let syncCheckpoint: Bytes32 | undefined = checkpoint ? hexToBuffer(checkpoint) : undefined;

  if (syncCheckpoint && syncCheckpoint.byteLength !== 32) {
    throw Error(`Checkpoint root must be 32 bytes. length=${syncCheckpoint.byteLength}`);
  }

  if (!syncCheckpoint) {
    const res = await api.beacon.getStateFinalityCheckpoints({stateId: "head"});
    syncCheckpoint = res.value().finalized.root;
  }

  return syncCheckpoint;
}
