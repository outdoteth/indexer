import { idb } from "@/common/db";
import { AbstractRabbitMqJobHandler, BackoffStrategy } from "@/jobs/abstract-rabbit-mq-job-handler";

export type RecalcTokenCountQueueJobPayload = {
  collection: string;
  force?: boolean;
};

export class RecalcTokenCountQueueJob extends AbstractRabbitMqJobHandler {
  queueName = "collection-recalc-token-count-queue";
  maxRetries = 10;
  concurrency = 10;
  lazyMode = true;
  backoff = {
    type: "exponential",
    delay: 20000,
  } as BackoffStrategy;

  protected async process(payload: RecalcTokenCountQueueJobPayload) {
    const { collection } = payload;

    const query = `
          UPDATE "collections"
          SET "token_count" = (SELECT COUNT(*) FROM "tokens" WHERE "collection_id" = $/collection/ AND (remaining_supply > 0 OR remaining_supply IS NULL)),
              "updated_at" = now()
          WHERE "id" = $/collection/;
      `;

    await idb.none(query, {
      collection,
    });
  }

  public async addToQueue(collection: RecalcTokenCountQueueJobPayload, delay = 5 * 60 * 1000) {
    await this.send(
      {
        payload: collection,
        jobId: collection.force ? undefined : collection.collection,
      },
      collection.force ? 0 : delay
    );
  }
}

export const recalcTokenCountQueueJob = new RecalcTokenCountQueueJob();
