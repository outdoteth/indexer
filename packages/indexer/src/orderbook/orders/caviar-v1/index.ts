import { logger } from "@/common/logger";
import {
  DbOrder,
  OrderMetadata,
  POOL_ORDERS_MAX_PRICE_POINTS_COUNT,
  generateSchemaHash,
} from "@/orderbook/orders/utils";
import { keccak256 } from "@ethersproject/solidity";
import { config } from "@/config/index";
import * as caviarV1 from "@/utils/caviar-v1";
import * as Sdk from "@reservoir0x/sdk";
import { baseProvider } from "@/common/provider";
import { Interface, parseEther } from "ethers/lib/utils";
import { BigNumber, Contract, constants } from "ethers";
import _ from "lodash";
import { idb, pgp, redb } from "@/common/db";
import * as tokenSet from "@/orderbook/token-sets";
import { Sources } from "@/models/sources";
import { bn, toBuffer } from "@/common/utils";
import * as royalties from "@/utils/royalties";
import * as commonHelpers from "@/orderbook/orders/common/helpers";
import * as ordersUpdateById from "@/jobs/order-updates/by-id-queue";

export const getOrderId = (pool: string, side: "sell" | "buy", tokenId?: string) =>
  side === "buy"
    ? // Buy orders have a single order id per pool
      keccak256(["string", "address", "string"], ["caviar-v1", pool, side])
    : // Sell orders have multiple order ids per pool (one for each potential token id)
      keccak256(["string", "address", "string", "uint256"], ["caviar-v1", pool, side, tokenId]);

export type OrderInfo = {
  orderParams: {
    pool: string;
    // Validation parameters (for ensuring only the latest event is relevant)
    txHash: string;
    txTimestamp: number;
    txBlock: number;
    logIndex: number;
    // Misc options
    forceRecheck?: boolean;
  };
  metadata: OrderMetadata;
};

type SaveResult = {
  id: string;
  txHash: string;
  txTimestamp: number;
  status: string;
  triggerKind?: "new-order" | "reprice";
};

export const save = async (orderInfos: OrderInfo[]): Promise<SaveResult[]> => {
  const results: SaveResult[] = [];
  const orderValues: DbOrder[] = [];

  const handleOrder = async ({ orderParams }: OrderInfo) => {
    try {
      const pool = await caviarV1.getPoolDetails(orderParams.pool);

      if (!pool) {
        throw new Error("Could not fetch pool details");
      }

      if (pool.baseToken !== Sdk.Common.Addresses.Eth[config.chainId]) {
        throw new Error("Unsupported currency");
      }

      if (pool.merkleRoot !== constants.HashZero) {
        throw new Error("Non-floor pools not supported");
      }

      const poolContract = new Contract(
        pool.address,
        new Interface([
          "function buyQuote(uint256 outputAmount) view returns (uint256)",
          "function sellQuote(uint256 inputAmount) view returns (uint256)",
        ]),
        baseProvider
      );

      // get the list of prices at which the pool will buy and sell at
      const buyPrices: BigNumber[] = await Promise.all(
        _.range(0, POOL_ORDERS_MAX_PRICE_POINTS_COUNT).map(async (index) => {
          try {
            const buyPrice = (await poolContract.sellQuote(parseEther((index + 1).toString()))).sub(
              await poolContract.sellQuote(parseEther(index.toString()))
            );

            return buyPrice;
          } catch {
            return bn(0);
          }
        })
      ).then((prices) => prices.filter((p) => p.gt(0)));

      ///// buy order logic
      // get the id

      try {
        const buyId = getOrderId(orderParams.pool, "buy");
        if (buyPrices.length) {
          const price = buyPrices[0].toString();
          const value = buyPrices[0].toString();

          // Handle: core sdk order
          const sdkOrder: Sdk.CaviarV1.Order = new Sdk.CaviarV1.Order(config.chainId, {
            pool: orderParams.pool,
            extra: {
              prices: buyPrices.map(String),
            },
          });

          // Handle: royalties on top
          const defaultRoyalties = await royalties.getRoyaltiesByTokenSet(
            `contract:${pool.nft}`.toLowerCase(),
            "default"
          );

          // calculate the missing royalties
          const missingRoyalties = [];
          let missingRoyaltyAmount = bn(0);
          const totalDefaultBps = defaultRoyalties.map(({ bps }) => bps).reduce((a, b) => a + b, 0);
          const validRecipients = defaultRoyalties.filter(
            ({ bps, recipient }) => bps && recipient !== constants.AddressZero
          );

          // Split the missing royalties pro-rata across all royalty recipients
          const totalBps = _.sumBy(validRecipients, ({ bps }) => bps);

          if (validRecipients.length) {
            const amount = bn(price).mul(totalDefaultBps).div(10000);
            missingRoyaltyAmount = missingRoyaltyAmount.add(amount);

            for (const { bps, recipient } of validRecipients) {
              // TODO: Handle lost precision (by paying it to the last or first recipient)
              missingRoyalties.push({
                bps: Math.floor((totalDefaultBps * bps) / totalBps),
                amount: amount.mul(bps).div(totalBps).toString(),
                recipient,
              });
            }
          }

          const normalizedValue = bn(value).sub(missingRoyaltyAmount);

          let orderResult = await idb.oneOrNone(
            `
                  SELECT
                    orders.token_set_id
                  FROM orders
                  WHERE orders.id = $/id/
                `,
            { id: buyId }
          );

          if (orderResult && !orderResult.token_set_id) {
            // Delete the order since it is an incomplete one resulted from 'partial' insertion of
            // fill events. The issue only occurs for buy orders since sell orders are handled via
            // 'on-chain' fill events which don't insert such incomplete orders.
            await idb.none(`DELETE FROM orders WHERE orders.id = $/id/`, { id: buyId });
            orderResult = false;
          }

          // insert a new buy order
          if (!orderResult) {
            // get the set of token ids that the buy order can purchase
            const schemaHash = generateSchemaHash();
            const [{ id: tokenSetId }] = await tokenSet.contractWide.save([
              {
                id: `contract:${pool.nft}`.toLowerCase(),
                schemaHash,
                contract: pool.nft,
              },
            ]);

            if (!tokenSetId) {
              throw new Error("No token set available");
            }

            // Handle: source
            const sources = await Sources.getInstance();
            const source = await sources.getOrInsert("caviar.sh");

            const validFrom = `date_trunc('seconds', to_timestamp(${orderParams.txTimestamp}))`;
            const validTo = `'Infinity'`;
            orderValues.push({
              id: buyId,
              kind: "caviar-v1",
              side: "buy",
              fillability_status: "fillable",
              approval_status: "approved",
              token_set_id: tokenSetId,
              token_set_schema_hash: toBuffer(schemaHash),
              maker: toBuffer(pool.address),
              taker: toBuffer(constants.AddressZero),
              price,
              value,
              currency: toBuffer(pool.baseToken),
              currency_price: price,
              currency_value: value,
              needs_conversion: null,
              quantity_remaining: buyPrices.length.toString(),
              valid_between: `tstzrange(${validFrom}, ${validTo}, '[]')`,
              nonce: null,
              source_id_int: source?.id,
              is_reservoir: null,
              contract: toBuffer(pool.nft),
              conduit: null,
              fee_bps: 0, // no fees on caviar
              fee_breakdown: [], // no fees on caviar
              dynamic: null,
              raw_data: sdkOrder.params,
              expiration: validTo,
              missing_royalties: missingRoyalties,
              normalized_value: normalizedValue.toString(),
              currency_normalized_value: normalizedValue.toString(),
              block_number: orderParams.txBlock ?? null,
              log_index: orderParams.logIndex ?? null,
            });

            results.push({
              id: buyId,
              txHash: orderParams.txHash,
              txTimestamp: orderParams.txTimestamp,
              status: "success",
              triggerKind: "new-order",
            });
          } else {
            await idb.none(
              `
                    UPDATE orders SET
                      fillability_status = 'fillable',
                      approval_status = 'approved',
                      price = $/price/,
                      currency_price = $/price/,
                      value = $/value/,
                      currency_value = $/value/,
                      quantity_remaining = $/quantityRemaining/,
                      valid_between = tstzrange(date_trunc('seconds', to_timestamp(${orderParams.txTimestamp})), 'Infinity', '[]'),
                      expiration = 'Infinity',
                      updated_at = now(),
                      raw_data = $/rawData:json/,
                      missing_royalties = $/missingRoyalties:json/,
                      normalized_value = $/normalizedValue/,
                      currency_normalized_value = $/currencyNormalizedValue/,
                      fee_bps = $/feeBps/,
                      fee_breakdown = $/feeBreakdown:json/,
                      block_number = $/blockNumber/,
                      log_index = $/logIndex/
                    WHERE orders.id = $/id/
                  `,
              {
                id: buyId,
                price,
                value,
                rawData: sdkOrder.params,
                quantityRemaining: buyPrices.length.toString(),
                missingRoyalties: missingRoyalties,
                normalizedValue: value.toString(),
                currencyNormalizedValue: value.toString(),
                feeBps: 0,
                feeBreakdown: [],
                blockNumber: orderParams.txBlock,
                logIndex: orderParams.logIndex,
              }
            );

            results.push({
              id: buyId,
              txHash: orderParams.txHash,
              txTimestamp: orderParams.txTimestamp,
              status: "success",
              triggerKind: "reprice",
            });
          }
        } else {
          await idb.none(
            `
                    UPDATE orders SET
                      fillability_status = 'no-balance',
                      expiration = to_timestamp(${orderParams.txTimestamp}),
                      updated_at = now()
                    WHERE orders.id = $/id/
                  `,
            { id: buyId }
          );

          results.push({
            id: buyId,
            txHash: orderParams.txHash,
            txTimestamp: orderParams.txTimestamp,
            status: "success",
            triggerKind: "reprice",
          });
        }
      } catch (error) {
        logger.error(
          "orders-caviar-v1-save",
          `Failed to handle buy order with params ${JSON.stringify(orderParams)}: ${error}`
        );
      }

      ///// sell order logic
      try {
        // get the list of prices at which the pool will sell at
        const sellPrices: BigNumber[] = await Promise.all(
          _.range(0, POOL_ORDERS_MAX_PRICE_POINTS_COUNT).map(async (index) => {
            try {
              const sellPrice = (
                await poolContract.buyQuote(parseEther((index + 1).toString()))
              ).sub(await poolContract.buyQuote(parseEther(index.toString())));

              return sellPrice;
            } catch {
              return bn(0);
            }
          })
        ).then((prices) => prices.filter((p) => p.gt(0)));

        if (sellPrices.length) {
          const price = sellPrices[0].toString();
          const value = sellPrices[0].toString();

          // Fetch all token ids owned by the pool
          const poolOwnedTokenIds = await commonHelpers.getNfts(pool.nft, pool.address);

          await Promise.all(
            poolOwnedTokenIds.map(async ({ tokenId }) => {
              try {
                const id = getOrderId(orderParams.pool, "sell", tokenId);

                // calculate royalties
                const defaultRoyalties = await royalties.getRoyaltiesByTokenSet(
                  `token:${pool.nft}:${tokenId}`.toLowerCase(),
                  "default"
                );

                const totalDefaultBps = defaultRoyalties
                  .map(({ bps }) => bps)
                  .reduce((a, b) => a + b, 0);
                const missingRoyalties: { bps: number; amount: string; recipient: string }[] = [];
                let missingRoyaltyAmount = bn(0);
                const validRecipients = defaultRoyalties.filter(
                  ({ bps, recipient }) => bps && recipient !== constants.AddressZero
                );
                if (validRecipients.length) {
                  const amount = bn(price).mul(totalDefaultBps).div(10000);
                  missingRoyaltyAmount = missingRoyaltyAmount.add(amount);

                  // Split the missing royalties pro-rata across all royalty recipients
                  const totalBps = _.sumBy(validRecipients, ({ bps }) => bps);
                  for (const { bps, recipient } of validRecipients) {
                    // TODO: Handle lost precision (by paying it to the last or first recipient)
                    missingRoyalties.push({
                      bps: Math.floor((totalDefaultBps * bps) / totalBps),
                      amount: amount.mul(bps).div(totalBps).toString(),
                      recipient,
                    });
                  }
                }

                const normalizedValue = bn(value).add(missingRoyaltyAmount);

                // Handle: core sdk order
                const sdkOrder: Sdk.CaviarV1.Order = new Sdk.CaviarV1.Order(config.chainId, {
                  pool: orderParams.pool,
                  tokenId,
                  extra: {
                    prices: sellPrices.map(String),
                  },
                });

                const orderResult = await redb.oneOrNone(
                  `
                        SELECT 1 FROM orders
                        WHERE orders.id = $/id/
                      `,
                  { id }
                );

                // insert the order if it's not found
                if (!orderResult) {
                  // Handle: token set
                  const schemaHash = generateSchemaHash();
                  const [{ id: tokenSetId }] = await tokenSet.singleToken.save([
                    {
                      id: `token:${pool.nft}:${tokenId}`.toLowerCase(),
                      schemaHash,
                      contract: pool.nft,
                      tokenId,
                    },
                  ]);

                  if (!tokenSetId) {
                    throw new Error("No token set available");
                  }

                  // Handle: source
                  const sources = await Sources.getInstance();
                  const source = await sources.getOrInsert("caviar.sh");

                  const validFrom = `date_trunc('seconds', to_timestamp(${orderParams.txTimestamp}))`;
                  const validTo = `'Infinity'`;
                  orderValues.push({
                    id,
                    kind: "caviar-v1",
                    side: "sell",
                    fillability_status: "fillable",
                    approval_status: "approved",
                    token_set_id: tokenSetId,
                    token_set_schema_hash: toBuffer(schemaHash),
                    maker: toBuffer(pool.address),
                    taker: toBuffer(constants.AddressZero),
                    price,
                    value,
                    currency: toBuffer(pool.nft),
                    currency_price: price,
                    currency_value: value,
                    needs_conversion: null,
                    quantity_remaining: "1",
                    valid_between: `tstzrange(${validFrom}, ${validTo}, '[]')`,
                    nonce: null,
                    source_id_int: source?.id,
                    is_reservoir: null,
                    contract: toBuffer(pool.nft),
                    conduit: null,
                    fee_bps: 0, // no fees on caviar
                    fee_breakdown: [], // no fees on caviar
                    dynamic: null,
                    raw_data: sdkOrder.params,
                    expiration: validTo,
                    missing_royalties: missingRoyalties,
                    normalized_value: normalizedValue.toString(),
                    currency_normalized_value: normalizedValue.toString(),
                    block_number: orderParams.txBlock ?? null,
                    log_index: orderParams.logIndex ?? null,
                  });

                  results.push({
                    id,
                    txHash: orderParams.txHash,
                    txTimestamp: orderParams.txTimestamp,
                    status: "success",
                    triggerKind: "new-order",
                  });
                } else {
                  await idb.none(
                    `
                            UPDATE orders SET
                              fillability_status = 'fillable',
                              approval_status = 'approved',
                              price = $/price/,
                              currency_price = $/price/,
                              value = $/value/,
                              currency_value = $/value/,
                              quantity_remaining = $/amount/,
                              valid_between = tstzrange(date_trunc('seconds', to_timestamp(${orderParams.txTimestamp})), 'Infinity', '[]'),
                              expiration = 'Infinity',
                              updated_at = now(),
                              raw_data = $/rawData:json/,
                              missing_royalties = $/missingRoyalties:json/,
                              normalized_value = $/normalizedValue/,
                              currency_normalized_value = $/currencyNormalizedValue/,
                              fee_bps = $/feeBps/,
                              fee_breakdown = $/feeBreakdown:json/,
                              block_number = $/blockNumber/,
                              log_index = $/logIndex/
                            WHERE orders.id = $/id/
                          `,
                    {
                      id,
                      price,
                      value,
                      amount: "1",
                      rawData: sdkOrder.params,
                      missingRoyalties: missingRoyalties,
                      normalizedValue: normalizedValue.toString(),
                      currencyNormalizedValue: normalizedValue.toString(),
                      feeBps: 0, // no fees on caviar
                      feeBreakdown: [], // no fees on caviar
                      blockNumber: orderParams.txBlock,
                      logIndex: orderParams.logIndex,
                    }
                  );

                  results.push({
                    id,
                    txHash: orderParams.txHash,
                    txTimestamp: orderParams.txTimestamp,
                    status: "success",
                    triggerKind: "reprice",
                  });
                }
              } catch {
                // ignore errors
              }
            })
          );
        }
      } catch (error) {
        logger.error(
          "orders-caviar-v1-save",
          `Failed to handle sell order with params ${JSON.stringify(orderParams)}: ${error}`
        );
      }
    } catch (error) {
      logger.error(
        "orders-caviar-v1-save",
        `Failed to handle order with params ${JSON.stringify(orderParams)}: ${error}`
      );
    }
  };

  await Promise.all(orderInfos.map((orderInfo) => handleOrder(orderInfo)));

  if (orderValues.length) {
    const columns = new pgp.helpers.ColumnSet(
      [
        "id",
        "kind",
        "side",
        "fillability_status",
        "approval_status",
        "token_set_id",
        "token_set_schema_hash",
        "maker",
        "taker",
        "price",
        "value",
        "currency",
        "currency_price",
        "currency_value",
        "needs_conversion",
        "quantity_remaining",
        { name: "valid_between", mod: ":raw" },
        "nonce",
        "source_id_int",
        "is_reservoir",
        "contract",
        "fee_bps",
        { name: "fee_breakdown", mod: ":json" },
        "dynamic",
        "raw_data",
        { name: "expiration", mod: ":raw" },
        { name: "missing_royalties", mod: ":json" },
        "normalized_value",
        "currency_normalized_value",
        "block_number",
        "log_index",
      ],
      {
        table: "orders",
      }
    );

    await idb.none(pgp.helpers.insert(orderValues, columns) + " ON CONFLICT DO NOTHING");
  }

  await ordersUpdateById.addToQueue(
    results
      .filter(({ status }) => status === "success")
      .map(
        ({ id, txHash, txTimestamp, triggerKind }) =>
          ({
            context: `${triggerKind}-${id}-${txHash}`,
            id,
            trigger: {
              kind: triggerKind,
              txHash: txHash,
              txTimestamp: txTimestamp,
            },
          } as ordersUpdateById.OrderInfo)
      )
  );

  logger.info("caviar-v1-save", "processed save orders");
  return results;
};
