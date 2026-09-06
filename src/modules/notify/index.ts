/**
 * Notification module — sends Expo push notifications.
 * Rule: notification failure must NEVER fail the triggering operation.
 * Send after commit, swallow-and-log every error.
 */

import { getPool } from '@/db';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_BATCH_SIZE = 100;

interface PushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, any>;
  sound?: string;
}

/**
 * Send push notifications via Expo. Never throws — logs errors only.
 */
async function sendPush(messages: PushMessage[]): Promise<void> {
  if (messages.length === 0) return;

  try {
    // Send in batches of 100
    for (let i = 0; i < messages.length; i += EXPO_BATCH_SIZE) {
      const batch = messages.slice(i, i + EXPO_BATCH_SIZE);
      const response = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
      });

      if (!response.ok) {
        console.error(`[NOTIFY] Expo push failed: ${response.status} ${await response.text()}`);
      }
    }
  } catch (err: any) {
    console.error(`[NOTIFY] Push send error: ${err.message}`);
  }
}

/**
 * Get push tokens for a user.
 */
async function getPushTokens(ownerType: string, ownerId: string): Promise<string[]> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT push_token FROM devices WHERE owner_type = $1 AND owner_id = $2`,
    [ownerType, ownerId]
  );
  return result.rows.map((r: any) => r.push_token);
}

/**
 * notify() — the single entry point for all notifications.
 * Call AFTER the database transaction commits.
 */
export async function notify(
  recipientType: 'client' | 'staff',
  recipientId: string,
  event: string,
  payload: Record<string, any> = {}
): Promise<void> {
  if (!recipientId) return;

  const tokens = await getPushTokens(recipientType, recipientId);
  if (tokens.length === 0) return;

  const messages: PushMessage[] = [];

  switch (event) {
    case 'wash_started':
      messages.push(...tokens.map((to) => ({
        to,
        title: 'Wash Started',
        body: `Your ${payload.vehicle_class || 'car'} wash (${payload.service_name || 'Full wash'}) is in progress. Quoted: UGX ${payload.amount_ugx || '...'}`,
        data: { event, wash_id: payload.wash_id, branch_name: payload.branch_name },
        sound: 'default',
      })));
      break;

    case 'ready_for_collection':
      messages.push(...tokens.map((to) => ({
        to,
        title: 'Car Ready',
        body: `Your car is ready for collection at ${payload.branch_name || 'the bay'}`,
        data: { event, wash_id: payload.wash_id, job_no: payload.job_no },
        sound: 'default',
      })));
      break;

    case 'paid':
      messages.push(...tokens.map((to) => ({
        to,
        title: 'Payment Confirmed',
        body: `UGX ${payload.amount_ugx || '...'} paid. Receipt: ${payload.receipt_no || 'N/A'}. Washes: ${payload.wash_count ?? '?'}/${payload.washes_required ?? 7}`,
        data: { event, wash_id: payload.wash_id, receipt_no: payload.receipt_no },
        sound: 'default',
      })));
      break;

    case 'reward_earned':
      messages.push(...tokens.map((to) => ({
        to,
        title: '🎉 Free Wash Earned!',
        body: `Your next wash is free! You now have ${payload.free_wash_credits || 1} free wash credit(s).`,
        data: { event, free_wash_credits: payload.free_wash_credits },
        sound: 'default',
      })));
      break;

    case 'job_collected_by':
      messages.push(...tokens.map((to) => ({
        to,
        title: 'Job Collected',
        body: `Your job ${payload.job_no || ''} was collected by ${payload.collected_by_name || 'another worker'}. Amount: UGX ${payload.amount_ugx || '...'}`,
        data: { event, wash_id: payload.wash_id },
        sound: 'default',
      })));
      break;

    case 'wash_reversed':
      messages.push(...tokens.map((to) => ({
        to,
        title: 'Wash Reversed',
        body: `A wash has been reversed. Reason: ${payload.reason || 'See manager'}`,
        data: { event, wash_id: payload.wash_id },
        sound: 'default',
      })));
      break;

    default:
      console.log(`[NOTIFY] Unknown event: ${event}`);
      return;
  }

  console.log(`[NOTIFY] Sending ${messages.length} push(es) for ${recipientType}:${recipientId} event=${event}`);
  await sendPush(messages);
}
