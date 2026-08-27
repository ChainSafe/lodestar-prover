import {describe, expect, it, vi} from "vitest";
import {ApiClient} from "@lodestar/api/beacon";
import {createChainForkConfig} from "@lodestar/config";
import {LightClientRestTransport} from "@lodestar/light-client/transport";
import {ssz} from "@lodestar/types";
import {Logger} from "@lodestar/utils";
import {ProofProvider} from "../../../src/proof_provider/proof_provider.js";

describe("proof_provider/proof_provider", () => {
  it("accepts a pre-Gloas slot carried in an upgraded Gloas header", async () => {
    const config = createChainForkConfig({
      ALTAIR_FORK_EPOCH: 0,
      BELLATRIX_FORK_EPOCH: 1,
      CAPELLA_FORK_EPOCH: 2,
      DENEB_FORK_EPOCH: 3,
      ELECTRA_FORK_EPOCH: 4,
      FULU_FORK_EPOCH: 4,
      GLOAS_FORK_EPOCH: 5,
    });
    const provider = new ProofProvider({
      api: {} as ApiClient,
      config,
      logger: console as unknown as Logger,
      signal: new AbortController().signal,
      transport: {} as LightClientRestTransport,
    });
    const processStoreHeader = vi.spyOn(provider["store"], "processLCHeader").mockResolvedValue();
    const header = ssz.gloas.LightClientHeader.defaultValue();
    header.beacon.slot = 4 * 32;
    header.executionBlockHash[0] = 1;

    await provider.processLCHeader(header, true);

    expect(processStoreHeader).toHaveBeenCalledWith(header, true);
  });
});
