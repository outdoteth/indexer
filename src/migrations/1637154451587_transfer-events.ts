import { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("transfer_events", {
    token_id: {
      type: "numeric(78, 0)",
      notNull: true,
    },
    amount: {
      type: "numeric(78, 0)",
      notNull: true,
    },
    from: {
      type: "text",
      notNull: true,
    },
    to: {
      type: "text",
      notNull: true,
    },
    address: {
      type: "text",
      notNull: true,
    },
    block: {
      type: "int",
      notNull: true,
    },
    block_hash: {
      type: "text",
      notNull: true,
    },
    tx_hash: {
      type: "text",
      notNull: true,
    },
    tx_index: {
      type: "int",
      notNull: true,
    },
    log_index: {
      type: "int",
      notNull: true,
    },
  });
  pgm.createConstraint("transfer_events", "transfer_events_pk", {
    primaryKey: ["block_hash", "tx_hash", "log_index"],
  });

  pgm.createIndex("transfer_events", ["block"]);
  pgm.createIndex("transfer_events", ["tx_hash", "from"]);
  pgm.createIndex("transfer_events", ["address", "block"]);
  pgm.createIndex("transfer_events", ["address", "token_id", "block"]);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex("transfer_events", ["address", "token_id", "block"]);
  pgm.dropIndex("transfer_events", ["address", "block"]);
  pgm.dropIndex("transfer_events", ["tx_hash", "from"]);
  pgm.dropIndex("transfer_events", ["block"]);

  pgm.dropTable("transfer_events");
}
