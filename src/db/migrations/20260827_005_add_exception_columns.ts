import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE washes ADD COLUMN disputed_at TIMESTAMPTZ`);
  await knex.raw(`ALTER TABLE washes ADD COLUMN dispute_reason TEXT`);
  await knex.raw(`ALTER TABLE washes ADD COLUMN resolved_at TIMESTAMPTZ`);
  await knex.raw(`ALTER TABLE washes ADD COLUMN resolved_by UUID REFERENCES staff_users(id)`);
  await knex.raw(`ALTER TABLE washes ADD COLUMN corrected_at TIMESTAMPTZ`);
  await knex.raw(`ALTER TABLE washes ADD COLUMN corrected_by UUID REFERENCES staff_users(id)`);
  await knex.raw(`ALTER TABLE washes ADD COLUMN original_amount_ugx BIGINT`);
  await knex.raw(`ALTER TABLE washes ADD COLUMN original_vehicle_class_id UUID REFERENCES vehicle_classes(id)`);
  await knex.raw(`ALTER TABLE washes ADD COLUMN reversed_at TIMESTAMPTZ`);
  await knex.raw(`ALTER TABLE washes ADD COLUMN reversed_by UUID REFERENCES staff_users(id)`);
  await knex.raw(`ALTER TABLE washes ADD COLUMN reverse_reason TEXT`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE washes DROP COLUMN IF EXISTS reverse_reason`);
  await knex.raw(`ALTER TABLE washes DROP COLUMN IF EXISTS reversed_by`);
  await knex.raw(`ALTER TABLE washes DROP COLUMN IF EXISTS reversed_at`);
  await knex.raw(`ALTER TABLE washes DROP COLUMN IF EXISTS original_vehicle_class_id`);
  await knex.raw(`ALTER TABLE washes DROP COLUMN IF EXISTS original_amount_ugx`);
  await knex.raw(`ALTER TABLE washes DROP COLUMN IF EXISTS corrected_by`);
  await knex.raw(`ALTER TABLE washes DROP COLUMN IF EXISTS corrected_at`);
  await knex.raw(`ALTER TABLE washes DROP COLUMN IF EXISTS resolved_by`);
  await knex.raw(`ALTER TABLE washes DROP COLUMN IF EXISTS resolved_at`);
  await knex.raw(`ALTER TABLE washes DROP COLUMN IF EXISTS dispute_reason`);
  await knex.raw(`ALTER TABLE washes DROP COLUMN IF EXISTS disputed_at`);
}
