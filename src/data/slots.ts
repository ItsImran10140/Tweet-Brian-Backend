import { db, type Row } from './db';

export async function getSlotsForUser(userId: string): Promise<Row[]> {
  const user = await db.get('users', (u) => u.id === userId);
  return Array.isArray(user?.posting_slots) ? user!.posting_slots : [];
}

export async function setSlotsForUser(userId: string, slots: Row[]): Promise<Row[]> {
  await db.update('users', (u) => u.id === userId, { posting_slots: slots });
  return getSlotsForUser(userId);
}
